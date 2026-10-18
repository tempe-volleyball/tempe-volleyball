import { and, eq, gt, like, sql } from 'drizzle-orm'
import { runBatch, type AppDb } from '../db'
import { auditLog, siteSettings, user, verification, type AuditAction, type NewAuditLogEntry } from '../db/schema'
import { readSettings } from '../../lib/content/settings'
import { canRemove } from '../../lib/roles'
import { RoleError, loadActorRole, type Actor } from './roles'
import type { TrustedDeviceHooks } from './passwordless-2fa'

// Trusted devices ("Trust this device" on the TOTP step of sign-in).
//
// They're Better Auth's own twoFactor trust-device records: `/two-factor/verify-totp` (or verify-backup-code) with
// `trustDevice: true` stores a `trust-device-<random>` verification row whose value is the user id, and sets the
// signed, httpOnly `trust_device` cookie holding an HMAC of `<user id>!<identifier>` plus the identifier. Our
// passwordless-2fa.ts hook checks that cookie against the row, and counts the trust period (Settings → Security,
// owners only) from the row's createdAt, so a trusted device asks again after that many days however often it's
// used. Rows live in D1, so revoking is a delete: from Security (yours), Admin users (someone you manage), and
// automatically when TOTP is set up again or turned off, or the user's role changes or they're removed.

export const TRUST_DEVICE_PREFIX = 'trust-device-'

const DAY_MS = 24 * 60 * 60 * 1000

const trustRows = (userId: string) => and(eq(verification.value, userId), like(verification.identifier, `${TRUST_DEVICE_PREFIX}%`))

/** The delete for a user's trusted devices, for a batch (roles.ts adds it to role changes and removals). */
export const forgetTrustedDevices = (db: AppDb, userId: string) => db.delete(verification).where(trustRows(userId))

/** Settings → Security → days to trust a device (0 = off). */
export async function trustDeviceDays(db: AppDb): Promise<number> {
  const rows = await db
    .select({ key: siteSettings.key, value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, 'security'))
  return readSettings(rows).security.trustDeviceDays
}

/** How many devices still skip the code for this user, under the current trust period. */
export async function countTrustedDevices(db: AppDb, userId: string, days: number, now = new Date()): Promise<number> {
  if (days <= 0) return 0
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(verification)
    .where(and(trustRows(userId), gt(verification.expiresAt, now), gt(verification.createdAt, new Date(now.getTime() - days * DAY_MS))))
    .get()
  return row?.n ?? 0
}

const auditRow = (actor: Actor | null, action: AuditAction, userId: string, after: unknown, at: string): NewAuditLogEntry => ({
  at,
  actorUserId: actor?.id ?? null,
  action,
  targetType: 'user',
  targetId: userId,
  before: null,
  after: after ?? null,
  ip: actor?.ip ?? null,
})

const countRows = async (db: AppDb, userId: string) =>
  (
    await db
      .select({ n: sql<number>`count(*)` })
      .from(verification)
      .where(trustRows(userId))
      .get()
  )?.n ?? 0

/**
 * Forgets every trusted device of `targetId`, audited as auth.devices_revoke. You can do it for yourself, or for
 * a user whose account you could remove (roles.ts: below your own role; owners manage everyone).
 */
export async function revokeTrustedDevices(db: AppDb, actor: Actor, targetId: string, now = new Date()) {
  if (targetId !== actor.id) {
    const [actorRole, target] = await Promise.all([
      loadActorRole(db, actor),
      db.select({ role: user.role }).from(user).where(eq(user.id, targetId)).get(),
    ])
    if (!target) throw new RoleError('not_found', 'No such user.')
    if (!canRemove(actorRole, target.role)) throw new RoleError('forbidden', `You can't change a ${target.role}'s devices.`)
  }
  const count = await countRows(db, targetId)
  await runBatch(db, [
    forgetTrustedDevices(db, targetId),
    db.insert(auditLog).values(auditRow(actor, 'auth.devices_revoke', targetId, { reason: 'manual', count }, now.toISOString())),
  ])
  return { revoked: count }
}

/** What passwordless-2fa.ts needs from the database: the trust period, revoking and auditing. */
export const trustedDeviceHooks = (db: AppDb): TrustedDeviceHooks => ({
  trustDays: () => trustDeviceDays(db),
  revokeAll: async (userId, reason, ip) => {
    const count = await countRows(db, userId)
    if (count === 0) return
    await runBatch(db, [
      forgetTrustedDevices(db, userId),
      db.insert(auditLog).values(auditRow({ id: userId, ip }, 'auth.devices_revoke', userId, { reason, count }, new Date().toISOString())),
    ])
  },
  onTrusted: async (userId, days, ip) => {
    await db.insert(auditLog).values(auditRow({ id: userId, ip }, 'auth.device_trust', userId, { days }, new Date().toISOString()))
  },
})
