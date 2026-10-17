import type { UserRole } from '../db/schema'

// What the middleware does with /admin/* pages and /api/admin/* (and /api/invites/*) requests. Pure, so it's
// tested without Astro or Better Auth; src/middleware.ts feeds it the session and request headers.
//
// CSRF: Better Auth checks Origin on its own /api/auth endpoints. For our JSON APIs, unsafe methods must come from
// the same origin (Origin header, or Sec-Fetch-Site: same-origin when a browser leaves Origin out). Session
// cookies are SameSite=Lax as well.

export type GuardUser = { role: UserRole; twoFactorEnabled?: boolean | null }

export type GuardRequest = {
  pathname: string
  /** Query string including '?', or ''. */
  search?: string
  method: string
  /** The Origin header, if any. */
  origin: string | null
  secFetchSite: string | null
  /** Origins allowed to make unsafe requests: this request's own origin and SITE_URL. */
  allowedOrigins: readonly string[]
}

export type GuardDecision =
  | { action: 'next' }
  | { action: 'redirect'; to: string }
  | { action: 'json'; status: 401 | 403; error: 'unauthenticated' | 'totp_required' | 'bad_origin' }

export const SIGN_IN_PAGE = '/admin/sign-in'
/** TOTP enrolment (and the rest of the user's security settings). Owners without TOTP can only reach this. */
export const SECURITY_PAGE = '/admin/security'
/** Admin pages reachable without a session. */
const PUBLIC_PAGES = new Set([SIGN_IN_PAGE, '/admin/invite'])
/** APIs an owner who hasn't enrolled TOTP yet may call (the admin app needs to know who's signed in). */
const PRE_TOTP_APIS = new Set(['/api/admin/me'])

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const trimSlash = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)

export const isAdminPage = (pathname: string) => pathname === '/admin' || pathname.startsWith('/admin/')
export const isAdminApi = (pathname: string) => pathname === '/api/admin' || pathname.startsWith('/api/admin/')
export const isInviteApi = (pathname: string) => pathname.startsWith('/api/invites/')

/** Does this path need the session looked up? (Public pages never pay for it.) */
export const needsSession = (pathname: string) => isAdminPage(pathname) || isAdminApi(pathname)

/** Owners must have TOTP before doing anything else. */
export const mustEnrolTotp = (user: GuardUser) => user.role === 'owner' && !user.twoFactorEnabled

export const isSameOrigin = (req: Pick<GuardRequest, 'origin' | 'secFetchSite' | 'allowedOrigins'>) => {
  if (req.origin) return req.allowedOrigins.includes(req.origin)
  return req.secFetchSite === 'same-origin'
}

/** Only same-site relative paths under /admin are allowed as a post-sign-in destination. */
export const safeNext = (next: string | null | undefined) => {
  if (!next || !next.startsWith('/admin') || next.startsWith('//') || next.includes('\\')) return '/admin'
  const path = next.split(/[?#]/)[0]!
  return PUBLIC_PAGES.has(trimSlash(path)) ? '/admin' : next
}

export function guard(req: GuardRequest, user: GuardUser | null): GuardDecision {
  const pathname = trimSlash(req.pathname)
  const api = isAdminApi(pathname) || isInviteApi(pathname)

  if (api && !SAFE_METHODS.has(req.method.toUpperCase()) && !isSameOrigin(req)) return { action: 'json', status: 403, error: 'bad_origin' }

  if (isInviteApi(pathname)) return { action: 'next' }

  if (isAdminApi(pathname)) {
    if (!user) return { action: 'json', status: 401, error: 'unauthenticated' }
    if (mustEnrolTotp(user) && !PRE_TOTP_APIS.has(pathname)) return { action: 'json', status: 403, error: 'totp_required' }
    return { action: 'next' }
  }

  if (isAdminPage(pathname)) {
    if (PUBLIC_PAGES.has(pathname)) {
      // Already signed in: the sign-in page has nothing to do.
      if (user && pathname === SIGN_IN_PAGE) return { action: 'redirect', to: mustEnrolTotp(user) ? SECURITY_PAGE : '/admin' }
      return { action: 'next' }
    }
    if (!user) {
      const here = `${pathname}${req.search ?? ''}`
      return { action: 'redirect', to: here === '/admin' ? SIGN_IN_PAGE : `${SIGN_IN_PAGE}?next=${encodeURIComponent(here)}` }
    }
    if (mustEnrolTotp(user) && pathname !== SECURITY_PAGE) return { action: 'redirect', to: `${SECURITY_PAGE}?required=1` }
  }
  return { action: 'next' }
}
