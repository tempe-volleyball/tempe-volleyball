// WordPress pages and posts -> pages, posts; the menu; and the redirect map from old URLs.

import sanitizeHtml from 'sanitize-html'
import type { LeagueCode } from '../../src/server/db/schema/enums'
import { EMBED_HOSTS, safeEmbedSrc } from '../../src/lib/content/render'
import { rewriteUploads, type ResolvedMedia } from '../../src/lib/wp-import/html'
import {
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
} from '../../src/lib/wp-import/routes'
import type { SqlValue } from '../../src/lib/wp-import/sql'
import { describeHtml } from '../../src/lib/content'
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

/** Same-site absolute links become root-relative so they work on every environment. */
const relativiseLinks = (html: string) =>
  html.replace(/(href|src)="https?:\/\/(?:www\.)?tempevb\.com(\/[^"]*)?"/gi, (_, attr: string, p?: string) => `${attr}="${p ?? '/'}"`)

/** Old internal links pointing at pages that became routes or redirects are left for the redirect map to handle. */
export function cleanBody(html: string, resolve: (url: string) => ResolvedMedia | null) {
  const safe = sanitizeHtml(html, SANITIZE)
    .replace(/<p[^>]*>\s*<\/p>/g, '')
    .trim()
  const r = rewriteUploads(safe, resolve)
  return { ...r, html: relativiseLinks(r.html) }
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
    add(c.link, code ? leagueFixturesRoute(leagueSlug(code)) : LEAGUES_ROUTE, 'calendar')
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

  const redirectRows: Row[] = [...redirects].map(([from, r]) => {
    report.redirects[r.kind] = (report.redirects[r.kind] ?? 0) + 1
    return { id: stableId('redirect', from), from_path: from, to_path: r.to, status: 301, source: 'wp-import' }
  })

  return { pages, posts, menuItems, redirects: redirectRows, usedMedia, unresolvedUploads, report }
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
  kind: 'page' | 'url' | 'league_ladder' | 'league_fixtures'
  page?: string
  league?: LeagueCode
  url?: string
  children?: MenuNode[]
}

/**
 * The live site's menu (captured 2026-10-17; the WP menu API isn't public). The old "Mixed Leagues" had a third
 * level (League Ladders / League Fixtures); it's flattened to two levels here. Headings without a link are
 * kind 'url' with url null.
 */
export const MENU: MenuNode[] = [
  { label: 'Home', kind: 'page', page: FRONT_PAGE_SLUG },
  { label: 'Junior Dev Program (JDP)', kind: 'page', page: 'junior-development-program-jdp' },
  { label: 'Adult Dev Program (ADP)', kind: 'page', page: 'adult-development-program-adp' },
  {
    label: 'Mixed Leagues',
    kind: 'url',
    children: [
      ...(['TNL', 'FNL', 'SNL', 'SAL'] as const).map((c): MenuNode => ({ label: `${c} Ladder`, kind: 'league_ladder', league: c })),
      ...(['TNL', 'FNL', 'SNL', 'SAL'] as const).map((c): MenuNode => ({
        label: `${c} Fixtures and Results`,
        kind: 'league_fixtures',
        league: c,
      })),
    ],
  },
  {
    label: 'Super League (TVSL)',
    kind: 'page',
    page: 'saturday-night-endorsed-league',
    children: [
      { label: 'Fixtures and Results', kind: 'league_fixtures', league: 'TVSL' },
      { label: 'Ladder', kind: 'league_ladder', league: 'TVSL' },
    ],
  },
  {
    label: 'Enrolment',
    kind: 'url',
    children: [
      { label: 'Juniors & Social Mixed Leagues Enrolment', kind: 'page', page: '2023-enrolment' },
      { label: 'Juniors Development Program (JDP)', kind: 'page', page: 'junior-development-program-jdp-volleyjoeys' },
      { label: 'Scrim & Coached Training Sessions', kind: 'page', page: 'adults-social-training' },
    ],
  },
  {
    label: 'About',
    kind: 'url',
    children: [
      { label: 'About Tempe VB', kind: 'page', page: 'about-tempe-vb' },
      { label: 'Where We Play', kind: 'page', page: 'where-we-play' },
      { label: 'Contact', kind: 'page', page: 'contact' },
      { label: 'Rules', kind: 'page', page: 'rules' },
      { label: 'FAQ', kind: 'page', page: 'faq' },
      { label: 'Login', kind: 'url', url: '/admin' },
    ],
  },
  { label: 'Instagram', kind: 'url', url: 'https://www.instagram.com/tempe.volleyball/' },
]

function buildMenu(pageIdBySlug: Map<string, string>, leagueIdByCode: Map<LeagueCode, string>): Row[] {
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
        url: n.url ?? null,
        sort,
      })
      if (n.children) walk(n.children, id, `${path}/${n.label}`)
    })
  }
  walk(MENU, null, '')
  return rows
}
