import { and, desc, eq, gt, isNull, lt, lte, sql } from 'drizzle-orm'
import { runBatch, type AppDb } from '../db'
import { adminInvites, auditLog, session, user } from '../db/schema'
import type { AdminInvite, AuditAction, NewAuditLogEntry, UserRole } from '../db/schema'
import { canAssign, canRemove, isRole, outranks } from '../../lib/roles'

// Admin roles, invites and the audit log: every rule from PLAN.md "Auth and admin" lives here.
//
//  - owner > admin > editor.
//  - You can grant, revoke or remove only roles strictly below your own. Owners manage everyone, owners included.
//  - The last owner can't be removed or demoted. JS checks first for a friendly error, and a guard statement inside
//    the same D1 batch as the write re-checks it, so two concurrent demotions can't both succeed.
//  - Invites last 7 days, store only a SHA-256 hash of the token, are single use and can be revoked.
//  - Every role change and invite action writes audit_log in the same batch as the change.
//
// The actor's role is always re-read from the database (not taken from the session cookie cache, which can be up
// to 5 minutes stale).

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

// The pure rules live in src/lib/roles.ts so the admin app can share them.
export { assignableRoles, atLeast, canAssign, canManageUsers, canRemove, isRole, outranks } from '../../lib/roles'

export type RoleErrorCode =
  | 'forbidden'
  | 'not_found'
  | 'last_owner'
  | 'invalid_input'
  | 'user_exists'
  | 'invite_invalid'
  | 'invite_expired'
  | 'invite_used'
  | 'invite_revoked'

const STATUS: Record<RoleErrorCode, number> = {
  forbidden: 403,
  not_found: 404,
  last_owner: 409,
  invalid_input: 400,
  user_exists: 409,
  invite_invalid: 404,
  invite_expired: 410,
  invite_used: 410,
  invite_revoked: 410,
}

export class RoleError extends Error {
  readonly code: RoleErrorCode
  readonly status: number
  constructor(code: RoleErrorCode, message: string) {
    super(message)
    this.name = 'RoleError'
    this.code = code
    this.status = STATUS[code]
  }
}

/** Who is acting, and from where (for audit_log.ip). */
export type Actor = { id: string; ip?: string | null }

// ── Batch guards ──────────────────────────────────────────────────────────────
// SQLite has no RAISE outside triggers, so a guard is a SELECT that errors when its condition holds: json() on an
// invalid string fails with "malformed JSON", which aborts and rolls back the whole D1 batch. Each batch has at
// most one guard, so the message identifies it.

const ownerCount = sql`(select count(*) from ${user} where ${user.role} = 'owner')`
const lastOwnerGuard = sql`select case when ${ownerCount} < 1 then json('guard:last_owner') end`

const errorText = (e: unknown): string => {
  let text = ''
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof Error) text += ` ${cur.message}`
    cur = (cur as { cause?: unknown }).cause
  }
  return text
}

const isGuardFailure = (e: unknown) => /malformed JSON/i.test(errorText(e))
const isUniqueFailure = (e: unknown) => /UNIQUE constraint failed/i.test(errorText(e))

const lastOwnerError = () => new RoleError('last_owner', 'There must always be at least one owner.')

// ── Helpers ───────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const normaliseEmail = (email: string) => email.trim().toLowerCase()

export const isValidEmail = (email: string) => email.length <= 254 && EMAIL_RE.test(email)

const audit = (
  actor: Actor | null,
  action: AuditAction,
  target: { type: string; id: string },
  before: unknown,
  after: unknown,
  at: string,
) =>
  ({
    at,
    actorUserId: actor?.id ?? null,
    action,
    targetType: target.type,
    targetId: target.id,
    before: before ?? null,
    after: after ?? null,
    ip: actor?.ip ?? null,
  }) satisfies NewAuditLogEntry

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

/** A new invite token: 32 random bytes, base64url. Only its hash is stored. */
export const newInviteToken = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)))

