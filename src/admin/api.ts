import type { UserRole } from '../lib/roles'

// fetch() for our /api/admin and /api/invites JSON endpoints. Errors arrive as { error, message }.

export type Me = {
  user: { id: string; name: string; email: string; role: UserRole; twoFactorEnabled: boolean }
  totpRequired: boolean
  canManageUsers: boolean
  assignableRoles: UserRole[]
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
  if (res.status === 401) {
    // Session ended (expired, or removed by an admin): back to sign-in.
    window.location.assign(`/admin/sign-in?next=${encodeURIComponent(window.location.pathname)}`)
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error', data.message ?? data.error ?? `Request failed (${res.status})`)
  return data as T
}

export type AdminUserRow = { id: string; name: string; email: string; role: UserRole; twoFactorEnabled: boolean | null; createdAt: string }
export type InviteRow = { id: string; email: string; role: UserRole; expiresAt: string; createdAt: string; invitedBy: string | null }
export type AuditRow = {
  id: string
  at: string
  action: string
  actorUserId: string | null
  actorEmail: string | null
  targetType: string | null
  targetId: string | null
  before: unknown
  after: unknown
  ip: string | null
}

/** "18/10/2026, 2:05 pm" in Sydney time. */
export const formatWhen = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso))
