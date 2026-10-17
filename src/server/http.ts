import { RoleError, atLeast, type Actor } from './auth/roles'
import type { UserRole } from './db/schema'

// Small helpers for the JSON API routes. Errors come back as { error: code, message } with a matching status.

export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function errorResponse(e: unknown) {
  if (e instanceof RoleError || e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status)
  console.error('[api] unexpected error', e)
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

export async function readJson<T extends Record<string, unknown>>(request: Request): Promise<Partial<T>> {
  try {
    const body: unknown = await request.json()
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Partial<T>
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid_input', 'Expected a JSON object.')
}

export const clientIp = (request: Request) => request.headers.get('cf-connecting-ip')

type LocalsUser = { id: string; role: UserRole } | null

/** The signed-in user, who must have at least `min`. The middleware already 401s missing sessions. */
export function requireRole(user: LocalsUser, min: UserRole, request: Request): Actor & { role: UserRole } {
  if (!user) throw new HttpError(401, 'unauthenticated', 'Sign in first.')
  if (!atLeast(user.role, min))
    throw new HttpError(403, 'forbidden', `You need to be ${min === 'admin' ? 'an admin' : `an ${min}`} for this.`)
  return { id: user.id, role: user.role, ip: clientIp(request) }
}
