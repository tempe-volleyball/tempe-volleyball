// Allowed values for enum-like text columns. Drizzle's text({ enum }) types the columns with these; there are no
// CHECK constraints in SQL, so adding a value is a code change, not a migration. Validate input against these
// arrays at the edges (API handlers, the importer).

// ── Competition ───────────────────────────────────────────────────────────────

export const leagueCodes = ['TNL', 'FNL', 'SNL', 'SAL', 'TVSL'] as const
export type LeagueCode = (typeof leagueCodes)[number]

/** `social`: 2 sets, draws, team duty. `super` (TVSL): best of 5, 90-minute slots, VNSW referees, no duty. */
export const leagueFormats = ['social', 'super'] as const
export type LeagueFormat = (typeof leagueFormats)[number]

export const seasonStatuses = ['draft', 'published', 'archived'] as const
export type SeasonStatus = (typeof seasonStatuses)[number]

export const matchDayKinds = ['regular', 'semi', 'final', 'skip'] as const
export type MatchDayKind = (typeof matchDayKinds)[number]

export const matchStatuses = ['scheduled', 'played', 'forfeit', 'cancelled'] as const
export type MatchStatus = (typeof matchStatuses)[number]

/** `draft` is what's being typed in; `published` is what counts (ladder, website, exports). */
export const matchResultKinds = ['draft', 'published'] as const
export type MatchResultKind = (typeof matchResultKinds)[number]

// ── Content ───────────────────────────────────────────────────────────────────

export const contentStatuses = ['draft', 'published', 'archived'] as const
export type ContentStatus = (typeof contentStatuses)[number]

export const pageTemplates = ['content', 'home', 'contact'] as const
export type PageTemplate = (typeof pageTemplates)[number]

export const menuItemKinds = ['page', 'url', 'league_ladder', 'league_fixtures'] as const
export type MenuItemKind = (typeof menuItemKinds)[number]

export const redirectSources = ['wp-import', 'manual'] as const
export type RedirectSource = (typeof redirectSources)[number]

// ── Auth and admin ────────────────────────────────────────────────────────────

/** Admin roles, highest first: owner > admin > editor. */
export const userRoles = ['owner', 'admin', 'editor'] as const
export type UserRole = (typeof userRoles)[number]

/** Known audit actions. The column is plain text, so new actions only need adding here. */
export const auditActions = [
  'role.grant',
  'role.revoke',
  'invite.create',
  'invite.revoke',
  'invite.accept',
  'user.remove',
  'payment.mark_paid',
  'payment.refund',
  'results.publish',
  'season.publish',
  'page.publish',
  'page.unpublish',
  'page.delete',
  'post.publish',
  'post.unpublish',
  'post.delete',
  'media.delete',
  'menu.update',
  'settings.update',
] as const
export type AuditAction = (typeof auditActions)[number]

// ── Registrations and payments ────────────────────────────────────────────────

export const productKinds = ['season_entry', 'training_session', 'adp_term', 'jdp_term'] as const
export type ProductKind = (typeof productKinds)[number]

export const paymentProviders = ['stripe', 'payid'] as const
export type PaymentProviderId = (typeof paymentProviders)[number]

export const groupKinds = ['team', 'group'] as const
export type GroupKind = (typeof groupKinds)[number]

export const registrationStatuses = ['pending_payment', 'paid', 'cancelled', 'expired', 'refunded', 'waitlist'] as const
export type RegistrationStatus = (typeof registrationStatuses)[number]

export const paymentStatuses = ['pending', 'paid', 'failed', 'cancelled', 'refunded'] as const
export type PaymentStatus = (typeof paymentStatuses)[number]

export const emailStatuses = ['queued', 'sent', 'failed'] as const
export type EmailStatus = (typeof emailStatuses)[number]
