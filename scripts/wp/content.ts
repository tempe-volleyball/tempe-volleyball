// WordPress pages and posts -> pages, posts; the menu; and the redirect map from old URLs.

import sanitizeHtml from 'sanitize-html'
import type { LeagueCode } from '../../src/server/db/schema/enums'
import { EMBED_HOSTS, safeEmbedSrc } from '../../src/lib/content/render'
import { rewriteUploads, type ResolvedMedia } from '../../src/lib/wp-import/html'
import {
  INTEREST_REDIRECTS,
  INTEREST_ROUTE,
  LEAGUES_ROUTE,
  NEWS_ROUTE,
  ROUTE_PAGES,
  leagueDataPageTarget,
  leagueFixturesRoute,
  leagueLadderRoute,
  leagueRoute,
  leagueSlug,
  normalisePath,
  pagePath,
  postRoute,
  seasonRoute,
  wordpressRedirects,
  calendarFallback,
  stripTrailingSlashes,
} from '../../src/lib/wp-import/routes'
import { sqlLiteral, type SqlValue } from '../../src/lib/wp-import/sql'
import { describeHtml, tidyInternalLinks } from '../../src/lib/content'
import { decodeEntities, isAutoExcerpt } from '../../src/lib/wp-import/text'
import type { Competition } from './competition'
import { stableId } from './ids'
import type { WpData, WpPage } from './types'

type Row = Record<string, SqlValue>

export const FRONT_PAGE_SLUG = 'home-page'

/** Pages to import as content (everything except league-data pages and pages replaced by routes). */
export const contentPages = (pages: WpPage[]) =>
  pages.filter((p) => p.status === 'publish' && leagueDataPageTarget(p.slug) === null && !(p.slug in ROUTE_PAGES))

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'figure', 'figcaption', 'iframe', 'h1', 'h2', 'video', 'source', 'span'],
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel', 'title'],
    img: ['src', 'srcset', 'sizes', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
    iframe: ['src', 'width', 'height', 'title', 'allow', 'allowfullscreen', 'loading'],
    video: ['src', 'controls', 'poster', 'width', 'height'],
    source: ['src', 'type'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan', 'scope'],
    '*': ['class', 'id', 'style'],
  },
  allowedStyles: { '*': { 'text-align': [/^(left|right|center|justify)$/] } },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // Iframes keep their src only if the public renderer would accept it too (EMBED_HOSTS, Google hosts for Maps only).
  allowedIframeHostnames: [...EMBED_HOSTS],
  transformTags: {
    iframe: (tagName, attribs) => {
      const src = safeEmbedSrc(attribs.src)
      const { src: _drop, ...rest } = attribs
      return { tagName, attribs: src ? { ...rest, src } : rest }
    },
  },
  // An iframe without an allowed src is an empty box (and its fallback text, "Loading…", isn't content).
  exclusiveFilter: (frame) => frame.tag === 'iframe' && !frame.attribs.src,
}

/**
 * Same-site absolute links become root-relative so they work on every environment, without WordPress's trailing
 * slash (each would cost a 301).
 */
const relativiseLinks = (html: string) =>
  stripTrailingSlashes(
    html.replace(/(href|src)="https?:\/\/(?:www\.)?tempevb\.com(\/[^"]*)?"/gi, (_, attr: string, p?: string) => `${attr}="${p ?? '/'}"`),
  )

/** Old internal links pointing at pages that became routes or redirects are left for the redirect map to handle. */
export function cleanBody(html: string, resolve: (url: string) => ResolvedMedia | null) {
  const safe = sanitizeHtml(html, SANITIZE)
    .replace(/<p[^>]*>\s*<\/p>/g, '')
    .trim()
  const r = rewriteUploads(safe, resolve)
  return { ...r, html: tidyInternalLinks(relativiseLinks(r.html)) }
}

/**
 * A typed excerpt, or else the content's text. WordPress's automatic excerpts strip tags with no space between blocks
 * ("Contactm.mouhajer@…"), so those are rebuilt from the content, block-aware (describeHtml()).
 */
export const metaDescription = (p: WpPage) => {
  const excerpt = p.excerpt?.rendered ?? ''
  return describeHtml(isAutoExcerpt(excerpt, p.content.rendered) ? p.content.rendered : excerpt.replace(/\[(?:&hellip;|…)\]/g, ''))
}

const iso = (gmt: string) => `${gmt}${gmt.includes('.') ? '' : '.000'}Z`

