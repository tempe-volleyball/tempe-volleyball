import type { APIContext } from 'astro'
import { defineMiddleware } from 'astro:middleware'
import { env } from 'cloudflare:workers'
import { canonicalSearch, normalisesQuery, queryRedirect } from './lib/canonical-query'
import { trailingSlashTarget } from './lib/content/paths'
import { isIndexable } from './lib/indexing'
import { guard, isAdminApi, isAdminPage, isInviteApi, needsSession } from './server/auth/guard'
import { cachePublic, tags } from './server/cache'
import { followRedirect, publicDb, siteMemo } from './server/public'
import { getServices } from './server/services'
import { bumpSiteVersion, slashRedirect } from './server/site'

// 0. Public paths with a trailing slash (every old WordPress URL) get a 301 to the slashless path, or straight to
//    the redirects table's target for it (see src/lib/content/paths.ts trailingSlashTarget for what's exempt).
//    The query string comes along canonical (below), so this is the only hop.
// 1. Public GETs whose query string isn't canonical (parameters the page doesn't read, a different order, defaults)
//    get a 301 to the canonical URL (src/lib/canonical-query.ts), costing no D1 at all: a random `?x=` would
//    otherwise miss the edge cache and render from D1 on every request. Campaign-tracking parameters are kept.
// 2. Admin guard for /admin/* and /api/admin/* (plus same-origin checks on /api/invites/*): looks up the session
//    (from the signed cookie cache, usually without touching D1) into Astro.locals.user/session, then redirects,
//    401s or 403s as src/server/auth/guard.ts decides. Public pages skip the lookup entirely. A successful admin
//    write bumps the site version, so every isolate's memoised loadSite() (src/server/site.ts) reloads.
// 3. Only production on www.tempevb.com may be indexed (not staging, previews, or *.workers.dev).
export const onRequest = defineMiddleware(async (context, next) => {
  const { url, request } = context
  context.locals.user = null
  context.locals.session = null
  const read = request.method === 'GET' || request.method === 'HEAD'

  const slashless = read ? trailingSlashTarget(url.pathname) : null
  if (slashless) {
    const redirect = await redirectTrailingSlash(context, slashless)
    return publicResponse(new Response(null, { status: redirect.status, headers: redirect.headers }), url)
  }
  const canonical = read ? queryRedirect(url.pathname, url.search) : null
  if (canonical) return publicResponse(new Response(null, { status: 301, headers: { Location: canonical } }), url)

  const admin = isAdminPage(url.pathname) || isAdminApi(url.pathname) || isInviteApi(url.pathname)
  // Cookies Better Auth wants to refresh (the 5-minute cache cookie, the session's expiry) go on whatever we answer.
  let setCookies: string[] = []
  if (admin) {
    if (needsSession(url.pathname)) {
      const { headers, response: result } = await getServices().auth.api.getSession({ headers: request.headers, returnHeaders: true })
      setCookies = headers?.getSetCookie() ?? []
      context.locals.user = result?.user ?? null
      context.locals.session = result?.session ?? null
    }
    const decision = guard(
      {
        pathname: url.pathname,
        search: url.search,
        method: request.method,
        origin: request.headers.get('origin'),
        secFetchSite: request.headers.get('sec-fetch-site'),
        allowedOrigins: [url.origin, new URL(env.SITE_URL).origin],
      },
      context.locals.user,
    )
    if (decision.action === 'redirect')
      return adminResponse(new Response(null, { status: 302, headers: { Location: decision.to } }), setCookies)
    if (decision.action === 'json') return adminResponse(Response.json({ error: decision.error }, { status: decision.status }), setCookies)
  }

  const response = await next()
  if (admin) {
    if (isAdminApi(url.pathname) && !read && request.method !== 'OPTIONS' && response.status < 400) await bumpVersion()
    return adminResponse(response, setCookies)
  }
  return publicResponse(response, url)
})

/** Public responses outside production's www are never indexed. */
function publicResponse(response: Response, url: URL) {
  if (!isIndexable(url, env.SITE_ENV)) response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  return response
}

/**
 * After an admin write: a new site version, so memoised Site copies in every isolate reload on their next request
 * (this one's is dropped at once). Any write, not just content: it's one tiny upsert, and a missed bump would only
 * cost SITE_MEMO_MS of staleness. A failure is logged, never fails the save.
 */
async function bumpVersion() {
  siteMemo.clear()
  try {
    await bumpSiteVersion(publicDb())
  } catch (e) {
    console.error('site version bump failed', e instanceof Error ? e.message : String(e))
  }
}

/**
 * "/contact/" -> 301 "/contact" (query kept). An old URL in the redirects table goes straight to its target instead,
 * so "/ladders/" is one hop to "/leagues/tnl#ladder", not two.
 */
async function redirectTrailingSlash(context: APIContext, slashless: string): Promise<Response> {
  const db = publicDb()
  let path = slashless
  try {
    path = decodeURIComponent(slashless)
  } catch {
    // malformed escapes: look it up as is
  }
  const r = await slashRedirect(db, path)
  if (r) return followRedirect(context, db, path, r)
  cachePublic(context.cache, tags.page(path))
  const search = normalisesQuery(slashless) ? canonicalSearch(slashless, context.url.searchParams) : context.url.search
  return new Response(null, { status: 301, headers: { Location: slashless + search } })
}

/** Admin responses are never cached or indexed. */
function adminResponse(response: Response, setCookies: string[]) {
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  for (const c of setCookies) response.headers.append('Set-Cookie', c)
  return response
}
