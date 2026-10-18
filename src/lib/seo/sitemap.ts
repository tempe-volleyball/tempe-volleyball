import { isIntroPagePath } from '../content/paths'
import { categoryPath, PROGRAMME_PATH_PREFIX, programmePath } from '../programmes'
import { FIXTURE_LIST_ROUTE } from '../fixture-lists'
import { ENROL_ROUTE, LEAGUES_ROUTE, NEWS_ROUTE, postRoute, seasonRoute } from '../wp-import/routes'
import type { ProgrammeKind, ProgrammeStatus } from '../../server/db/schema/enums'

// sitemap.xml (docs/public-site.md "Sitemap"): every real, indexable page and nothing else. Pure: the route loads
// the rows (src/server/sitemap.ts, one batch) and these functions decide what's listed and write the XML.
//
// Listed: the home page; published content pages (not hidden from search); categories that aren't drafts; active
// programmes, and retired ones with history (their page stays up with the archive); the kind index pages that
// list something; /enrol, /leagues, /leagues/fixtures and /news; published news posts (not hidden); and every
// public season page except each league's current one, whose canonical URL is the league page.

/** The sitemaps protocol's limit per file (also 50 MB); past it /sitemap.xml becomes an index of /sitemap-<n>.xml. */
export const SITEMAP_LIMIT = 50_000

export type SitemapEntry = { path: string; lastmod?: string | null | undefined }

export type SitemapRows = {
  pages: { path: string; template: string; updatedAt: string; noindex: boolean }[]
  categories: { slug: string; status: string; updatedAt: string }[]
  programmes: {
    id: string
    kind: ProgrammeKind
    slug: string
    status: ProgrammeStatus
    updatedAt: string
    /** Retired programmes stay listed only with something to show: a public season, or past dates. */
    hasHistory: boolean
  }[]
  seasons: {
    id: string
    leagueId: string
    slug: string
    status: string
    year: number
    quarter: number
    updatedAt: string
    resultsPublishedAt: string | null
  }[]
  posts: { slug: string; updatedAt: string; publishedAt: string | null; noindex: boolean }[]
}

const newest = (...dates: (string | null | undefined)[]) =>
  dates.filter((d): d is string => !!d).reduce<string | null>((a, b) => (a && a > b ? a : b), null)

/** Which programmes keep a public page: not drafts; retired ones only with history. */
const listedProgramme = (p: SitemapRows['programmes'][number]) => p.status === 'active' || (p.status === 'retired' && p.hasHistory)

/** The current season of each league (newest published, else newest archived), as the public site picks it. */
function currentSeasonIds(seasons: SitemapRows['seasons']): Set<string> {
  const byLeague = new Map<string, SitemapRows['seasons']>()
  for (const s of seasons) byLeague.set(s.leagueId, [...(byLeague.get(s.leagueId) ?? []), s])
  const out = new Set<string>()
  for (const list of byLeague.values()) {
    const sorted = list.toSorted((a, b) => b.year - a.year || b.quarter - a.quarter)
    const current = sorted.find((s) => s.status === 'published') ?? sorted.find((s) => s.status === 'archived')
    if (current) out.add(current.id)
  }
  return out
}