export type Content = {
  pages: Row[]
  posts: Row[]
  menuItems: Row[]
  redirects: Row[]
  usedMedia: Set<string>
  unresolvedUploads: Set<string>
  report: { pages: number; posts: number; leaguePages: string[]; oversizeBodies: string[]; redirects: Record<string, number> }
}

export function buildContent(
  data: WpData,
  comp: Competition,
  resolveMedia: (url: string) => ResolvedMedia | null,
  mediaIdByWp: Map<number, string>,
): Content {
  const usedMedia = new Set<string>()
  const unresolvedUploads = new Set<string>()
  const report: Content['report'] = { pages: 0, posts: 0, leaguePages: [], oversizeBodies: [], redirects: {} }

  const body = (html: string, where: string) => {
    const r = cleanBody(html, resolveMedia)
    for (const id of r.used) usedMedia.add(id)
    for (const u of r.unresolved) unresolvedUploads.add(u)
    if (r.html.length > 200_000) report.oversizeBodies.push(`${where}: ${Math.round(r.html.length / 1000)} KB`)
    return { blocks: [], html: r.html }
  }

  // Pages
  const pageIdBySlug = new Map<string, string>()
  const pagePaths = new Set<string>()
  const pages: Row[] = []
  for (const p of contentPages(data.pages)) {
    const id = stableId('page', p.id)
    const front = p.slug === FRONT_PAGE_SLUG
    const path = pagePath(p.slug, front)
    pageIdBySlug.set(p.slug, id)
    pagePaths.add(path)
    pages.push({
      id,
      path,
      title: decodeEntities(p.title.rendered).replace(/\s+/g, ' ').trim(),
      meta_description: metaDescription(p),
      og_image_id: p.featured_media ? (mediaIdByWp.get(p.featured_media) ?? null) : null,
      template: front ? 'home' : p.slug === 'contact' ? 'contact' : 'content',
      body: body(p.content.rendered, p.slug),
      status: 'published',
      published_at: iso(p.date_gmt),
      wp_id: p.id,
    })
  }
  report.pages = pages.length

  // Posts
  const categoryName = new Map(data.categories.map((c) => [c.id, decodeEntities(c.name)]))
  const posts: Row[] = data.posts
    .filter((p) => p.status === 'publish')
    .map((p) => ({
      id: stableId('post', p.id),
      slug: p.slug,
      title: decodeEntities(p.title.rendered).replace(/\s+/g, ' ').trim(),
      excerpt: metaDescription(p),
      body: body(p.content.rendered, `post ${p.slug}`),
      cover_media_id: p.featured_media ? (mediaIdByWp.get(p.featured_media) ?? null) : null,
      category: p.categories.map((c) => categoryName.get(c)).find((n): n is string => !!n && !/^uncategori[sz]ed$/i.test(n)) ?? null,
      status: 'published',
      published_at: iso(p.date_gmt),
      wp_id: p.id,
    }))
  report.posts = posts.length

  const menuItems = buildMenu(pageIdBySlug, comp.leagueIdByCode)

  // Redirects
  const redirects = new Map<string, { to: string; kind: string }>()
  const add = (from: string, to: string, kind: string) => {
    const f = normalisePath(from)
    if (f === normalisePath(to) || pagePaths.has(f) || redirects.has(f)) return
    redirects.set(f, { to, kind })
  }
  add(`/${FRONT_PAGE_SLUG}`, '/', 'page')
  for (const p of data.pages) {
    const target = leagueDataPageTarget(p.slug)
    if (target) {
      report.leaguePages.push(`/${p.slug} -> ${target}`)
      add(p.link, target, 'league-page')
    } else if (p.slug in ROUTE_PAGES) {
      add(p.link, ROUTE_PAGES[p.slug]!, 'page')
    }
  }
  for (const p of data.posts) add(p.link, postRoute(p.slug), 'post')

  const seasonPath = (seasonWp: number | undefined) => {
    const s = seasonWp !== undefined ? comp.seasonsByWp.get(seasonWp) : undefined
    return s ? seasonRoute(s.leagueSlug, s.slug) : null
  }
  const leagueOf = (leagueWps: number[], seasonWps: number[]): LeagueCode | null => {
    for (const l of leagueWps) {
      const c = comp.leagueCodeByWp.get(l)
      if (c) return c
    }
    for (const s of seasonWps) {
      const info = comp.seasonsByWp.get(s)
      if (info) return info.code
    }
    return null
  }

  for (const e of data.events) add(e.link, seasonPath(e.seasons[0]) ?? LEAGUES_ROUTE, 'event')
  for (const t of data.teams) {
    const s = comp.teamLastSeason.get(t.id)
    add(t.link, s ? seasonRoute(s.leagueSlug, s.slug) : LEAGUES_ROUTE, 'team')
  }
  for (const t of data.tables) {
    const code = leagueOf(t.leagues, t.seasons)
    add(t.link, code ? leagueLadderRoute(leagueSlug(code)) : LEAGUES_ROUTE, 'table')
  }
  for (const c of data.calendars) {
    const code = leagueOf(c.leagues, c.seasons)
    add(c.link, code ? leagueFixturesRoute(leagueSlug(code)) : calendarFallback(c.slug), 'calendar')
  }
  // SportsPress taxonomy archives.
  for (const s of data.seasons) add(`/season/${s.slug}`, seasonPath(s.id) ?? LEAGUES_ROUTE, 'taxonomy')
  for (const l of data.leagues) {
    const code = comp.leagueCodeByWp.get(l.id)
    add(`/league/${l.slug}`, code ? leagueRoute(leagueSlug(code)) : LEAGUES_ROUTE, 'taxonomy')
  }
  for (const v of data.venues) add(`/venue/${v.slug}`, '/where-we-play', 'taxonomy')
  // WordPress itself.
  add('/wp-admin', '/admin', 'wordpress')
  add('/wp-login.php', '/admin', 'wordpress')
  add('/category/news', NEWS_ROUTE, 'wordpress')
  for (const [from, to] of wordpressRedirects(data.posts.filter((p) => p.status === 'publish').map((p) => p.date)))
    add(from, to, 'wordpress')

  // Links in bodies to old URLs that now redirect point straight at the target (no 301 hop for visitors or crawlers).
  const retarget = (path: string) => redirects.get(path)?.to
  for (const row of [...pages, ...posts]) {
    const b = row.body as { blocks: unknown[]; html: string }
    row.body = { ...b, html: tidyInternalLinks(b.html, retarget) }
  }

  const redirectRows: Row[] = [...redirects].map(([from, r]) => {
    report.redirects[r.kind] = (report.redirects[r.kind] ?? 0) + 1
    return { id: stableId('redirect', from), from_path: from, to_path: r.to, status: 301, source: 'wp-import' }
  })

  return { pages, posts, menuItems, redirects: redirectRows, usedMedia, unresolvedUploads, report }
}

