import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { runBatch, type AppDb } from '../db'
import { groups, players, products, programmes, registrations } from '../db/schema'
import type { Mailer } from '../email'
import { HttpError } from '../http'
import {
  effective,
  joinTargetRows,
  labelOfRow,
  programmeColumns,
  settleStatements,
  targetLabelColumns,
  waitlistRankSql,
  type Effective,
} from './core'
import { emailNewEntry } from './submit'
import { readConfirmToken } from './tokens'

// Email confirmation (docs/admin.md §3.7): a public entry for a target that asks for it starts as pending_email,
// holding no spot. The emailed link (/enrol/confirm#<token>) brings the person here; confirming settles the entry
// against the caps exactly as a new entry would be (one batch: the conditional update plus core.ts
// settleStatements), so it gets a spot, joins the end of the waitlist, or, with the waitlist off and no room, is
// cancelled as full. The admin can do the same by hand (admin.ts "verify"), and the hourly cron expires entries
// whose link wasn't used in time (expirePendingStatements).

export type ConfirmState = 'pending' | 'confirmed' | 'waitlist' | 'full' | 'expired'

export type ConfirmView = {
  state: ConfirmState
  firstName: string
  programme: string
  target: string
  teamName: string | null
  /** The deadline while pending. */
  expiresAt: string | null
  /** Once confirmed or waitlisted. */
  reference: string | null
  /** 1-based place on the waitlist. */
  position: number | null
}

export type ConfirmDeps = {
  db: AppDb
  mailer: Pick<Mailer, 'sendEmail'>
  secret: string
  now?: Date
}

/** A pending (or once pending) entry with what confirming it needs. One query. */
export async function loadPendingEntry(db: AppDb, registrationId: string) {
  const row = await joinTargetRows(
    db
      .select({
        r: registrations,
        email: players.email,
        firstName: players.firstName,
        product: products,
        programme: programmeColumns,
        groupStatus: sql<string | null>`${groups.status}`.as('group_status'),
        groupName: sql<string | null>`${groups.name}`.as('group_name'),
        ...targetLabelColumns,
      })
      .from(registrations)
      .innerJoin(players, eq(players.id, registrations.playerId))
      .innerJoin(products, eq(products.id, registrations.productId))
      .innerJoin(programmes, eq(programmes.id, products.programmeId))
      .leftJoin(groups, eq(groups.id, registrations.groupId))
      .$dynamic(),
  )
    .where(eq(registrations.id, registrationId))
    .get()
  if (!row) return null
  const team = !!row.r.groupId && !row.r.freeAgent
  return { ...row, team, label: labelOfRow(row), eff: effective(row.programme, row.product) }
}

export type PendingEntry = NonNullable<Awaited<ReturnType<typeof loadPendingEntry>>>

const badLink = () => new HttpError(404, 'not_found', "That link isn't valid. Check you copied all of it from the email.")

const stateOf = (status: string, holdExpiresAt: string | null, nowIso: string): ConfirmState => {
  if (status === 'pending_email') return holdExpiresAt && holdExpiresAt > nowIso ? 'pending' : 'expired'
  if (status === 'waitlist') return 'waitlist'
  if (status === 'cancelled' || status === 'expired' || status === 'refunded') return 'expired'
  return 'confirmed'
}

async function viewOf(db: AppDb, entry: PendingEntry, state: ConfirmState): Promise<ConfirmView> {
  let position: number | null = null
  if (state === 'waitlist') {
    const id = entry.team ? entry.r.groupId! : entry.r.id
    const row = await db
      .select({ rank: sql<number>`${waitlistRankSql(entry.team ? 'group' : 'registration', entry.r.productId, id)}` })
      .from(registrations)
      .where(eq(registrations.id, entry.r.id))
      .get()
    position = row ? Number(row.rank) || null : null
  }
  return {
    state,
    firstName: entry.firstName,
    programme: entry.programme.name,
    target: entry.label,
    teamName: entry.team ? entry.groupName : null,
    expiresAt: state === 'pending' ? entry.r.holdExpiresAt : null,
    reference: state === 'confirmed' || state === 'waitlist' ? entry.r.reference : null,
    position,
  }
}

async function entryForToken(deps: ConfirmDeps, token: unknown) {
  const subject = await readConfirmToken(deps.secret, token)
  if (!subject) throw badLink()
  const entry = await loadPendingEntry(deps.db, subject.id)
  // A token only ever names the registration it was made for, created at that moment.
  if (!entry || entry.r.createdAt !== subject.createdAt) throw badLink()
  return entry
}

/** What the confirm page shows for a link (doesn't change anything). */
export async function viewConfirmation(deps: ConfirmDeps, token: unknown): Promise<ConfirmView> {
  const entry = await entryForToken(deps, token)
  const now = (deps.now ?? new Date()).toISOString()
  return viewOf(deps.db, entry, stateOf(entry.r.status, entry.r.holdExpiresAt, now))
}

/**
 * The batch that settles a pending entry: it moves to confirmed only while still pending (and, unless
 * `ignoreDeadline`, inside its deadline), then the caps decide (core.ts settleStatements; refused = cancelled as
 * full). The first statement returns the row when it applied; the last reads the status back.
 */