/** The URLs to list, in a stable order, each path once. */
export function sitemapEntries(rows: SitemapRows): SitemapEntry[] {
  const out = new Map<string, SitemapEntry>()
  const add = (path: string, lastmod?: string | null) => {
    const prev = out.get(path)
    out.set(path, { path, lastmod: newest(prev?.lastmod, lastmod) })
  }
  const hidden = new Set(rows.pages.filter((p) => p.noindex).map((p) => p.path))
  const pageAt = new Map(rows.pages.map((p) => [p.path, p]))

  add('/', pageAt.get('/')?.updatedAt)
  for (const p of rows.pages) {
    // The home template elsewhere 301s to /; intro pages (/enrol, /training …) are listed with their route below.
    if (p.noindex || p.path === '/' || p.template === 'home' || isIntroPagePath(p.path)) continue
    add(p.path, p.updatedAt)
  }

  for (const c of rows.categories) if (c.status !== 'draft') add(categoryPath(c.slug), c.updatedAt)

  const programmes = rows.programmes.filter(listedProgramme)
  const leagueSlug = new Map(programmes.filter((p) => p.kind === 'league').map((p) => [p.id, p.slug]))
  // A league page shows its current season, so it changes whenever a season is saved or results are published.
  const seasonLastmod = new Map<string, string | null>()
  for (const s of rows.seasons)
    if (s.status !== 'draft') seasonLastmod.set(s.leagueId, newest(seasonLastmod.get(s.leagueId), s.updatedAt, s.resultsPublishedAt))
  const kindLastmod = new Map<ProgrammeKind, string | null>()
  for (const p of programmes) {
    const lastmod = newest(p.updatedAt, seasonLastmod.get(p.id))
    add(programmePath(p.kind, p.slug), lastmod)
    if (p.status === 'active') kindLastmod.set(p.kind, newest(kindLastmod.get(p.kind), lastmod))
  }

  // Kind index pages: /leagues always; the others while they list a programme or have an intro page.
  add(LEAGUES_ROUTE, kindLastmod.get('league'))
  if (kindLastmod.has('league')) add(FIXTURE_LIST_ROUTE, kindLastmod.get('league'))
  for (const kind of ['training', 'development', 'event'] as const) {
    const path = PROGRAMME_PATH_PREFIX[kind]
    const intro = pageAt.get(path)
    if (kindLastmod.has(kind) || (intro && !intro.noindex)) add(path, newest(kindLastmod.get(kind), intro?.updatedAt))
  }
  if (!hidden.has(ENROL_ROUTE)) add(ENROL_ROUTE, pageAt.get(ENROL_ROUTE)?.updatedAt)

  const current = currentSeasonIds(rows.seasons.filter((s) => s.status !== 'draft'))
  for (const s of rows.seasons) {
    const league = leagueSlug.get(s.leagueId)
    if (!league || s.status === 'draft' || current.has(s.id)) continue
    add(seasonRoute(league, s.slug), newest(s.updatedAt, s.resultsPublishedAt))
  }

  const posts = rows.posts.filter((p) => !p.noindex)
  add(NEWS_ROUTE, newest(...posts.map((p) => p.updatedAt)))
  for (const p of posts) add(postRoute(p.slug), newest(p.updatedAt, p.publishedAt))

  return [...out.values()]
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

const loc = (origin: string, path: string) => xmlEscape(new URL(path, origin).href)

/** A W3C datetime (what <lastmod> takes) from a stored UTC ISO instant; null for anything unreadable. */
const w3c = (iso: string | null | undefined) => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** A <urlset>. */
export function urlsetXml(origin: string, entries: SitemapEntry[]): string {
  const urls = entries.map((e) => {
    const lastmod = w3c(e.lastmod)
    return `<url><loc>${loc(origin, e.path)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`
}

/** The path of the n-th (1-based) part when the sitemap is split. */
export const sitemapPartPath = (n: number) => `/sitemap-${n}.xml`

/** How many parts `count` entries need. */
export const sitemapParts = (count: number, limit = SITEMAP_LIMIT) => Math.max(1, Math.ceil(count / limit))

/** The entries of part n (1-based). */
export const sitemapPart = (entries: SitemapEntry[], n: number, limit = SITEMAP_LIMIT) => entries.slice((n - 1) * limit, n * limit)

/** A <sitemapindex> of the parts, each with its newest lastmod. */
export function sitemapIndexXml(origin: string, entries: SitemapEntry[], limit = SITEMAP_LIMIT): string {
  const parts = Array.from({ length: sitemapParts(entries.length, limit) }, (_, i) => {
    const lastmod = w3c(newest(...sitemapPart(entries, i + 1, limit).map((e) => e.lastmod)))
    return `<sitemap><loc>${loc(origin, sitemapPartPath(i + 1))}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</sitemap>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${parts.join('\n')}\n</sitemapindex>\n`
}

/** robots.txt: production www allows everything but the admin and API, and names the sitemap; elsewhere Disallow all. */
export function robotsTxt(indexable: boolean, origin: string): string {
  if (!indexable) return 'User-agent: *\nDisallow: /\n'
  return `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${new URL('/sitemap.xml', origin).href}\n`
}
