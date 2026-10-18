import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import type { SQLiteSelect } from 'drizzle-orm/sqlite-core'
import { effectiveCap, enrolmentOpen, inherit } from '../../lib/programmes'
import { defaultFields } from '../../lib/enrolment/defaults'
import { activeFields, type FormField } from '../../lib/enrolment/forms'
import { PRODUCT_KIND, sessionLabel, targetLabel, type TargetKind, type TargetRef } from '../../lib/enrolment/targets'
import { runBatch, type AppDb } from '../db'
import {
  developmentTerms,
  enrolmentForms,
  events,
  groups,
  players,
  products,
  programmeSessions,
  programmes,
  registrations,
  seasons,
  type Product,
  type ProgrammeKind,
  type ProgrammeStatus,
} from '../db/schema'
import { HttpError } from '../http'
import type { Mailer } from '../email'
import { offerToken, offerUrl } from './tokens'

// The shared core of enrolment (docs/admin.md §3.7, docs/api/enrolment.md): loading a target with its programme and
// product, the effective settings (product override → programme default), and the cap-safe SQL.
//
// Caps without races: an entry is inserted holding a spot and, in the same db.batch() (one transaction, and D1 runs
// one at a time), a conditional UPDATE moves it to the waitlist (or a conditional DELETE refuses it) when the count
// of spot-holding rows is now over the cap, or when others are already waiting. So two people can't both take the
// last spot: whichever batch runs second sees the first one's row.

/** registrations.status values that hold a spot (spotHoldingStatuses), as SQL. */
export const HOLDING_SQL = sql.raw(`('pending_payment', 'paid', 'confirmed', 'offered')`)
/** groups.status values that hold a spot. */
export const GROUP_HOLDING_SQL = sql.raw(`('confirmed', 'offered')`)

/** A registration that is someone's own entry (individual or free agent), not the captain row of a team entry. */
export const INDIVIDUAL_SQL = sql.raw(`(group_id is null or free_agent = 1)`)

/** A big number standing in for "no cap" inside LIMIT arithmetic. */
const NO_CAP = 1_000_000

/**
 * At most this many individuals and this many teams are offered spots by one offerNext() call. Each offer emailed
 * from a request costs a few D1 queries, so a cap raised by 30 mustn't send 30 emails in one request; the hourly
 * cron offers the rest (docs/api/enrolment.md).
 */
export const OFFER_BATCH_MAX = 5

export type ProgrammeInfo = {
  id: string
  kind: ProgrammeKind
  code: string
  name: string
  slug: string
  status: ProgrammeStatus
  enrolmentOpen: boolean
  enrolmentOpensAt: string | null
  enrolmentClosesAt: string | null
  enrolmentFormId: string | null
  capTeams: number | null
  capPlayers: number | null
  priceCents: number | null
  allowTeamEntries: boolean
  allowFreeAgents: boolean
  waitlistEnabled: boolean
  waitlistOfferHours: number
  /** Null = automatic (on when capped). */
  enrolmentEmailConfirm: boolean | null
  ageMin: number | null
  ageMax: number | null
}

export const programmeColumns = {
  id: programmes.id,
  kind: programmes.kind,
  code: programmes.code,
  name: programmes.name,
  slug: programmes.slug,
  status: programmes.status,
  enrolmentOpen: programmes.enrolmentOpen,
  enrolmentOpensAt: programmes.enrolmentOpensAt,
  enrolmentClosesAt: programmes.enrolmentClosesAt,
  enrolmentFormId: programmes.enrolmentFormId,
  capTeams: programmes.capTeams,
  capPlayers: programmes.capPlayers,
  priceCents: programmes.priceCents,
  allowTeamEntries: programmes.allowTeamEntries,
  allowFreeAgents: programmes.allowFreeAgents,
  waitlistEnabled: programmes.waitlistEnabled,
  waitlistOfferHours: programmes.waitlistOfferHours,
  enrolmentEmailConfirm: programmes.enrolmentEmailConfirm,
  ageMin: programmes.ageMin,
  ageMax: programmes.ageMax,
}