/** SHA-256 of the token as lower-case hex (admin_invites.token_hash). */
export const hashInviteToken = async (token: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired'

export const inviteStatus = (
  invite: Pick<AdminInvite, 'acceptedAt' | 'revokedAt' | 'expiredAt' | 'expiresAt'>,
  now: Date,
): InviteStatus => {
  if (invite.acceptedAt) return 'accepted'
  if (invite.revokedAt) return 'revoked'
  if (invite.expiredAt || invite.expiresAt <= now.toISOString()) return 'expired'
  return 'pending'
}

/** The actor's current role, read from D1. Throws RoleError('forbidden') if their account is gone. */
export const loadActorRole = async (db: AppDb, actor: Pick<Actor, 'id'>): Promise<UserRole> => {
  const row = await db.select({ role: user.role }).from(user).where(eq(user.id, actor.id)).get()
  if (!row) throw new RoleError('forbidden', 'Your account no longer exists.')
  return row.role
}

const pendingInviteWhere = (now: string) =>
  and(isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt), isNull(adminInvites.expiredAt), gt(adminInvites.expiresAt, now))

// ── Role changes and removal ──────────────────────────────────────────────────

/** Changes a user's role. Audited as role.grant (promotion) or role.revoke (demotion). */
export async function changeRole(db: AppDb, actor: Actor, targetId: string, to: UserRole, now = new Date()) {
  if (!isRole(to)) throw new RoleError('invalid_input', 'Unknown role.')
  const [actorRole, target] = await Promise.all([
    loadActorRole(db, actor),
    db.select({ id: user.id, email: user.email, role: user.role }).from(user).where(eq(user.id, targetId)).get(),
  ])
  if (!target) throw new RoleError('not_found', 'No such user.')
  if (target.role === to) return { id: target.id, role: to }
  if (!canAssign(actorRole, target.role, to)) throw new RoleError('forbidden', `You can't change a ${target.role} to ${to}.`)
  if (target.role === 'owner') {
    const owners = await db
      .select({ n: sql<number>`count(*)` })
      .from(user)
      .where(eq(user.role, 'owner'))
      .get()
    if ((owners?.n ?? 0) <= 1) throw lastOwnerError()
  }
  const at = now.toISOString()
  const action: AuditAction = outranks(to, target.role) ? 'role.grant' : 'role.revoke'
  try {
    await runBatch(db, [
      db
        .update(user)
        .set({ role: to, updatedAt: now })
        .where(and(eq(user.id, target.id), eq(user.role, target.role))),
      // Sign them out everywhere, so the new role applies from their next sign-in rather than when the session
      // cookie cache expires. (Unsafe API calls re-read the role anyway; this also covers page loads and GETs.)
      db.delete(session).where(eq(session.userId, target.id)),
      db
        .insert(auditLog)
        .values(audit(actor, action, { type: 'user', id: target.id }, { role: target.role }, { role: to, email: target.email }, at)),
      db.run(lastOwnerGuard),
    ])
  } catch (e) {
    if (isGuardFailure(e)) throw lastOwnerError()
    throw e
  }
  return { id: target.id, role: to }
}

/** Deletes an admin user (their sessions, accounts and TOTP go with them). Audited as user.remove. */
export async function removeUser(db: AppDb, actor: Actor, targetId: string, now = new Date()) {
  const [actorRole, target] = await Promise.all([
    loadActorRole(db, actor),
    db.select({ id: user.id, email: user.email, name: user.name, role: user.role }).from(user).where(eq(user.id, targetId)).get(),
  ])
  if (!target) throw new RoleError('not_found', 'No such user.')
  if (!canRemove(actorRole, target.role)) throw new RoleError('forbidden', `You can't remove a ${target.role}.`)
  if (target.role === 'owner') {
    const owners = await db
      .select({ n: sql<number>`count(*)` })
      .from(user)
      .where(eq(user.role, 'owner'))
      .get()
    if ((owners?.n ?? 0) <= 1) throw lastOwnerError()
  }
  try {
    await runBatch(db, [
      // The cascade would remove sessions too; deleting them explicitly keeps that true whatever the FKs say.
      db.delete(session).where(eq(session.userId, target.id)),
      db.delete(user).where(eq(user.id, target.id)),
      db
        .insert(auditLog)
        .values(
          audit(
            actor,
            'user.remove',
            { type: 'user', id: target.id },
            { email: target.email, name: target.name, role: target.role },
            null,
            now.toISOString(),
          ),
        ),
      db.run(lastOwnerGuard),
    ])
  } catch (e) {
    if (isGuardFailure(e)) throw lastOwnerError()
    throw e
  }
}

