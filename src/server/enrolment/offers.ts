import { and, eq, inArray, sql } from 'drizzle-orm'
import { formatAud } from '../../lib/time'
import { runBatch, type AppDb } from '../db'
import { groups, players, products, programmes, registrations } from '../db/schema'
import { getSettings } from '../content/settings'
import type { Mailer } from '../email'
import { HttpError } from '../http'
import {
  joinTargetRows,
  labelOfRow,
  offerEmail,
  offerNext,
  sendOfferEmails,
  sendQuietly,
  targetLabelColumns,
  type NotifyDeps,
  type OfferMade,
} from './core'
import { readOfferToken, type OfferSubject } from './tokens'

// Waitlist offers: the person's side (the /enrol/offer page: view, accept, decline) and the hourly cron that passes
// lapsed offers on. Offers are made by offerNext() in core.ts, whenever a spot frees up (a cancellation, a decline,
// a lapsed offer, a raised cap, an entry moved away) and by the cron for any product with room and a waitlist.

export type OfferState = 'live' | 'accepted' | 'gone'

export type OfferView = {
  state: OfferState
  firstName: string
  programme: string
  target: string
  reference: string
  teamName: string | null
  expiresAt: string | null
}

type OfferRow = {
  registrationId: string
  productId: string
  status: string | null
  offeredAt: string | null
  offerExpiresAt: string | null
  reference: string
  firstName: string
  email: string
  teamName: string | null
  programme: string
  target: string
  amountCents: number | null
}

/** The offer a subject names, from the registration (individual) or the captain's registration (team). One query. */
async function loadOffer(db: AppDb, subject: OfferSubject): Promise<OfferRow | null> {
  const base = joinTargetRows(
    db
      .select({
        registrationId: registrations.id,
        productId: registrations.productId,
        status: subject.type === 'group' ? groups.status : registrations.status,
        offeredAt: subject.type === 'group' ? groups.offeredAt : registrations.offeredAt,
        offerExpiresAt: subject.type === 'group' ? groups.offerExpiresAt : registrations.offerExpiresAt,
        reference: registrations.reference,
        firstName: players.firstName,
        email: players.email,
        teamName: sql<string | null>`${groups.name}`.as('team_name'),
        programme: sql<string>`${programmes.name}`.as('programme_name'),
        amountCents: registrations.amountCents,
        ...targetLabelColumns,
      })
      .from(registrations)
      .innerJoin(players, eq(players.id, registrations.playerId))
      .innerJoin(products, eq(products.id, registrations.productId))
      .innerJoin(programmes, eq(programmes.id, products.programmeId))
      .leftJoin(groups, eq(groups.id, registrations.groupId))
      .$dynamic(),
  )
  const row =
    subject.type === 'group'
      ? await base
          .where(
            and(
              eq(registrations.groupId, subject.id),
              eq(registrations.freeAgent, false),
              sql`${registrations.playerId} = ${groups.captainPlayerId}`,
            ),
          )
          .get()
      : await base.where(eq(registrations.id, subject.id)).get()
  return row ? { ...row, target: labelOfRow(row) } : null
}

const stateOf = (row: OfferRow, subject: OfferSubject, nowIso: string): OfferState => {
  if (row.offeredAt !== subject.offeredAt) return 'gone'
  if (row.status === 'offered' && row.offerExpiresAt && row.offerExpiresAt > nowIso) return 'live'
  if (row.status === 'confirmed' && !row.offerExpiresAt) return 'accepted'
  return 'gone'
}

const badLink = () => new HttpError(404, 'not_found', "That link isn't valid. Check you copied all of it from the email.")

/** What the offer page shows. */
export async function viewOffer(db: AppDb, secret: string, token: unknown, now = new Date()): Promise<OfferView> {
  const subject = await readOfferToken(secret, token)
  if (!subject) throw badLink()
  const row = await loadOffer(db, subject)
  if (!row) throw badLink()
  return {
    state: stateOf(row, subject, now.toISOString()),
    firstName: row.firstName,
    programme: row.programme,
    target: row.target,
    reference: row.reference,
    teamName: subject.type === 'group' ? row.teamName : null,
    expiresAt: row.offerExpiresAt,
  }
}

export type OfferDeps = NotifyDeps & { db: AppDb; now?: Date }

