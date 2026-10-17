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

// ── Content ───────────────────────────────────────────────────────────────────

export type ContentStatus = 'draft' | 'published' | 'archived'
export type ContentBody = { blocks: unknown[]; html: string }
/** What a save did to the edge cache (src/server/cache.ts). */
export type PurgeResult = 'purged' | 'disabled' | 'failed' | 'nothing'

export type PageTemplate = 'content' | 'home' | 'contact'
export type PageSummary = {
  id: string
  path: string
  title: string
  status: ContentStatus
  template: PageTemplate
  updatedAt: string
  publishedAt: string | null
}
export type PageRow = PageSummary & {
  metaDescription: string | null
  ogImageId: string | null
  body: ContentBody
  updatedBy: string | null
}
export type RevisionRow = { id: string; title: string; createdAt: string; createdBy: string | null }

export type PostSummary = {
  id: string
  slug: string
  title: string
  status: ContentStatus
  category: string | null
  updatedAt: string
  publishedAt: string | null
}
export type PostRow = PostSummary & { excerpt: string | null; coverMediaId: string | null; body: ContentBody }

export type MediaItem = {
  id: string
  filename: string
  alt: string
  mime: string
  width: number | null
  height: number | null
  variants: number[]
  bytes: number
  createdAt: string
  uploadedByEmail: string | null
  urls: { src: string; srcset: string | null; thumb: string | null; original: string }
}
export type MediaUse = { type: 'page' | 'post'; id: string; title: string; where: string }

export const statusLabel: Record<ContentStatus, string> = { draft: 'Draft', published: 'Published', archived: 'Archived' }

export const formatBytes = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

/** "18/10/2026, 2:05 pm" in Sydney time. */
export const formatWhen = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso))