export function settlePendingStatements(
  db: AppDb,
  entry: { registrationId: string; groupId: string | null; productId: string },
  eff: Pick<Effective, 'capPlayers' | 'capTeams' | 'waitlistEnabled'>,
  at: string,
  opts: { ignoreDeadline?: boolean; extra?: BatchItem<'sqlite'>[] } = {},
): [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] {
  const { registrationId, groupId, productId } = entry
  const inTime = opts.ignoreDeadline ? undefined : gt(registrations.holdExpiresAt, at)
  const pendingReg = and(eq(registrations.id, registrationId), eq(registrations.status, 'pending_email'), inTime)
  const settled = { status: 'confirmed' as const, holdExpiresAt: null, updatedAt: at }
  const head: [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]] = groupId
    ? [
        db
          .update(groups)
          .set({ status: 'confirmed', updatedAt: at })
          .where(
            and(
              eq(groups.id, groupId),
              eq(groups.status, 'pending_email'),
              sql`exists (select 1 from registrations rp where rp.id = ${registrationId} and rp.status = 'pending_email'${opts.ignoreDeadline ? sql`` : sql` and rp.hold_expires_at > ${at}`})`,
            ),
          )
          .returning({ id: groups.id }),
        db
          .update(registrations)
          .set(settled)
          .where(and(pendingReg, sql`(select gs.status from groups gs where gs.id = ${groupId}) = 'confirmed'`)),
      ]
    : [db.update(registrations).set(settled).where(pendingReg).returning({ id: registrations.id })]
  return [
    ...head,
    ...settleStatements(db, { productId, registrationId, groupId }, eff, { refuse: 'cancel', at }),
    ...(opts.extra ?? []),
    db.select({ status: registrations.status }).from(registrations).where(eq(registrations.id, registrationId)),
  ]
}

/**
 * Settles a pending entry now (the person's click, or an admin's "Confirm email"), then emails the outcome
 * (priority: the address is confirmed, or an admin did it). Returns the state it ended in, or null when it was no
 * longer pending (someone else got there first, or the deadline passed).
 */
export async function settlePending(
  deps: Pick<ConfirmDeps, 'db' | 'mailer'>,
  entry: PendingEntry,
  at: string,
  opts: { ignoreDeadline?: boolean; extra?: BatchItem<'sqlite'>[]; notify?: boolean } = {},
): Promise<ConfirmState | null> {
  const { db } = deps
  const results = await runBatch(
    db,
    settlePendingStatements(
      db,
      { registrationId: entry.r.id, groupId: entry.team ? entry.r.groupId : null, productId: entry.r.productId },
      entry.eff,
      at,
      opts,
    ),
  )
  if ((results[0] as unknown[]).length === 0) return null
  const status = (results[results.length - 1] as { status: string }[])[0]?.status ?? 'cancelled'
  const state: ConfirmState = status === 'waitlist' ? 'waitlist' : status === 'confirmed' ? 'confirmed' : 'full'
  if (opts.notify !== false && state !== 'full') {
    const view = await viewOf(db, entry, state)
    await emailNewEntry(
      db,
      deps.mailer,
      entry.email,
      entry.firstName,
      {
        status: state,
        reference: entry.r.reference,
        position: view.position,
        registrationId: entry.r.id,
        groupId: entry.r.groupId,
        teamName: view.teamName,
        amountCents: entry.r.amountCents,
        message: null,
        programme: entry.programme.name,
        target: entry.label,
      },
      { priority: true },
    )
  }
  return state
}

/** The person clicked the link: confirm their address and settle the entry. Idempotent for a second click. */
export async function confirmEmail(deps: ConfirmDeps, token: unknown): Promise<ConfirmView> {
  const entry = await entryForToken(deps, token)
  const at = (deps.now ?? new Date()).toISOString()
  const before = stateOf(entry.r.status, entry.r.holdExpiresAt, at)
  if (before !== 'pending') return viewOf(deps.db, entry, before)
  const state = await settlePending(deps, entry, at)
  if (!state) {
    // Lost a race (a double click, or an admin): show where it stands now.
    const now = await loadPendingEntry(deps.db, entry.r.id)
    return now ? viewOf(deps.db, now, stateOf(now.r.status, now.r.holdExpiresAt, at)) : viewOf(deps.db, entry, 'expired')
  }
  return viewOf(deps.db, entry, state)
}

// ── Cron ──────────────────────────────────────────────────────────────────────

/** At most this many unconfirmed entries expire per hourly run (two statements whatever the number). */
export const CRON_PENDING_LIMIT = 200

export const PENDING_EXPIRED_REASON = 'Email address not confirmed in time'

/**
 * The cron's statements for one batch: unconfirmed entries past their deadline become expired (they never held a
 * spot, so nothing is offered on), and their team entries cancelled. No emails: the address was never confirmed.
 */
export function expirePendingStatements(db: AppDb, at: string): [BatchItem<'sqlite'>, BatchItem<'sqlite'>] {
  return [
    db
      .update(registrations)
      .set({ status: 'expired', cancelledAt: at, cancelReason: PENDING_EXPIRED_REASON })
      .where(
        sql`${registrations.id} in (select rx.id from registrations rx where rx.status = 'pending_email' and rx.hold_expires_at <= ${at} order by rx.hold_expires_at limit ${CRON_PENDING_LIMIT})`,
      )
      .returning({ id: registrations.id }),
    db
      .update(groups)
      .set({ status: 'cancelled', cancelledAt: at })
      .where(
        and(
          eq(groups.status, 'pending_email'),
          inArray(
            groups.id,
            db
              .select({ id: registrations.groupId })
              .from(registrations)
              .where(
                and(
                  eq(registrations.status, 'expired'),
                  eq(registrations.cancelledAt, at),
                  eq(registrations.freeAgent, false),
                  isNotNull(registrations.groupId),
                ),
              ),
          ),
        ),
      ),
  ]
}