/** One enrolment target with what's needed to take an entry. */
export type Target = {
  ref: TargetRef
  /** "TNL Q4 2026", "Wed 21 Oct 2026, 6:30–8pm", "Term 4 2026", "Tempe Cup 2026". */
  label: string
  startsOn: string | null
  endsOn: string | null
  /** Can this target take entries at all (not archived, cancelled or over)? With the reason when not. */
  closedReason: string | null
  programme: ProgrammeInfo
  product: Product | null
}

const productColumn = {
  season: products.seasonId,
  session: products.sessionId,
  term: products.termId,
  event: products.eventId,
} as const

/**
 * The columns targetLabel() reads, for any query that has `products` in it and joins the four target tables with
 * joinTargetRows(). Aliased, so they can't collide with other joined columns inside a db.batch().
 */
export const targetLabelColumns = {
  lblProduct: sql<string>`${products.name}`.as('lbl_product'),
  lblSeason: sql<string | null>`${seasons.name}`.as('lbl_season'),
  lblSessionDate: sql<string | null>`${programmeSessions.date}`.as('lbl_session_date'),
  lblSessionStart: sql<string | null>`${programmeSessions.startTime}`.as('lbl_session_start'),
  lblSessionEnd: sql<string | null>`${programmeSessions.endTime}`.as('lbl_session_end'),
  lblSessionTitle: sql<string | null>`${programmeSessions.title}`.as('lbl_session_title'),
  lblTerm: sql<string | null>`${developmentTerms.name}`.as('lbl_term'),
  lblEvent: sql<string | null>`${events.name}`.as('lbl_event'),
}

/** Joins a product's season, session, term or event (one of them matches), for targetLabelColumns. */
export const joinTargetRows = <T extends SQLiteSelect>(q: T) =>
  q
    .leftJoin(seasons, eq(seasons.id, products.seasonId))
    .leftJoin(programmeSessions, eq(programmeSessions.id, products.sessionId))
    .leftJoin(developmentTerms, eq(developmentTerms.id, products.termId))
    .leftJoin(events, eq(events.id, products.eventId))

type LabelRow = { [K in keyof typeof targetLabelColumns]: (typeof targetLabelColumns)[K]['_']['type'] }

/** The shared target label (lib/enrolment/targets.ts targetLabel) from a row with targetLabelColumns. */
export const labelOfRow = (r: LabelRow) =>
  targetLabel({
    productName: r.lblProduct,
    seasonName: r.lblSeason,
    sessionDate: r.lblSessionDate,
    sessionStart: r.lblSessionStart,
    sessionEnd: r.lblSessionEnd,
    sessionTitle: r.lblSessionTitle,
    termName: r.lblTerm,
    eventName: r.lblEvent,
  })

/** Which target a product is for. */
export function refOfProduct(p: Pick<Product, 'seasonId' | 'sessionId' | 'termId' | 'eventId'>): TargetRef | null {
  if (p.seasonId) return { kind: 'season', id: p.seasonId }
  if (p.sessionId) return { kind: 'session', id: p.sessionId }
  if (p.termId) return { kind: 'term', id: p.termId }
  if (p.eventId) return { kind: 'event', id: p.eventId }
  return null
}