// ── Invites ───────────────────────────────────────────────────────────────────

/**
 * Invites `email` as `role`. Any pending invite for the same address is revoked in the same batch (so "invite
 * again" resends). Returns the plain token once, for the email link; only its hash is stored.
 */
export async function createInvite(db: AppDb, actor: Actor, input: { email: string; role: UserRole }, now = new Date()) {
  const email = normaliseEmail(input.email)
  if (!isValidEmail(email)) throw new RoleError('invalid_input', 'Enter a valid email address.')
  if (!isRole(input.role)) throw new RoleError('invalid_input', 'Unknown role.')
  const at = now.toISOString()
  const [actorRole, existing, pending] = await Promise.all([
    loadActorRole(db, actor),
    db.select({ id: user.id }).from(user).where(eq(user.email, email)).get(),
    db
      .select({ id: adminInvites.id, role: adminInvites.role })
      .from(adminInvites)
      .where(and(eq(adminInvites.email, email), pendingInviteWhere(at))),
  ])
  if (!canAssign(actorRole, null, input.role)) throw new RoleError('forbidden', `You can't invite someone as ${input.role}.`)
  if (existing) throw new RoleError('user_exists', 'That person is already an admin user.')
  for (const p of pending) {
    if (!canAssign(actorRole, null, p.role)) throw new RoleError('forbidden', `There's a pending ${p.role} invite for that address.`)
  }

  const token = newInviteToken()
  const id = crypto.randomUUID()
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString()
  const invite = {
    id,
    email,
    role: input.role,
    tokenHash: await hashInviteToken(token),
    invitedBy: actor.id,
    expiresAt,
    createdAt: at,
    updatedAt: at,
  }
  const revokes = pending.flatMap((p) => [
    db.update(adminInvites).set({ revokedAt: at, updatedAt: at }).where(eq(adminInvites.id, p.id)),
    db
      .insert(auditLog)
      .values(audit(actor, 'invite.revoke', { type: 'invite', id: p.id }, { email, role: p.role }, { reason: 'replaced', by: id }, at)),
  ])
  await runBatch(db, [
    ...revokes,
    db.insert(adminInvites).values(invite),
    db.insert(auditLog).values(audit(actor, 'invite.create', { type: 'invite', id }, null, { email, role: input.role, expiresAt }, at)),
  ])
  return { id, email, role: input.role, expiresAt, token }
}

/** Revokes a pending invite. You can revoke only invites for roles you could grant. */
export async function revokeInvite(db: AppDb, actor: Actor, inviteId: string, now = new Date()) {
  const [actorRole, invite] = await Promise.all([
    loadActorRole(db, actor),
    db.select().from(adminInvites).where(eq(adminInvites.id, inviteId)).get(),
  ])
  if (!invite) throw new RoleError('not_found', 'No such invite.')
  if (!canAssign(actorRole, null, invite.role)) throw new RoleError('forbidden', `You can't revoke a ${invite.role} invite.`)
  const status = inviteStatus(invite, now)
  if (status !== 'pending') throw new RoleError(`invite_${status === 'accepted' ? 'used' : status}`, `That invite is already ${status}.`)
  const at = now.toISOString()
  await runBatch(db, [
    db
      .update(adminInvites)
      .set({ revokedAt: at, updatedAt: at })
      .where(and(eq(adminInvites.id, invite.id), pendingInviteWhere(at))),
    db
      .insert(auditLog)
      .values(audit(actor, 'invite.revoke', { type: 'invite', id: invite.id }, { email: invite.email, role: invite.role }, null, at)),
  ])
}

const findInviteByToken = async (db: AppDb, token: string) => {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return undefined
  return db
    .select()
    .from(adminInvites)
    .where(eq(adminInvites.tokenHash, await hashInviteToken(token)))
    .get()
}

const assertPending = (invite: AdminInvite | undefined, now: Date): AdminInvite => {
  if (!invite) throw new RoleError('invite_invalid', 'This invite link is not valid.')
  const status = inviteStatus(invite, now)
  if (status === 'accepted') throw new RoleError('invite_used', 'This invite has already been used. Sign in instead.')
  if (status === 'revoked') throw new RoleError('invite_revoked', 'This invite was cancelled. Ask for a new one.')
  if (status === 'expired') throw new RoleError('invite_expired', 'This invite has expired. Ask for a new one.')
  return invite
}

