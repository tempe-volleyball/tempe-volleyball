import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { id, SQL_NOW_ISO, timestamps } from './columns'
import { auditActions, userRoles } from './enums'

// Admin: invites, the audit log and site settings. Roles are user.role (see auth.ts). See PLAN.md "Auth and admin".

/** Site-wide settings the admin can edit (contact details, PayID, social links …), one row per key. From 0000_init. */
export const siteSettings = sqliteTable('site_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  // Left exactly as in 0000_init: no created_at/updated_by, since SQLite can only ADD COLUMN without rebuilding the
  // table and drizzle-kit drops the ON DELETE clause when adding a foreign-key column. Changes are in audit_log.
  updatedAt: text('updated_at').notNull(),
})

/** An invitation to become an admin user. Only a SHA-256 hash of the token is stored. */
export const adminInvites = sqliteTable(
  'admin_invites',
  {
    id: id(),
    /** Lower-cased. */
    email: text('email').notNull(),
    role: text('role', { enum: userRoles }).notNull(),
    tokenHash: text('token_hash').notNull(),
    invitedBy: text('invited_by').references(() => user.id, { onDelete: 'set null' }),
    /** UTC ISO; 7 days after creation. */
    expiresAt: text('expires_at').notNull(),
    acceptedAt: text('accepted_at'),
    revokedAt: text('revoked_at'),
    /** Set by the hourly cron once expires_at has passed without acceptance. */
    expiredAt: text('expired_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('admin_invites_token_hash_unique').on(t.tokenHash),
    index('admin_invites_email_idx').on(t.email),
    index('admin_invites_invited_by_idx').on(t.invitedBy),
    index('admin_invites_expires_at_idx').on(t.expiresAt),
  ],
)

/**
 * Append-only record of sensitive actions. actor_user_id is deliberately not a foreign key, so entries survive
 * the user being deleted. Never update or delete rows.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    /** UTC ISO. */
    at: text('at').notNull().default(SQL_NOW_ISO),
    actorUserId: text('actor_user_id'),
    action: text('action', { enum: auditActions }).notNull(),
    /** e.g. "user", "invite", "payment", "match_day". */
    targetType: text('target_type'),
    targetId: text('target_id'),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
    ip: text('ip'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_actor_user_id_idx').on(t.actorUserId),
    index('audit_log_target_idx').on(t.targetType, t.targetId),
  ],
)

/**
 * Fixed-window rate-limit counters for public endpoints (the enrolment form: per IP and per email). One row per key
 * and window; keys hold only a SHA-256 prefix of the IP or email, never the value. `hit()` in
 * src/server/ratelimit.ts upserts atomically; the hourly cron deletes rows past `expires_at`.
 */
export const rateLimits = sqliteTable(
  'rate_limits',
  {
    /** "<scope>:<hash>", e.g. "enrol:ip:3f2a…". */
    key: text('key').primaryKey(),
    /** Requests counted in the current window. */
    count: integer('count').notNull(),
    /** UTC ISO: when the current window started and when it ends. */
    windowStart: text('window_start').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => [index('rate_limits_expires_at_idx').on(t.expiresAt)],
)

export type RateLimit = typeof rateLimits.$inferSelect
export type SiteSetting = typeof siteSettings.$inferSelect
export type NewSiteSetting = typeof siteSettings.$inferInsert
export type AdminInvite = typeof adminInvites.$inferSelect
export type NewAdminInvite = typeof adminInvites.$inferInsert
export type AuditLogEntry = typeof auditLog.$inferSelect
export type NewAuditLogEntry = typeof auditLog.$inferInsert