/** Loads a target with its programme and product (one query). Null if it doesn't exist. */
export async function loadTarget(db: AppDb, ref: TargetRef, today: string): Promise<Target | null> {
  const col = productColumn[ref.kind]
  if (ref.kind === 'season') {
    const row = await db
      .select({ s: seasons, p: programmeColumns, product: products })
      .from(seasons)
      .innerJoin(programmes, eq(programmes.id, seasons.leagueId))
      .leftJoin(products, eq(col, seasons.id))
      .where(eq(seasons.id, ref.id))
      .get()
    if (!row) return null
    return {
      ref,
      label: row.s.name,
      startsOn: row.s.startDate,
      endsOn: null,
      closedReason: row.s.status === 'archived' ? 'This season has finished.' : null,
      programme: row.p,
      product: row.product,
    }
  }
  if (ref.kind === 'session') {
    const row = await db
      .select({ s: programmeSessions, p: programmeColumns, product: products })
      .from(programmeSessions)
      .innerJoin(programmes, eq(programmes.id, programmeSessions.programmeId))
      .leftJoin(products, eq(col, programmeSessions.id))
      .where(and(eq(programmeSessions.id, ref.id), isNull(programmeSessions.termId)))
      .get()
    if (!row) return null
    return {
      ref,
      label: sessionLabel(row.s),
      startsOn: row.s.date,
      endsOn: row.s.date,
      closedReason:
        row.s.status === 'cancelled'
          ? 'This session is cancelled.'
          : row.s.status === 'postponed'
            ? 'This session is postponed.'
            : row.s.date < today
              ? 'This session has already happened.'
              : null,
      programme: row.p,
      product: row.product,
    }
  }
  if (ref.kind === 'term') {
    const row = await db
      .select({ t: developmentTerms, p: programmeColumns, product: products })
      .from(developmentTerms)
      .innerJoin(programmes, eq(programmes.id, developmentTerms.programmeId))
      .leftJoin(products, eq(col, developmentTerms.id))
      .where(eq(developmentTerms.id, ref.id))
      .get()
    if (!row) return null
    const end = row.t.endDate ?? row.t.startDate
    return {
      ref,
      label: row.t.name,
      startsOn: row.t.startDate,
      endsOn: row.t.endDate,
      closedReason: row.t.status === 'cancelled' ? 'This term is cancelled.' : end < today ? 'This term has finished.' : null,
      programme: row.p,
      product: row.product,
    }
  }
  const row = await db
    .select({ e: events, p: programmeColumns, product: products })
    .from(events)
    .innerJoin(programmes, eq(programmes.id, events.programmeId))
    .leftJoin(products, eq(col, events.id))
    .where(eq(events.id, ref.id))
    .get()
  if (!row) return null
  const end = row.e.endDate ?? row.e.startDate
  return {
    ref,
    label: row.e.name,
    startsOn: row.e.startDate,
    endsOn: row.e.endDate,
    closedReason: row.e.status === 'cancelled' ? 'This event is cancelled.' : end < today ? 'This event is over.' : null,
    programme: row.p,
    product: row.product,
  }
}

/** The product row for a target, created on first use (one per target; a concurrent create is harmless). */
export async function ensureProduct(db: AppDb, target: Target, actorId: string | null = null): Promise<Product> {
  if (target.product) return target.product
  const col = productColumn[target.ref.kind]
  const targetColumn = { [`${target.ref.kind}Id`]: target.ref.id }
  await db
    .insert(products)
    .values({
      kind: PRODUCT_KIND[target.ref.kind],
      name: target.label,
      slug: `${target.ref.kind}-${target.ref.id}`,
      priceCents: target.programme.priceCents ?? 0,
      startsOn: target.startsOn,
      endsOn: target.endsOn,
      programmeId: target.programme.id,
      paymentMethods: ['payid'],
      active: true,
      updatedBy: actorId,
      ...targetColumn,
    })
    .onConflictDoNothing()
  const product = await db.select().from(products).where(eq(col, target.ref.id)).get()
  if (!product) throw new Error(`ensureProduct: no product for ${target.ref.kind} ${target.ref.id}`)
  target.product = product
  return product
}

export type Effective = {
  capPlayers: number | null
  capTeams: number | null
  waitlistEnabled: boolean
  offerHours: number
  allowTeamEntries: boolean
  allowFreeAgents: boolean
  formId: string | null
  /** What each person owes (AUD cents); null = no fee. */
  amountCents: number | null
  /** Public entries hold no spot until the person clicks the link emailed to them (docs/admin.md §3.7). */
  emailConfirm: boolean
}

