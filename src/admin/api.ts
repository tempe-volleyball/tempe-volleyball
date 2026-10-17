import type { Issue } from '../lib/fixtures'
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
  /** Extra fields in the error body, e.g. `issues` on 422 invalid_draw and some not_ready errors. */
  readonly details: Record<string, unknown>
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
  /** The draw's problems, when the server sent them (the lib's Issue type). */
  get issues(): Issue[] {
    return Array.isArray(this.details.issues) ? (this.details.issues as Issue[]) : []
  }
}

/** Someone else saved first (a stale baseUpdatedAt). */
export const isConflict = (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === 'conflict'

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & Record<string, unknown>
  if (res.status === 401) {
    // Session ended (expired, or removed by an admin): back to sign-in.
    window.location.assign(`/admin/sign-in?next=${encodeURIComponent(window.location.pathname)}`)
  }
  if (!res.ok) {
    const { error, message, ...details } = data
    throw new ApiError(res.status, error ?? 'error', message ?? error ?? `Request failed (${res.status})`, details)
  }
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

// ── Seasons (docs/api/seasons.md) ─────────────────────────────────────────────
// Type-only imports: nothing from src/server ends up in the browser bundle.

export type { SeasonView, SeasonMeta, CourtOption, LeagueListItem, SeasonListItem, SaveDrawResult } from '../server/competition/seasons'
export type { TeamListItem } from '../server/competition/teams'
export type { ClashDraws } from '../server/competition/clashes'
export type { MatchDayState } from '../server/competition/results'
export type { AdjustmentRow } from '../server/competition/adjustments'
export type { MatchList, MatchListRow } from '../server/competition/match-list'
export type { WithdrawResult, ReinstateResult } from '../server/competition/withdraw'

// ── Stats (docs/api/stats.md) ─────────────────────────────────────────────────

export type StatsResponse = import('../server/analytics/stats').StatsView & { canFetch: boolean }
export type PageViewsResponse = { source: 'ga4' | 'search_console' | 'cloudflare' | null; days: number; views: Record<string, number> }
// ── Programmes, categories, venues (docs/api/programmes.md) ───────────────────

export type {
  ProgrammeView,
  ProgrammeListItem,
  ProgrammeChoices,
  ProgrammeGenerated,
  ProgrammeHistory,
  CategoryRef,
  VenueRef,
} from '../server/programmes/programmes'
export type { CategoryListItem } from '../server/programmes/categories'
export type { VenueRow, CourtRow } from '../server/programmes/venues'
export type { SessionRow, TermRow, EventRow, InstanceProduct } from '../server/programmes/schedule'
export type { Programme, ProgrammeKind, ProgrammeStatus, OccurrenceStatus } from '../server/db/schema'

// ── Enrolment (docs/api/enrolment.md) ─────────────────────────────────────────

export type { TargetSummary, TargetDetail, RegistrationRow, GroupRow, Counts } from '../server/enrolment/admin'
export type { FormsList, FormSummary } from '../server/enrolment/forms'
export type { EnrolmentForm } from '../server/db/schema'