/** Accepts or declines an offer. Accepting confirms the spot; declining frees it for the next person. */
export async function respondToOffer(deps: OfferDeps, token: unknown, action: unknown): Promise<OfferView> {
  const { db } = deps
  const now = deps.now ?? new Date()
  const at = now.toISOString()
  if (action !== 'accept' && action !== 'decline') throw new HttpError(400, 'invalid_input', 'Choose accept or decline.')
  const subject = await readOfferToken(deps.secret, token)
  if (!subject) throw badLink()
  const row = await loadOffer(db, subject)
  if (!row) throw badLink()
  const state = stateOf(row, subject, at)
  const view = (s: OfferState): OfferView => ({
    state: s,
    firstName: row.firstName,
    programme: row.programme,
    target: row.target,
    reference: row.reference,
    teamName: subject.type === 'group' ? row.teamName : null,
    expiresAt: s === 'live' ? row.offerExpiresAt : null,
  })
  if (state === 'accepted' && action === 'accept') return view('accepted')
  if (state !== 'live') throw new HttpError(409, 'offer_gone', 'Sorry, this offer has lapsed or was already answered.')

  const accept = action === 'accept'
  const liveOffer = (t: typeof registrations | typeof groups) =>
    and(eq(t.status, 'offered'), eq(t.offeredAt, subject.offeredAt), sql`${t.offerExpiresAt} > ${at}`)
  const regSet = accept
    ? { status: 'confirmed' as const, offerExpiresAt: null }
    : { status: 'cancelled' as const, cancelledAt: at, cancelReason: 'Declined the waitlist offer', offerExpiresAt: null }
  const results =
    subject.type === 'group'
      ? await runBatch(db, [
          db
            .update(groups)
            .set(accept ? { status: 'confirmed', offerExpiresAt: null } : { status: 'cancelled', cancelledAt: at, offerExpiresAt: null })
            .where(and(eq(groups.id, subject.id), liveOffer(groups)))
            .returning({ id: groups.id }),
          db
            .update(registrations)
            .set(regSet)
            .where(
              and(
                eq(registrations.groupId, subject.id),
                eq(registrations.freeAgent, false),
                eq(registrations.status, 'offered'),
                sql`(select g.status from groups g where g.id = ${subject.id}) = ${accept ? 'confirmed' : 'cancelled'}`,
              ),
            )
            .returning({ id: registrations.id }),
        ])
      : await runBatch(db, [
          db
            .update(registrations)
            .set(regSet)
            .where(and(eq(registrations.id, subject.id), liveOffer(registrations)))
            .returning({ id: registrations.id }),
        ])
  if ((results[0] as unknown[]).length === 0)
    throw new HttpError(409, 'offer_gone', 'Sorry, this offer has lapsed or was already answered.')

  const what = { programme: row.programme, target: row.target }
  if (accept) {
    const payid = row.amountCents ? (await getSettings(db)).payid : null
    await sendQuietly(
      () =>
        deps.mailer.sendEmail(
          row.email,
          'enrolment.confirmed',
          {
            name: row.firstName,
            ...what,
            reference: row.reference,
            teamName: subject.type === 'group' ? row.teamName : null,
            amount: row.amountCents ? formatAud(row.amountCents) : null,
            payid: payid?.payId ? payid : null,
          },
          // Accepting an offer proves the address (it came from the offer email).
          { priority: true },
        ),
      'confirmation',
    )
    return view('accepted')
  }
  await sendOfferEmails(deps, await offerNext(db, row.productId, now), what)
  return view('gone')
}

// ── Cron ──────────────────────────────────────────────────────────────────────

/**
 * Per-run bounds. The cron shares one invocation's 50 D1 queries with the outbox drain, invites and analytics, so
 * an idle run costs one query and a busy one about 20 at most (1 + 3 + 1 + 5 + one email insert each). Anything
 * left over is picked up next hour. A busy run also shrinks the drain and defers analytics (src/server/cron.ts).
 */
export const CRON_LAPSED_LIMIT = 3
export const CRON_PRODUCT_LIMIT = 1
export const CRON_OFFER_LIMIT = 3

/**
 * An offer whose email hasn't gone yet (over the day's email cap) isn't lapsed: its hold starts when the email is
 * sent (mailer.ts OfferHold). `alias` is the registrations or groups alias in the query.
 */
const emailSent = (alias: string) =>
  sql.raw(
    `not exists (select 1 from email_outbox eo where eo.status = 'queued' and eo.template = 'enrolment.offer' and json_extract(eo.payload, '$.hold.id') = ${alias}.id)`,
  )

/** Products with a lapsed offer, or with a waitlist and room for someone on it (one query). */
async function productsNeedingWork(db: AppDb, at: string, limit: number) {
  const capP = sql`coalesce(${products.capacity}, ${programmes.capPlayers})`
  const capT = sql`coalesce(${products.capacityTeams}, ${programmes.capTeams})`
  const holdingP = sql`(select count(*) from registrations r2 where r2.product_id = ${products.id} and r2.status in ('pending_payment', 'paid', 'confirmed', 'offered'))`
  const holdingT = sql`(select count(*) from groups g2 where g2.product_id = ${products.id} and g2.status in ('confirmed', 'offered'))`
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .innerJoin(programmes, eq(programmes.id, products.programmeId))
    .where(
      sql`exists (select 1 from registrations r0 where r0.product_id = ${products.id} and r0.status = 'offered' and r0.offer_expires_at <= ${at} and (r0.group_id is null or r0.free_agent = 1) and ${emailSent('r0')})
        or exists (select 1 from groups g0 where g0.product_id = ${products.id} and g0.status = 'offered' and g0.offer_expires_at <= ${at} and ${emailSent('g0')})
        or (exists (select 1 from registrations r where r.product_id = ${products.id} and r.status = 'waitlist' and (r.group_id is null or r.free_agent = 1)) and (${capP} is null or ${holdingP} < ${capP}))
        or (exists (select 1 from groups g where g.product_id = ${products.id} and g.status = 'waitlist') and (${capT} is null or ${holdingT} < ${capT}) and (${capP} is null or ${holdingP} < ${capP}))`,
    )
    .limit(limit)
    .all()
  return rows.map((r) => r.id)
}