/** The settings that apply to one target: the product's overrides, else the programme's defaults. */
export function effective(programme: ProgrammeInfo, product: Product | null): Effective {
  const capPlayers = effectiveCap(product?.capacity, programme.capPlayers)
  const capTeams = effectiveCap(product?.capacityTeams, programme.capTeams)
  return {
    capPlayers,
    capTeams,
    waitlistEnabled: inherit(product?.waitlistEnabled, programme.waitlistEnabled),
    offerHours: inherit(product?.waitlistOfferHours, programme.waitlistOfferHours),
    allowTeamEntries: inherit(product?.allowTeamEntries, programme.allowTeamEntries),
    allowFreeAgents: inherit(product?.allowFreeAgents, programme.allowFreeAgents),
    formId: product?.formId ?? programme.enrolmentFormId,
    amountCents: product ? product.priceCents || null : programme.priceCents || null,
    // Instance override → programme setting → automatic: on when anything is capped (a spot is worth taking).
    emailConfirm: product?.emailConfirm ?? programme.enrolmentEmailConfirm ?? (capPlayers !== null || capTeams !== null),
  }
}

export const isOpen = (target: Target, nowIso: string) =>
  !target.closedReason &&
  enrolmentOpen(
    {
      open: target.programme.enrolmentOpen,
      status: target.programme.status,
      opensAt: target.programme.enrolmentOpensAt,
      closesAt: target.programme.enrolmentClosesAt,
    },
    target.product ? { active: target.product.active, opensAt: target.product.opensAt, closesAt: target.product.closesAt } : null,
    nowIso,
  )

export type ResolvedForm = { id: string | null; version: number | null; name: string; fields: FormField[]; confirmationText: string | null }

/** The form a target uses: the product's, else the programme's, else the kind's default questions. */
export async function resolveForm(db: AppDb, formId: string | null, kind: ProgrammeKind): Promise<ResolvedForm> {
  if (formId) {
    const form = await db.select().from(enrolmentForms).where(eq(enrolmentForms.id, formId)).get()
    if (form) return { id: form.id, version: form.version, name: form.name, fields: form.fields, confirmationText: form.confirmationText }
  }
  return { id: null, version: null, name: 'Default questions', fields: activeFields(defaultFields(kind)), confirmationText: null }
}

// ── Cap-safe SQL ──────────────────────────────────────────────────────────────

const holdingPlayers = (productId: string) =>
  sql`(select count(*) from registrations r2 where r2.product_id = ${productId} and r2.status in ${HOLDING_SQL})`
const holdingTeams = (productId: string) =>
  sql`(select count(*) from groups g2 where g2.product_id = ${productId} and g2.status in ${GROUP_HOLDING_SQL})`

/** True when this individual entry must wait: over the player cap, or others are already waiting. */
export function individualMustWait(productId: string, registrationId: string, capPlayers: number | null): SQL {
  if (capPlayers === null) return sql`0`
  return sql`(${holdingPlayers(productId)} > ${capPlayers} or exists (select 1 from registrations r3 where r3.product_id = ${productId} and r3.status = 'waitlist' and r3.id <> ${registrationId} and (r3.group_id is null or r3.free_agent = 1)))`
}

/** True when this team entry must wait: over the team cap or the player cap, or other teams are already waiting. */
export function teamMustWait(productId: string, groupId: string, caps: { capTeams: number | null; capPlayers: number | null }): SQL {
  const parts: SQL[] = []
  if (caps.capTeams !== null) {
    parts.push(sql`${holdingTeams(productId)} > ${caps.capTeams}`)
    parts.push(sql`exists (select 1 from groups g3 where g3.product_id = ${productId} and g3.status = 'waitlist' and g3.id <> ${groupId})`)
  }
  if (caps.capPlayers !== null) parts.push(sql`${holdingPlayers(productId)} > ${caps.capPlayers}`)
  return parts.length === 0 ? sql`0` : sql`(${sql.join(parts, sql` or `)})`
}

const nextRegistrationPosition = (productId: string) =>
  sql`(select coalesce(max(r4.waitlist_position), 0) + 1 from registrations r4 where r4.product_id = ${productId} and r4.status = 'waitlist')`
const nextGroupPosition = (productId: string) =>
  sql`(select coalesce(max(g4.waitlist_position), 0) + 1 from groups g4 where g4.product_id = ${productId} and g4.status = 'waitlist')`

