import { RoleError, atLeast, loadActorRole, type Actor } from './auth/roles'
import type { AppDb } from './db'
import type { UserRole } from './db/schema'
import { describeError } from './log'

// Small helpers for the JSON API routes. Errors come back as { error: code, message } with a matching status.

export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  /** Extra fields for the error body, e.g. { issues } when a draw fails validation. */
  readonly details?: Record<string, unknown>
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    if (details) this.details = details
  }
}

export { describeError } from './log'

export function errorResponse(e: unknown) {
  if (e instanceof HttpError) return json({ ...e.details, error: e.code, message: e.message }, e.status)
  if (e instanceof RoleError) return json({ error: e.code, message: e.message }, e.status)
  console.error(`[api] unexpected error: ${describeError(e)}`)
  return json({ error: 'server_error', message: 'Something went wrong.' }, 500)
}

/** Runs a handler, turning thrown RoleError/HttpError into JSON error responses. */
export const handle = async (fn: () => Promise<Response>) => {
  try {
    return await fn()
  } catch (e) {
    return errorResponse(e)
  }
}

/** The largest JSON body a public (signed-out) route reads: the default for everything outside /api/admin. */
export const PUBLIC_BODY_LIMIT = 64 * 1024
/** The default for /api/admin/* (behind the session guard): long pages and whole draws fit with room to spare. */
export const ADMIN_BODY_LIMIT = 1024 * 1024
/** The signed-out invite routes (/api/invites/*): a token and a name. */
export const INVITE_BODY_LIMIT = 4 * 1024
/** Better Auth's endpoints (/api/auth/*): an email address, a code, a callback URL. */
export const AUTH_BODY_LIMIT = 16 * 1024

const tooLarge = () => new HttpError(413, 'too_large', 'That request is too large.')

/** The body as text, refusing (413) anything over `maxBytes`, whether or not Content-Length says so. */
export async function readCapped(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge()
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw tooLarge()
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}

/** The cap readJson applies when the route doesn't pass one: ADMIN_BODY_LIMIT under /api/admin/, else PUBLIC_BODY_LIMIT. */
export function defaultBodyLimit(request: Request): number {
  const path = new URL(request.url).pathname
  return path === '/api/admin' || path.startsWith('/api/admin/') ? ADMIN_BODY_LIMIT : PUBLIC_BODY_LIMIT
}

/**
 * The request's JSON object. The body is always capped (413 over it) before anything is parsed, so a huge body
 * can't use up the CPU budget before the rate limit, Turnstile or a token check runs: by default at
 * PUBLIC_BODY_LIMIT, or ADMIN_BODY_LIMIT on /api/admin/* (signed-in admins only). `maxBytes` sets another cap;
 * there is no uncapped read.
 */
export async function readJson<T extends Record<string, unknown>>(request: Request, opts: { maxBytes?: number } = {}): Promise<Partial<T>> {
  const maxBytes = opts.maxBytes ?? defaultBodyLimit(request)
  let body: unknown
  try {
    body = JSON.parse(await readCapped(request, maxBytes))
  } catch (e) {
    if (e instanceof HttpError) throw e
    body = undefined
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Partial<T>
  throw new HttpError(400, 'invalid_input', 'Expected a JSON object.')
}

export const clientIp = (request: Request) => request.headers.get('cf-connecting-ip')

type LocalsUser = { id: string; role: UserRole } | null

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const forbidden = (min: UserRole) =>
  new HttpError(403, 'forbidden', `You need to be ${min === 'admin' ? 'an admin' : `an ${min}`} for this.`)

/**
 * The signed-in user, who must have at least `min`. The middleware already 401s missing sessions.
 *
 * locals.user comes from Better Auth's session cookie cache, which can be up to 5 minutes stale. That's fine for
 * most reads, but a removed or demoted admin mustn't keep changing things, so for unsafe methods (POST, PUT, PATCH,
 * DELETE) the role is re-read from D1 (one indexed query) and that's the one checked and returned. `fresh` re-reads
 * it for reads too: GET routes that return personal data (enrolments, forms, the CSV export) use it, so a demoted
 * or removed admin can't keep downloading entrants' details for those 5 minutes.
 */
export async function requireRole(
  user: LocalsUser,
  min: UserRole,
  request: Request,
  db: AppDb,
  opts: { fresh?: boolean } = {},
): Promise<Actor & { role: UserRole }> {
  if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in first.')
  if (!atLeast(user.role, min)) throw forbidden(min)
  let role = user.role
  if (opts.fresh || !SAFE_METHODS.has(request.method.toUpperCase())) {
    role = await loadActorRole(db, user)
    if (!atLeast(role, min)) throw forbidden(min)
  }
  return { id: user.id, role, ip: clientIp(request) }
}
