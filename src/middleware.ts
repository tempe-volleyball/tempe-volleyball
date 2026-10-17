import type { APIContext } from 'astro'
import { defineMiddleware } from 'astro:middleware'
import { env } from 'cloudflare:workers'
import { trailingSlashTarget } from './lib/content/paths'
import { isIndexable } from './lib/indexing'
import { guard, isAdminApi, isAdminPage, isInviteApi, needsSession } from './server/auth/guard'
import { cachePublic, tags } from './server/cache'
import { followRedirect, publicDb } from './server/public'
import { getServices } from './server/services'
import { slashRedirect } from './server/site'

// 0. Public paths with a trailing slash (every old WordPress URL) get a 301 to the slashless path, or straight to
//    the redirects table's target for it (see src/lib/content/paths.ts trailingSlashTarget for what's exempt).
// 1. Admin guard for /admin/* and /api/admin/* (plus same-origin checks on /api/invites/*): looks up the session
//    (from the signed cookie cache, usually without touching D1) into Astro.locals.user/session, then redirects,
//    401s or 403s as src/server/auth/guard.ts decides. Public pages skip the lookup entirely.
// 2. Only production on www.tempevb.com may be indexed (not staging, previews, or *.workers.dev).
export const onRequest = defineMiddleware(async (context, next) => {
  const { url, request } = context
  context.locals.user = null
  context.locals.session = null

  const slashless = request.method === 'GET' || request.method === 'HEAD' ? trailingSlashTarget(url.pathname) : null
  if (slashless) {
    const redirect = await redirectTrailingSlash(context, slashless)
    const response = new Response(null, { status: redirect.status, headers: redirect.headers })
    if (!isIndexable(url, env.SITE_ENV)) response.headers.set('X-Robots-Tag', 'noindex, nofollow')
    return response
  }

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
  if (admin) return adminResponse(response, setCookies)
  if (!isIndexable(url, env.SITE_ENV)) response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  return response
})

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
  return new Response(null, { status: 301, headers: { Location: slashless + context.url.search } })
}

/** Admin responses are never cached or indexed. */
function adminResponse(response: Response, setCookies: string[]) {
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  for (const c of setCookies) response.headers.append('Set-Cookie', c)
  return response
}
