import { defineMiddleware } from 'astro:middleware'
import { env } from 'cloudflare:workers'
import { isIndexable } from './lib/indexing'
import { guard, isAdminApi, isAdminPage, isInviteApi, needsSession } from './server/auth/guard'
import { getServices } from './server/services'

// 1. Admin guard for /admin/* and /api/admin/* (plus same-origin checks on /api/invites/*): looks up the session
//    (from the signed cookie cache, usually without touching D1) into Astro.locals.user/session, then redirects,
//    401s or 403s as src/server/auth/guard.ts decides. Public pages skip the lookup entirely.
// 2. Only production on www.tempevb.com may be indexed (not staging, previews, or *.workers.dev).
export const onRequest = defineMiddleware(async (context, next) => {
  const { url, request } = context
  context.locals.user = null
  context.locals.session = null

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

/** Admin responses are never cached or indexed. */
function adminResponse(response: Response, setCookies: string[]) {
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  for (const c of setCookies) response.headers.append('Set-Cookie', c)
  return response
}