export type EnrolmentCronResult = { expired: number; offered: number; emailsQueued: number }

/**
 * Hourly: lapsed offers expire (the person is told) and the spot passes down the list; a product with room and a
 * waitlist gets its offers. Emails are queued in one batch and sent by drainOutbox afterwards. Bounded per run
 * (CRON_*_LIMIT); an idle run is one query.
 */
export async function runEnrolmentCron(
  db: AppDb,
  deps: { mailer: Pick<Mailer, 'queueStatement'>; secret: string; siteUrl: string },
  now = new Date(),
): Promise<EnrolmentCronResult> {
  const at = now.toISOString()
  const needing = await productsNeedingWork(db, at, CRON_PRODUCT_LIMIT)
  if (needing.length === 0) return { expired: 0, offered: 0, emailsQueued: 0 }

  const lapsedRegs = sql`select r.id from registrations r where r.status = 'offered' and r.offer_expires_at <= ${at} and (r.group_id is null or r.free_agent = 1) and ${emailSent('r')} order by r.offer_expires_at limit ${CRON_LAPSED_LIMIT}`
  const lapsedGroups = sql`select g.id from groups g where g.status = 'offered' and g.offer_expires_at <= ${at} and ${emailSent('g')} order by g.offer_expires_at limit ${CRON_LAPSED_LIMIT}`
  const reason = 'Offer lapsed'
  const [regs, grps, captains] = (await runBatch(db, [
    db
      .update(registrations)
      .set({ status: 'expired', cancelledAt: at, cancelReason: reason, offerExpiresAt: null })
      .where(sql`${registrations.id} in (${lapsedRegs})`)
      .returning({ id: registrations.id, productId: registrations.productId }),
    db
      .update(groups)
      .set({ status: 'cancelled', cancelledAt: at, offerExpiresAt: null })
      .where(sql`${groups.id} in (${lapsedGroups})`)
      .returning({ id: groups.id, productId: groups.productId }),
    db
      .update(registrations)
      .set({ status: 'expired', cancelledAt: at, cancelReason: reason, offerExpiresAt: null })
      .where(
        and(
          eq(registrations.status, 'offered'),
          eq(registrations.freeAgent, false),
          sql`${registrations.groupId} in (select g.id from groups g where g.status = 'cancelled' and g.cancelled_at = ${at})`,
        ),
      )
      .returning({ id: registrations.id, productId: registrations.productId }),
  ])) as { id: string; productId: string }[][]

  const expiredIds = [...regs!, ...captains!].map((r) => r.id)
  const emails: ReturnType<typeof deps.mailer.queueStatement>[] = []
  if (expiredIds.length > 0) {
    const rows = await joinTargetRows(
      db
        .select({
          email: players.email,
          firstName: players.firstName,
          reference: registrations.reference,
          teamName: sql<string | null>`${groups.name}`.as('team_name'),
          freeAgent: registrations.freeAgent,
          programme: sql<string>`${programmes.name}`.as('programme_name'),
          ...targetLabelColumns,
        })
        .from(registrations)
        .innerJoin(players, eq(players.id, registrations.playerId))
        .innerJoin(products, eq(products.id, registrations.productId))
        .innerJoin(programmes, eq(programmes.id, products.programmeId))
        .leftJoin(groups, eq(groups.id, registrations.groupId))
        .$dynamic(),
    )
      .where(inArray(registrations.id, expiredIds))
      .all()
    for (const r of rows)
      emails.push(
        deps.mailer.queueStatement(
          r.email,
          'enrolment.cancelled',
          {
            name: r.firstName,
            programme: r.programme,
            target: labelOfRow(r),
            reference: r.reference,
            teamName: r.freeAgent ? null : r.teamName,
            reason: "The waitlist offer wasn't accepted in time, so the spot has gone to the next person.",
          },
          now,
        ),
      )
  }

  // Products whose offers just lapsed come first; then the others needing work.
  const touched = [...regs!, ...grps!].map((r) => r.productId)
  const productIds = [...new Set([...touched, ...needing])].slice(0, CRON_PRODUCT_LIMIT)
  let offered = 0
  for (const productId of productIds) {
    // Bounded: CRON_PRODUCT_LIMIT products, each one query, one batch and one query.
    const offers: OfferMade[] = await offerNext(db, productId, now, CRON_OFFER_LIMIT - offered)
    for (const offer of offers)
      emails.push(
        deps.mailer.queueStatement(
          offer.email,
          'enrolment.offer',
          await offerEmail(deps, offer, offer.what ?? { programme: '', target: '' }),
          now,
        ),
      )
    offered += offers.length
  }
  if (emails.length > 0) await runBatch(db, emails)
  return { expired: regs!.length + grps!.length, offered, emailsQueued: emails.length }
}