/** Why a confirmed-email entry that found no room (waitlist off) was cancelled. */
export const FULL_ON_CONFIRM = 'Full when the email address was confirmed'

/**
 * The statements that settle a just-inserted (spot-holding) entry against the caps, for the same batch. With the
 * waitlist on, an entry over the cap moves to the end of the waitlist; with it off, the entry is deleted, or with
 * `refuse: 'cancel'` kept as cancelled (an entry that already existed: a confirmed email address). The caller reads
 * the row back to see which happened.
 */
export function settleStatements(
  db: AppDb,
  entry: { productId: string; registrationId: string; groupId: string | null },
  eff: Pick<Effective, 'capPlayers' | 'capTeams' | 'waitlistEnabled'>,
  opts: { refuse?: 'delete' | 'cancel'; at?: string } = {},
) {
  const { productId, registrationId, groupId } = entry
  const at = opts.at ?? new Date().toISOString()
  if (groupId) {
    const wait = teamMustWait(productId, groupId, eff)
    if (!eff.waitlistEnabled && opts.refuse === 'cancel')
      return [
        db
          .update(groups)
          .set({ status: 'cancelled', cancelledAt: at })
          .where(and(eq(groups.id, groupId), wait)),
        db
          .update(registrations)
          .set({ status: 'cancelled', cancelledAt: at, cancelReason: FULL_ON_CONFIRM })
          .where(and(eq(registrations.id, registrationId), sql`(select status from groups g5 where g5.id = ${groupId}) = 'cancelled'`)),
      ]
    return eff.waitlistEnabled
      ? [
          db
            .update(groups)
            .set({ status: 'waitlist', waitlistPosition: nextGroupPosition(productId) })
            .where(and(eq(groups.id, groupId), wait)),
          db
            .update(registrations)
            .set({ status: 'waitlist', waitlistPosition: null })
            .where(and(eq(registrations.id, registrationId), sql`(select status from groups g5 where g5.id = ${groupId}) = 'waitlist'`)),
        ]
      : [
          // Deleting the group sets the registration's group_id to null; the registration then goes too.
          db.delete(groups).where(and(eq(groups.id, groupId), wait)),
          db.delete(registrations).where(and(eq(registrations.id, registrationId), isNull(registrations.groupId))),
        ]
  }
  const wait = individualMustWait(productId, registrationId, eff.capPlayers)
  if (!eff.waitlistEnabled && opts.refuse === 'cancel')
    return [
      db
        .update(registrations)
        .set({ status: 'cancelled', cancelledAt: at, cancelReason: FULL_ON_CONFIRM })
        .where(and(eq(registrations.id, registrationId), wait)),
    ]
  return eff.waitlistEnabled
    ? [
        db
          .update(registrations)
          .set({ status: 'waitlist', waitlistPosition: nextRegistrationPosition(productId) })
          .where(and(eq(registrations.id, registrationId), wait)),
      ]
    : [db.delete(registrations).where(and(eq(registrations.id, registrationId), wait))]
}

/**
 * An entry's place on its waitlist, 1-based, counted in waitlist order (position, then entry time). Stored positions
 * are only an ordering key and keep gaps when someone leaves the list, so this rank is what people and the admin are
 * shown ("number 2"), never the stored number. A read-only scalar subquery, safe inside a batch.
 */
export function waitlistRankSql(kind: 'registration' | 'group', productId: string, id: string): SQL {
  return kind === 'group'
    ? sql`(select count(*) from groups gw, groups gm where gm.id = ${id} and gw.product_id = ${productId} and gw.status = 'waitlist' and (coalesce(gw.waitlist_position, 1000000000) < coalesce(gm.waitlist_position, 1000000000) or (coalesce(gw.waitlist_position, 1000000000) = coalesce(gm.waitlist_position, 1000000000) and (gw.created_at < gm.created_at or (gw.created_at = gm.created_at and gw.id <= gm.id)))))`
    : sql`(select count(*) from registrations rw, registrations rm where rm.id = ${id} and rw.product_id = ${productId} and rw.status = 'waitlist' and (rw.group_id is null or rw.free_agent = 1) and (coalesce(rw.waitlist_position, 1000000000) < coalesce(rm.waitlist_position, 1000000000) or (coalesce(rw.waitlist_position, 1000000000) = coalesce(rm.waitlist_position, 1000000000) and (rw.created_at < rm.created_at or (rw.created_at = rm.created_at and rw.id <= rm.id)))))`
}

