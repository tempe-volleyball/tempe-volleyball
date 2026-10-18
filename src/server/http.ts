import { RoleError, atLeast, loadActorRole, type Actor } from './auth/roles'
import type { AppDb } from './db'
import type { UserRole } from './db/schema'

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

/** Drops a failed query's bound values ("… params: a,b,c") from a message: they can be names, emails and phones. */
const withoutParams = (message: string) => message.replace(/\s*params:[\s\S]*$/i, '').slice(0, 500)

/**
 * What's logged for an unexpected error: its name, code and message, and its cause's, with any query parameters
 * cut off. Never the error object itself: drizzle's DrizzleQueryError carries the SQL's bound values (personal data
 * on the enrolment routes), and Workers Logs keep what's logged.
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return typeof e === 'string' ? withoutParams(e) : typeof e
  const code = (e as { code?: unknown }).code
  const cause = (e as { cause?: unknown }).cause
  const parts = [`${e.name}${typeof code === 'string' || typeof code === 'number' ? ` (${code})` : ''}: ${withoutParams(e.message)}`]
  if (cause instanceof Error) {
    const causeCode = (cause as { code?: unknown }).code
    parts.push(
      `cause ${cause.name}${typeof causeCode === 'string' || typeof causeCode === 'number' ? ` (${causeCode})` : ''}: ${withoutParams(cause.message)}`,
    )
  }
  return parts.join('; ')
}

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

/** The largest JSON body a public (signed-out) route reads. */
export const PUBLIC_BODY_LIMIT = 64 * 1024

const tooLarge = () => new HttpError(413, 'too_large', 'That request is too large.')

/** The body as text, refusing (413) anything over `maxBytes`, whether or not Content-Length says so. */
async function readCapped(request: Request, maxBytes: number): Promise<string> {
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

/**
 * The request's JSON object. `maxBytes` caps the body (413 over it) before anything is parsed: public routes pass
 * PUBLIC_BODY_LIMIT, so a huge body can't use up the CPU budget before the rate limit and Turnstile run.
 */
export async function readJson<T extends Record<string, unknown>>(request: Request, opts: { maxBytes?: number } = {}): Promise<Partial<T>> {
  let body: unknown
  try {
    body = opts.maxBytes ? JSON.parse(await readCapped(request, opts.maxBytes)) : await request.json()
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
