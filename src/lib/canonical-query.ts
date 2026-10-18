import { FIXTURE_LIST_ROUTE, fixtureQueryString, parseFixtureQuery } from './fixture-lists'

// Query strings on public pages (docs/admin.md §3.14 "Query strings"). Cloudflare's edge cache keys on the whole URL,
// so `/?x=<random>` would miss the cache every time and make the Worker read D1 on every request. The middleware
// 301s any public GET whose query string isn't already canonical to the canonical one:
//  - each route lists the parameters it reads (ROUTE_QUERIES); everything else is dropped, and what's kept is
//    written in a fixed order with defaults and junk removed, so one view has exactly one URL;
//  - campaign-tracking parameters (TRACKING_PARAMS: utm_*, gclid …) are kept, after the route's own, so GA4 still
//    sees them on the landing page. Their values can still vary, which is why loadSite() is memoised per isolate.
// Pure, so the middleware, the fixture list's own canonical redirect and the tests all agree.

/** Campaign-tracking parameters kept on any public page (in this order), so analytics attribution survives. */
export const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
] as const

/** A tracking value longer than this is dropped (real ones are short; a long one is junk or an attack). */
export const MAX_TRACKING_VALUE = 200

/** Path prefixes the normaliser leaves alone: APIs, the admin, media files and build assets read their own queries. */
const EXEMPT = ['/api', '/admin', '/media', '/_astro', '/_image', '/_server-islands', '/cdn-cgi'] as const

/** Each public route that reads query parameters: its canonical query string ('' or '?…') from the request's. */
const ROUTE_QUERIES: Record<string, (params: URLSearchParams) => string> = {
  [FIXTURE_LIST_ROUTE]: (p) => fixtureQueryString(parseFixtureQuery(p)),
}

/** Whether the normaliser applies to this path at all. */
export const normalisesQuery = (pathname: string) => !EXEMPT.some((p) => pathname === p || pathname.startsWith(`${p}/`))

/** The tracking parameters of a query, canonical: first non-empty value of each, in TRACKING_PARAMS order. '' or 'a=b&…'. */
export function trackingQuery(params: URLSearchParams): string {
  const out = new URLSearchParams()
  for (const k of TRACKING_PARAMS) {
    const v = params.get(k)?.trim()
    if (v && v.length <= MAX_TRACKING_VALUE) out.set(k, v)
  }
  return out.toString()
}

/** Appends a canonical tracking query ('a=b&…') to a route's query string ('' or '?…'). */
export const withTracking = (search: string, tracking: string) => (tracking ? `${search ? `${search}&` : '?'}${tracking}` : search)

/** The canonical query string for a public path: the route's own parameters, then the tracking ones. '' or '?…'. */
export function canonicalSearch(pathname: string, params: URLSearchParams): string {
  const own = ROUTE_QUERIES[pathname]?.(params) ?? ''
  return withTracking(own, trackingQuery(params))
}

/**
 * Where a public GET should be redirected so its query string is canonical, or null when it already is (or the path
 * is exempt). `search` is URL.search ('' or '?…').
 */
export function queryRedirect(pathname: string, search: string): string | null {
  if (!search || !normalisesQuery(pathname)) return null
  const canonical = canonicalSearch(pathname, new URLSearchParams(search))
  if (canonical === search) return null
  // Defence in depth: Astro collapses "//" in the path today, but a Location starting "//" or "/\" would be a
  // protocol-relative redirect to another site. Such a path is sent to its single-slash form on this site instead.
  const safe = /^\/[/\\]/.test(pathname) ? `/${pathname.replace(/^[/\\]+/, '')}` : pathname
  return `${safe}${canonical}`
}