/** The same rank in JavaScript, for lists already loaded (the admin's view): id -> 1-based place. */
export function waitlistRanks<T extends { id: string; status: string; waitlistPosition: number | null; createdAt: string }>(rows: T[]) {
  const ranks = new Map<string, number>()
  const key = (r: T) => r.waitlistPosition ?? 1_000_000_000
  rows
    .filter((r) => r.status === 'waitlist')
    .toSorted((a, b) => key(a) - key(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .forEach((r, i) => ranks.set(r.id, i + 1))
  return ranks
}

// ── Offers ────────────────────────────────────────────────────────────────────

export type OfferMade = {
  type: 'registration' | 'group'
  /** The registration or group id the token names. */
  id: string
  registrationId: string
  reference: string
  email: string
  firstName: string
  teamName: string | null
  offeredAt: string
  expiresAt: string
  /** How long the offer is held once its email goes (the programme's or instance's offer hours). */
  hours: number
  /** The programme and target names, for the email (offersMadeAt fills them in). */
  what?: { programme: string; target: string }
}

/** The product with its programme's settings and its target's label (one query), for offers and admin actions. */
export async function loadProduct(db: AppDb, productId: string) {
  const row = await joinTargetRows(
    db
      .select({ product: products, programme: programmeColumns, ...targetLabelColumns })
      .from(products)
      .innerJoin(programmes, eq(programmes.id, products.programmeId))
      .$dynamic(),
  )
    .where(eq(products.id, productId))
    .get()
  return row ? { product: row.product, programme: row.programme, label: labelOfRow(row) } : null
}

/**
 * Offers free spots to the front of the waitlist (individuals first, then teams), each held for the offer hours.
 * Atomic: the number offered is worked out inside the UPDATE, so concurrent calls can't over-offer. At most
 * `max` individuals and `max` teams per call. Returns the offers made, for the caller to email (sendOfferEmails).
 * One query, one batch of three statements, one query.
 */
export async function offerNext(db: AppDb, productId: string, now: Date, max = OFFER_BATCH_MAX): Promise<OfferMade[]> {
  if (max <= 0) return []
  const loaded = await loadProduct(db, productId)
  if (!loaded) return []
  const eff = effective(loaded.programme, loaded.product)
  const at = now.toISOString()
  const expires = new Date(now.getTime() + Math.max(1, eff.offerHours) * 3_600_000).toISOString()
  const playerRoom = sql`coalesce(${eff.capPlayers} - ${holdingPlayers(productId)}, ${NO_CAP})`
  const teamRoom = sql`min(coalesce(${eff.capTeams} - ${holdingTeams(productId)}, ${NO_CAP}), coalesce(${eff.capPlayers} - ${holdingPlayers(productId)}, ${NO_CAP}))`
  const offered = { status: 'offered' as const, offeredAt: at, offerExpiresAt: expires, waitlistPosition: null }
  const hours = Math.max(1, eff.offerHours)
  const [individuals, , captains] = (await runBatch(db, [
    db
      .update(registrations)
      .set(offered)
      .where(
        sql`${registrations.id} in (select r6.id from registrations r6 where r6.product_id = ${productId} and r6.status = 'waitlist' and (r6.group_id is null or r6.free_agent = 1) order by r6.waitlist_position is null, r6.waitlist_position, r6.created_at limit min(max(0, ${playerRoom}), ${max}))`,
      )
      .returning({ id: registrations.id }),
    db
      .update(groups)
      .set(offered)
      .where(
        sql`${groups.id} in (select g6.id from groups g6 where g6.product_id = ${productId} and g6.status = 'waitlist' order by g6.waitlist_position is null, g6.waitlist_position, g6.created_at limit min(max(0, ${teamRoom}), ${max}))`,
      ),
    db
      .update(registrations)
      .set({ status: 'offered', offeredAt: at, offerExpiresAt: expires })
      .where(
        and(
          eq(registrations.productId, productId),
          eq(registrations.status, 'waitlist'),
          eq(registrations.freeAgent, false),
          sql`${registrations.groupId} in (select g7.id from groups g7 where g7.product_id = ${productId} and g7.status = 'offered' and g7.offered_at = ${at})`,
        ),
      )
      .returning({ id: registrations.id }),
  ])) as { id: string }[][]
  // Exactly the rows this call offered (another call in the same millisecond can't be counted twice).
  const ids = [...individuals!, ...captains!].map((x) => x.id)
  return ids.length === 0 ? [] : offersMadeAt(db, productId, at, hours, ids)
}

/** The offers made on one product at one instant (optionally only these registrations), with what the emails need (one query). */
export async function offersMadeAt(db: AppDb, productId: string, at: string, hours: number, ids?: string[]): Promise<OfferMade[]> {
  const rows = await joinTargetRows(
    db
      .select({
        registrationId: registrations.id,
        reference: registrations.reference,
        freeAgent: registrations.freeAgent,
        groupId: registrations.groupId,
        groupName: groups.name,
        expiresAt: registrations.offerExpiresAt,
        email: players.email,
        firstName: players.firstName,
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
    .where(
      and(
        eq(registrations.productId, productId),
        eq(registrations.status, 'offered'),
        eq(registrations.offeredAt, at),
        ids ? inArray(registrations.id, ids) : undefined,
      ),
    )
    .all()
  return rows.map((r) => {
    const team = !!r.groupId && !r.freeAgent
    return {
      type: team ? 'group' : 'registration',
      id: team ? r.groupId! : r.registrationId,
      registrationId: r.registrationId,
      reference: r.reference,
      email: r.email,
      firstName: r.firstName,
      teamName: team ? r.groupName : null,
      offeredAt: at,
      expiresAt: r.expiresAt ?? at,
      hours,
      what: { programme: r.programme, target: labelOfRow(r) },
    }
  })
}

export type NotifyDeps = { mailer: Pick<Mailer, 'sendEmail' | 'queueStatement'>; secret: string; siteUrl: string }

/** The offer email's data for one offer. */
export async function offerEmail(
  deps: Pick<NotifyDeps, 'secret' | 'siteUrl'>,
  offer: OfferMade,
  what: { programme: string; target: string },
) {
  const token = await offerToken(deps.secret, { type: offer.type, id: offer.id, offeredAt: offer.offeredAt })
  return {
    name: offer.firstName,
    programme: what.programme,
    target: what.target,
    reference: offer.reference,
    url: offerUrl(deps.siteUrl, token),
    expiresAt: offer.expiresAt,
    teamName: offer.teamName,
    // The mailer starts the hold from the moment this email goes (mailer.ts OfferHold).
    hold: { type: offer.type, id: offer.id, offeredAt: offer.offeredAt, hours: offer.hours },
  }
}

/** Emails offers now (admin actions). A failed or unconfigured send leaves the offer standing; the admin can resend. */
export async function sendOfferEmails(deps: NotifyDeps, offers: OfferMade[], what: { programme: string; target: string }) {
  let sent = 0
  for (const offer of offers) {
    try {
      await deps.mailer.sendEmail(offer.email, 'enrolment.offer', await offerEmail(deps, offer, what))
      sent++
    } catch (e) {
      console.warn(`[enrolment] offer email for ${offer.reference} not sent: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return sent
}

/** Sends an email without letting a mail problem fail the enrolment (it's in the outbox either way). */
export async function sendQuietly(fn: () => Promise<unknown>, what: string) {
  try {
    await fn()
    return true
  } catch (e) {
    console.warn(`[enrolment] ${what} email not sent: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `That ${what} doesn't exist (it may have been deleted).`)
export const invalid = (message: string, details?: Record<string, unknown>) => new HttpError(400, 'invalid_input', message, details)

export type { TargetKind }