/**
 * Redirects we decided on rather than derived from WordPress (the old sign-up pages -> /interest). Written with
 * source 'manual' so they behave like ones Michael made: an import only (re)writes a row that is still the
 * importer's, never one that has been edited (see import-wp.ts).
 */
export function manualRedirects(): Row[] {
  return INTEREST_REDIRECTS.map((from) => ({
    id: stableId('redirect', from),
    from_path: from,
    to_path: INTEREST_ROUTE,
    status: 301,
    source: 'manual',
  }))
}

/** Upload URLs of originals -> the new file, for hotlinked images and PDFs. */
export function mediaRedirects(items: { url: string; resolved: ResolvedMedia }[]): Row[] {
  return items.map(({ url, resolved }) => {
    const from = normalisePath(url)
    const to = resolved.variants.length
      ? `/media/${resolved.id}/${Math.max(...resolved.variants)}.webp`
      : `/media/${resolved.id}/original.${resolved.ext}`
    return { id: stableId('redirect', from), from_path: from, to_path: to, status: 301, source: 'wp-import' }
  })
}

type MenuNode = {
  label: string
  kind: 'page' | 'url' | 'category' | 'league_ladder' | 'league_fixtures'
  page?: string
  league?: LeagueCode
  /** categories.id (seeded by migration 0003: cat_mixed_leagues, cat_super_league, cat_juniors, cat_adult_training). */
  category?: string
  url?: string
  /** Children of a category item: before or after its automatic programme links. */
  placement?: 'before' | 'after'
  children?: MenuNode[]
}