/** What the accept-invite screen shows before the person accepts. */
export async function lookupInvite(db: AppDb, token: string, now = new Date()) {
  const invite = assertPending(await findInviteByToken(db, token), now)
  return { email: invite.email, role: invite.role, expiresAt: invite.expiresAt }
}

/**
 * Accepts an invite: creates the user with the invite's role and marks the invite used, in one batch. The token
 * was emailed to the address, so the email counts as verified. The person then signs in by email code as usual.
 */
export async function acceptInvite(db: AppDb, input: { token: string; name?: string; ip?: string | null }, now = new Date()) {
  const invite = assertPending(await findInviteByToken(db, input.token), now)
  const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, invite.email)).get()
  if (existing) throw new RoleError('user_exists', 'You already have an account. Sign in instead.')
  const name = (input.name ?? '').trim().slice(0, 100) || invite.email.split('@')[0]!
  const at = now.toISOString()
  const userId = crypto.randomUUID()
  try {
    await runBatch(db, [
      db
        .update(adminInvites)
        .set({ acceptedAt: at, updatedAt: at })
        .where(and(eq(adminInvites.id, invite.id), pendingInviteWhere(at))),
      // Fails the batch if the invite was used, revoked or expired since we read it (single use).
      db.run(
        sql`select case when not exists (select 1 from ${adminInvites} where ${adminInvites.id} = ${invite.id} and ${adminInvites.acceptedAt} = ${at}) then json('guard:invite') end`,
      ),
      db
        .insert(user)
        .values({ id: userId, name, email: invite.email, emailVerified: true, role: invite.role, createdAt: now, updatedAt: now }),
      db
        .insert(auditLog)
        .values(
          audit(
            { id: userId, ip: input.ip },
            'invite.accept',
            { type: 'invite', id: invite.id },
            null,
            { userId, email: invite.email, role: invite.role },
            at,
          ),
        ),
    ])
  } catch (e) {
    if (isGuardFailure(e)) throw new RoleError('invite_used', 'This invite is no longer valid.')
    if (isUniqueFailure(e)) throw new RoleError('user_exists', 'You already have an account. Sign in instead.')
    throw e
  }
  return { id: userId, email: invite.email, name, role: invite.role }
}

/** Cron: stamps expired_at on invites past their expiry. Idempotent. Returns how many it marked. */
export async function expireInvites(db: AppDb, now = new Date()) {
  const at = now.toISOString()
  const rows = await db
    .update(adminInvites)
    .set({ expiredAt: at, updatedAt: at })
    .where(
      and(isNull(adminInvites.acceptedAt), isNull(adminInvites.revokedAt), isNull(adminInvites.expiredAt), lte(adminInvites.expiresAt, at)),
    )
    .returning({ id: adminInvites.id })
  return rows.length
}

// ── Reads for the Admin users screen ──────────────────────────────────────────

export async function listAdminUsers(db: AppDb) {
  return db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      twoFactorEnabled: user.twoFactorEnabled,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(sql`case ${user.role} when 'owner' then 0 when 'admin' then 1 else 2 end`, user.email)
}

export async function listPendingInvites(db: AppDb, now = new Date()) {
  return db
    .select({
      id: adminInvites.id,
      email: adminInvites.email,
      role: adminInvites.role,
      expiresAt: adminInvites.expiresAt,
      createdAt: adminInvites.createdAt,
      invitedBy: adminInvites.invitedBy,
    })
    .from(adminInvites)
    .where(pendingInviteWhere(now.toISOString()))
    .orderBy(desc(adminInvites.createdAt))
}

/** Newest first, `limit` at a time; pass the last entry's `at` as `before` for the next page. */
export async function listAudit(db: AppDb, opts: { limit?: number; before?: string } = {}) {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200)
  return db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      action: auditLog.action,
      actorUserId: auditLog.actorUserId,
      actorEmail: user.email,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      before: auditLog.before,
      after: auditLog.after,
      ip: auditLog.ip,
    })
    .from(auditLog)
    .leftJoin(user, eq(user.id, auditLog.actorUserId))
    .where(opts.before ? lt(auditLog.at, opts.before) : undefined)
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit)
}
