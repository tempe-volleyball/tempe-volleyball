import type { LeagueCode } from '../../server/db/schema/enums'

// URL conventions for the new public site, and how old WordPress/SportsPress URLs map onto them. The importer writes
// redirects from these; the public-site routes must serve the same paths.
//
//   /                               home (pages.path '/')
//   /<page-path>                    content pages (pages.path, no trailing slash)
//   /leagues                        league index
//   /leagues/<league-slug>          current season of a league: fixtures (#fixtures) and ladder (#ladder)
//   /leagues/<league-slug>/<season-slug>   one season (archive), e.g. /leagues/tnl/tnl-q4-2026
//   /news, /news/<post-slug>        news posts
//   /media/<media-id>/<width>.webp  resized images; /media/<media-id>/original.<ext> the original file

export const LEAGUES_ROUTE = '/leagues'
export const NEWS_ROUTE = '/news'
export const leagueRoute = (leagueSlug: string) => `/leagues/${leagueSlug}`
export const leagueLadderRoute = (leagueSlug: string) => `${leagueRoute(leagueSlug)}#ladder`
export const leagueFixturesRoute = (leagueSlug: string) => `${leagueRoute(leagueSlug)}#fixtures`
export const seasonRoute = (leagueSlug: string, seasonSlug: string) => `/leagues/${leagueSlug}/${seasonSlug}`
export const postRoute = (slug: string) => `${NEWS_ROUTE}/${slug}`
export const mediaVariantUrl = (mediaId: string, width: number) => `/media/${mediaId}/${width}.webp`
export const mediaOriginalUrl = (mediaId: string, ext: string) => `/media/${mediaId}/original.${ext}`

/** The league slug for a code: lower case, "tnl". */
export const leagueSlug = (code: LeagueCode) => code.toLowerCase()

/**
 * A path as stored in redirects.from_path and pages.path: leading slash, no host, query, fragment or trailing slash
 * ("/" stays "/"). The public site should normalise request paths the same way before looking them up.
 */
export function normalisePath(urlOrPath: string): string {
  let p = urlOrPath.trim()
  try {
    if (/^[a-z]+:\/\//i.test(p)) p = new URL(p).pathname
  } catch {
    // keep as is
  }
  p = p.replace(/[?#].*$/, '')
  if (!p.startsWith('/')) p = `/${p}`
  p = p.replace(/\/{2,}/g, '/')
  if (p.length > 1) p = p.replace(/\/+$/, '')
  return p
}

/** SportsPress league/season prefixes: "SSL" is what the old site called the Super League (TVSL). */
const CODE_ALIASES: Record<string, LeagueCode> = { TNL: 'TNL', FNL: 'FNL', SNL: 'SNL', SAL: 'SAL', SSL: 'TVSL', TVSL: 'TVSL' }

/** "TNL Q4 2026" -> { code: 'TNL', quarter: 4, year: 2026 }; "SSL Q3 2026" -> TVSL. null if it isn't one. */
export function parseSeasonName(name: string): { code: LeagueCode; quarter: number; year: number } | null {
  const m = /^\s*([a-z]+)\s+q([1-4])\s+(\d{4})\s*$/i.exec(name)
  const code = m && CODE_ALIASES[m[1]!.toUpperCase()]
  if (!m || !code) return null
  return { code, quarter: Number(m[2]), year: Number(m[3]) }
}

/** Season display name and slug: "TVSL Q3 2026", "tvsl-q3-2026". */
export const seasonName = (code: LeagueCode, quarter: number, year: number) => `${code} Q${quarter} ${year}`
export const seasonSlug = (code: LeagueCode, quarter: number, year: number) => `${code.toLowerCase()}-q${quarter}-${year}`

/**
 * Old WordPress pages that only wrapped SportsPress tables or calendars. They become league routes, not pages.
 * `null` = a league that no longer runs (2021–22 Monday, B League …): sent to the league index.
 */
export const LEAGUE_DATA_PAGES: Record<string, { code: LeagueCode; view: 'ladder' | 'fixtures' } | null> = {
  ladders: { code: 'TNL', view: 'ladder' },
  fixtures: { code: 'TNL', view: 'fixtures' },
  'a-league-fixtures': { code: 'TNL', view: 'fixtures' },
  results: { code: 'TNL', view: 'fixtures' },
  'a-league-results': { code: 'TNL', view: 'fixtures' },
  'fnl-ladder': { code: 'FNL', view: 'ladder' },
  'fnl-fixtures-and-results': { code: 'FNL', view: 'fixtures' },
  'saturday-night-league-standings': { code: 'SNL', view: 'ladder' },
  'snl-fixtures-and-results': { code: 'SNL', view: 'fixtures' },
  'sunday-pm-league-ladder': { code: 'SAL', view: 'ladder' },
  'sunday-pm-league-fixtures-and-results': { code: 'SAL', view: 'fixtures' },
  sal: { code: 'SAL', view: 'fixtures' },
  'sunday-super-league-week-1-of-6': { code: 'TVSL', view: 'ladder' },
  'sunday-super-league-fixtures-and-results': { code: 'TVSL', view: 'fixtures' },
  'this-weeks-fixtures': null,
  'b-league-fixtures': null,
  'b-league-results': null,
  'mnl-ladder': null,
  'mnl-fixtures-and-results': null,
  'monday-ladders': null,
  'monday-results': null,
  'monday-gold-results': null,
  'monday-blue-results': null,
  'monday-blue-fixtures': null,
  'monday-gold-fixtures': null,
}

/** WordPress pages that are replaced by a route rather than imported: the blog index and the "NEWS" list. */
export const ROUTE_PAGES: Record<string, string> = { blog: NEWS_ROUTE, news: NEWS_ROUTE }

/** Where an old league-data page should go. */
export function leagueDataPageTarget(slug: string): string | null {
  if (!(slug in LEAGUE_DATA_PAGES)) return null
  const t = LEAGUE_DATA_PAGES[slug]
  if (!t) return LEAGUES_ROUTE
  const ls = leagueSlug(t.code)
  return t.view === 'ladder' ? leagueLadderRoute(ls) : leagueFixturesRoute(ls)
}

/** The news RSS feed (src/pages/news/rss.xml.ts). */
export const NEWS_FEED_ROUTE = `${NEWS_ROUTE}/rss.xml`

/**
 * WordPress's own URLs that aren't pages or posts: the RSS feeds (the main feed goes to the new one; there are no
 * comments any more) and the date archives (/2023, /2023/12) for every year and month with a post, which go to the
 * news index. `postDates` are the posts' dates, "YYYY-MM-DD…" in Sydney time as WordPress gives them.
 */
export function wordpressRedirects(postDates: readonly string[]): [from: string, to: string][] {
  const out: [string, string][] = [
    ['/feed', NEWS_FEED_ROUTE],
    ['/category/news/feed', NEWS_FEED_ROUTE],
    ['/comments/feed', NEWS_ROUTE],
  ]
  const archives = new Set<string>()
  for (const d of postDates) {
    const m = /^(\d{4})-(\d{2})/.exec(d)
    if (m) archives.add(`/${m[1]}`).add(`/${m[1]}/${m[2]}`)
  }
  for (const a of [...archives].toSorted()) out.push([a, NEWS_ROUTE])
  return out
}

/** The new path of an imported WordPress page: "/" for the front page, otherwise "/<slug>". */
export const pagePath = (slug: string, isFront: boolean) => (isFront ? '/' : normalisePath(`/${slug}`))