/**
 * The menu for the new site (docs/admin.md §3.5): Home · Mixed Leagues · Super League · Juniors · Adult Training ·
 * Enrol · About. Category items fill their dropdowns on their own (landing page, then each active programme); the
 * programme pages that aren't programme records yet (JDP, ADP, training) are pinned under their category until
 * Michael creates them as programmes. Instagram is a header icon and Login is gone (/admin still works).
 *
 * The old site's menu, captured 2026-10-17 (the WP menu API isn't public), was: Home, Junior Dev Program (JDP),
 * Adult Dev Program (ADP), Mixed Leagues (ladder and fixtures links per league), Super League (TVSL), Enrolment,
 * About (… Login) and Instagram. scripts/menu-phase6.ts moves an already-imported menu to this one.
 */
export const MENU: MenuNode[] = [
  { label: 'Home', kind: 'page', page: FRONT_PAGE_SLUG },
  { label: 'Mixed Leagues', kind: 'category', category: 'cat_mixed_leagues' },
  {
    label: 'Super League',
    kind: 'category',
    category: 'cat_super_league',
    children: [{ label: 'About the Super League', kind: 'page', page: 'saturday-night-endorsed-league', placement: 'after' }],
  },
  {
    label: 'Juniors',
    kind: 'category',
    category: 'cat_juniors',
    children: [
      { label: 'Junior Development Program (JDP)', kind: 'page', page: 'junior-development-program-jdp', placement: 'after' },
      { label: 'VolleyJoeys', kind: 'page', page: 'junior-development-program-jdp-volleyjoeys', placement: 'after' },
    ],
  },
  {
    label: 'Adult Training',
    kind: 'category',
    category: 'cat_adult_training',
    children: [
      { label: 'Scrim & Coached Training', kind: 'page', page: 'adults-social-training', placement: 'after' },
      { label: 'Adult Development Program (ADP)', kind: 'page', page: 'adult-development-program-adp', placement: 'after' },
    ],
  },
  { label: 'Enrol', kind: 'page', page: '2023-enrolment' },
  {
    label: 'About',
    kind: 'page',
    page: 'about-tempe-vb',
    children: [
      { label: 'Where We Play', kind: 'page', page: 'where-we-play' },
      { label: 'Contact', kind: 'page', page: 'contact' },
      { label: 'Rules', kind: 'page', page: 'rules' },
      { label: 'FAQ', kind: 'page', page: 'faq' },
    ],
  },
]

/** True while nobody has edited the menu in the admin (every admin save is audited and stamps updated_by). */
export const MENU_UNEDITED_SQL = `NOT EXISTS (SELECT 1 FROM "audit_log" WHERE "action" = 'menu.update') AND NOT EXISTS (SELECT 1 FROM "menu_items" WHERE "updated_by" IS NOT NULL)`

const MENU_COLUMNS = ['id', 'parent_id', 'label', 'kind', 'page_id', 'league_id', 'category_id', 'url', 'placement', 'sort'] as const

/**
 * SQL that replaces the menu with `rows`, but only while it's unedited (MENU_UNEDITED_SQL): an imported menu is
 * replaced whole (so items dropped from MENU don't linger), and a menu Michael has edited is never touched.
 * Parents come before children in `rows`.
 */
export function guardedMenuStatements(rows: Row[]): string[] {
  const cols = MENU_COLUMNS.map((c) => `"${c}"`).join(', ')
  return [
    `DELETE FROM "menu_items" WHERE ${MENU_UNEDITED_SQL};`,
    ...rows.map(
      (r) =>
        `INSERT INTO "menu_items" (${cols}) SELECT ${MENU_COLUMNS.map((c) => sqlLiteral(r[c] ?? null)).join(', ')} WHERE ${MENU_UNEDITED_SQL};`,
    ),
  ]
}

export function buildMenu(pageIdBySlug: Map<string, string>, leagueIdByCode: Map<LeagueCode, string>): Row[] {
  const rows: Row[] = []
  const walk = (nodes: MenuNode[], parent: string | null, path: string) => {
    nodes.forEach((n, sort) => {
      const id = stableId('menu', `${path}/${n.label}`)
      const pageId = n.page ? (pageIdBySlug.get(n.page) ?? null) : null
      if (n.page && !pageId) throw new Error(`Menu item "${n.label}": page ${n.page} wasn't imported`)
      rows.push({
        id,
        parent_id: parent,
        label: n.label,
        kind: n.kind,
        page_id: pageId,
        league_id: n.league ? leagueIdByCode.get(n.league)! : null,
        category_id: n.category ?? null,
        url: n.url ?? null,
        placement: n.placement ?? null,
        sort,
      })
      if (n.children) walk(n.children, id, `${path}/${n.label}`)
    })
  }
  walk(MENU, null, '')
  return rows
}
