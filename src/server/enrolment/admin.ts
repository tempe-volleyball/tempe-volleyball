import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { entryTypesFor } from '../../lib/enrolment/defaults'
import type { FormEntryType, FormField } from '../../lib/enrolment/forms'
import { isTargetKind, sessionLabel, TARGET_FOR_PROGRAMME, type TargetKind, type TargetRef } from '../../lib/enrolment/targets'
import { enrolmentsCsv } from '../../lib/enrolment/csv'
import { isEmail, isPhone, normaliseEmail, validateEnrolment } from '../../lib/enrolment/validate'
import { programmePath } from '../../lib/programmes'
import { sydneyDate } from '../../lib/time'
import { tags, type PurgeTargets } from '../cache'
import { audit, auditEntry, isUniqueFailure, optionalText, type Editor } from '../content/common'
import { getSettings } from '../content/settings'
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
  user,
  type Product,
  type ProgrammeKind,
} from '../db/schema'
import type { Mailer } from '../email'
import { HttpError } from '../http'
import {
  effective,
  ensureProduct,
  invalid,
  isOpen,
  joinTargetRows,
  labelOfRow,
  loadProduct,
  loadTarget,
  notFound,
  offerEmail,
  offerNext,
  offersMadeAt,
  programmeColumns,
  refOfProduct,
  resolveForm,
  sendOfferEmails,
  sendQuietly,
  settleStatements,
  targetLabelColumns,
  waitlistRanks,
  type Effective,
  type NotifyDeps,
  type ProgrammeInfo,
  type Target,
} from './core'
import { loadPendingEntry, settlePending } from './confirm'
import { createEntry, emailConfirmLink, emailNewEntry, type EnrolStatus } from './submit'

// The admin side of enrolment (docs/api/enrolment.md): every target with its counts, one target's entries, the
// per-instance settings (its product), and the actions on an entry. Admin and owner only: this is personal data,
// juniors' and guardians' included, so editors get no access (docs/admin.md §3.7).
//
// Every change is audited in the same batch. Anything that frees a spot (cancel, delete, move away, a raised cap)
// offers it to the waitlist straight away (offerNext) and emails the offer.

export type EnrolmentDeps = NotifyDeps & { db: AppDb; now?: Date }

// ── Lists ─────────────────────────────────────────────────────────────────────

export type Counts = {
  /** Individual entries (players, free agents) and team captains holding a spot. */
  players: number
  waitlist: number
  offered: number
  teams: number
  teamsWaitlist: number
  /** Public entries waiting for their email address to be confirmed (they hold no spot). */
  pending: number
  teamsPending: number
  /** Spot-holding entries with a fee that aren't marked paid. */
  unpaid: number
}

export type TargetSummary = {
  ref: TargetRef
  label: string
  startsOn: string | null
  endsOn: string | null
  status: string
  programme: { id: string; name: string; code: string; kind: ProgrammeKind; status: string }
  productId: string | null
  caps: { players: number | null; teams: number | null }
  counts: Counts
  open: boolean
}

const emptyCounts = (): Counts => ({
  players: 0,
  waitlist: 0,
  offered: 0,
  teams: 0,
  teamsWaitlist: 0,
  pending: 0,
  teamsPending: 0,
  unpaid: 0,
})

const HOLDING = ['pending_payment', 'paid', 'confirmed', 'offered']

/** Counts per product (two grouped queries over live rows). */
async function countsByProduct(db: AppDb, productIds?: string[]) {
  const regFilter = productIds ? inArray(registrations.productId, productIds) : undefined
  const grpFilter = productIds ? inArray(groups.productId, productIds) : undefined
  const [regRows, groupRows] = await Promise.all([
    db
      .select({
        productId: registrations.productId,
        status: registrations.status,
        unpaid: sql<number>`sum(case when ${registrations.paidAt} is null and coalesce(${registrations.amountCents}, 0) > 0 then 1 else 0 end)`,
        n: sql<number>`count(*)`,
      })
      .from(registrations)
      .where(
        and(regFilter, sql`${registrations.status} in ('pending_payment', 'paid', 'confirmed', 'offered', 'waitlist', 'pending_email')`),
      )
      .groupBy(registrations.productId, registrations.status)
      .all(),
    db
      .select({ productId: groups.productId, status: groups.status, n: sql<number>`count(*)` })
      .from(groups)
      .where(and(grpFilter, ne(groups.status, 'cancelled')))
      .groupBy(groups.productId, groups.status)
      .all(),
  ])
  const out = new Map<string, Counts>()
  const get = (id: string) => {
    let c = out.get(id)
    if (!c) out.set(id, (c = emptyCounts()))
    return c
  }
  for (const r of regRows) {
    const c = get(r.productId)
    const n = Number(r.n)
    if (r.status === 'waitlist') c.waitlist += n
    else if (r.status === 'pending_email') c.pending += n
    else if (HOLDING.includes(r.status)) {
      c.players += n
      c.unpaid += Number(r.unpaid)
      if (r.status === 'offered') c.offered += n
    }
  }
  for (const g of groupRows) {
    const c = get(g.productId)
    const n = Number(g.n)
    if (g.status === 'waitlist') c.teamsWaitlist += n
    else if (g.status === 'pending_email') c.teamsPending += n
    else c.teams += n
  }
  return out
}

/**
 * Every target that can take enrolments, newest first: seasons not archived, training sessions and terms from the
 * last 30 days on, events not long over. `all` includes everything (archived seasons, past sessions).
 */
export async function listTargets(
  db: AppDb,
  opts: { all?: boolean; programmeId?: string } = {},
  now = new Date(),
): Promise<TargetSummary[]> {
  const today = sydneyDate(now)
  const since = sydneyDate(new Date(now.getTime() - 30 * 86_400_000))
  const byProgramme = <T extends { programmeId: unknown }>(t: T) =>
    opts.programmeId ? eq(t.programmeId as never, opts.programmeId) : undefined
  const [progRows, seasonRows, sessionRows, termRows, eventRows, productRows] = await Promise.all([
    db.select(programmeColumns).from(programmes).all(),
    db
      .select({ id: seasons.id, programmeId: seasons.leagueId, name: seasons.name, startDate: seasons.startDate, status: seasons.status })
      .from(seasons)
      .where(
        and(opts.all ? undefined : ne(seasons.status, 'archived'), opts.programmeId ? eq(seasons.leagueId, opts.programmeId) : undefined),
      )
      .all(),
    db
      .select({
        id: programmeSessions.id,
        programmeId: programmeSessions.programmeId,
        date: programmeSessions.date,
        startTime: programmeSessions.startTime,
        endTime: programmeSessions.endTime,
        title: programmeSessions.title,
        status: programmeSessions.status,
      })
      .from(programmeSessions)
      .where(
        and(isNull(programmeSessions.termId), opts.all ? undefined : gte(programmeSessions.date, since), byProgramme(programmeSessions)),
      )
      .orderBy(asc(programmeSessions.date))
      .limit(500)
      .all(),
    db
      .select({
        id: developmentTerms.id,
        programmeId: developmentTerms.programmeId,
        name: developmentTerms.name,
        startDate: developmentTerms.startDate,
        endDate: developmentTerms.endDate,
        status: developmentTerms.status,
      })
      .from(developmentTerms)
      .where(
        and(
          opts.all
            ? undefined
            : or(gte(developmentTerms.endDate, since), and(isNull(developmentTerms.endDate), gte(developmentTerms.startDate, since))),
          byProgramme(developmentTerms),
        ),
      )
      .all(),
    db
      .select({
        id: events.id,
        programmeId: events.programmeId,
        name: events.name,
        startDate: events.startDate,
        endDate: events.endDate,
        status: events.status,
      })
      .from(events)
      .where(and(opts.all ? undefined : or(gte(events.endDate, since), gte(events.startDate, since)), byProgramme(events)))
      .all(),
    db.select().from(products).where(isNotNull(products.programmeId)).all(),
  ])
  const counts = await countsByProduct(db)
  const progById = new Map(progRows.map((p) => [p.id, p]))
  const productFor = new Map<string, Product>()
  for (const p of productRows) {
    const ref = refOfProduct(p)
    if (ref) productFor.set(`${ref.kind}:${ref.id}`, p)
  }
  const nowIso = now.toISOString()
  const out: TargetSummary[] = []
  const add = (
    kind: TargetKind,
    row: { id: string; programmeId: string; status: string },
    label: string,
    startsOn: string | null,
    endsOn: string | null,
    closedReason: string | null,
  ) => {
    const programme = progById.get(row.programmeId)
    if (!programme) return
    const product = productFor.get(`${kind}:${row.id}`) ?? null
    const eff = effective(programme, product)
    const target: Target = { ref: { kind, id: row.id }, label, startsOn, endsOn, closedReason, programme, product }
    out.push({
      ref: target.ref,
      label,
      startsOn,
      endsOn,
      status: row.status,
      programme: { id: programme.id, name: programme.name, code: programme.code, kind: programme.kind, status: programme.status },
      productId: product?.id ?? null,
      caps: { players: eff.capPlayers, teams: eff.capTeams },
      counts: (product && counts.get(product.id)) ?? emptyCounts(),
      open: isOpen(target, nowIso),
    })
  }
  for (const s of seasonRows) add('season', s, s.name, s.startDate, null, s.status === 'archived' ? 'archived' : null)
  for (const s of sessionRows)
    add('session', s, sessionLabel(s), s.date, s.date, s.status !== 'scheduled' ? s.status : s.date < today ? 'past' : null)
  for (const t of termRows)
    add(
      'term',
      t,
      t.name,
      t.startDate,
      t.endDate,
      t.status === 'cancelled' ? 'cancelled' : (t.endDate ?? t.startDate) < today ? 'past' : null,
    )
  for (const e of eventRows)
    add(
      'event',
      e,
      e.name,
      e.startDate,
      e.endDate,
      e.status === 'cancelled' ? 'cancelled' : (e.endDate ?? e.startDate) < today ? 'past' : null,
    )
  return out.toSorted(targetOrder(today))
}

/**
 * Admin → Enrolments order: what's on now or coming up first, soonest first (so the next session is at the top at
 * the door), then what's finished, latest first. A season counts as current until it's archived.
 */
export const targetOrder =
  (today: string) =>
  (a: Pick<TargetSummary, 'ref' | 'startsOn' | 'endsOn' | 'status' | 'programme'>, b: typeof a): number => {
    const done = (t: typeof a) => (t.ref.kind === 'season' ? t.status === 'archived' : (t.endsOn ?? t.startsOn ?? '') < today)
    const da = done(a)
    const db = done(b)
    if (da !== db) return da ? 1 : -1
    const byDate = (a.startsOn ?? '').localeCompare(b.startsOn ?? '')
    return (da ? -byDate : byDate) || a.programme.name.localeCompare(b.programme.name)
  }

export type EntryType = FormEntryType

export type RegistrationRow = {
  id: string
  reference: string
  status: string
  entryType: EntryType
  groupId: string | null
  teamName: string | null
  waitlistPosition: number | null
  /** 1-based place on the waitlist (positions keep gaps; this doesn't). */
  waitlistRank: number | null
  /** While pending_email: when the confirm link stops working (the cron then expires the entry). */
  confirmBy: string | null
  offeredAt: string | null
  offerExpiresAt: string | null
  amountCents: number | null
  paidAt: string | null
  paidMarkedBy: string | null
  paymentNote: string | null
  source: string
  createdAt: string
  cancelledAt: string | null
  cancelReason: string | null
  answers: Record<string, unknown>
  formVersion: number | null
  vnswConfirmed: boolean
  player: {
    id: string
    firstName: string
    lastName: string
    email: string
    phone: string | null
    birthYear: number | null
    guardianName: string | null
    guardianEmail: string | null
    guardianPhone: string | null
    emergencyContact: string | null
  }
}

export type GroupRow = {
  id: string
  name: string
  status: string
  waitlistPosition: number | null
  waitlistRank: number | null
  offeredAt: string | null
  offerExpiresAt: string | null
  captainPlayerId: string | null
  teamId: string | null
  notes: string | null
  createdAt: string
  cancelledAt: string | null
}

export type TargetDetail = {
  summary: TargetSummary
  /** Null until the target's settings are first saved (seasons get their product row then; a GET never writes). */
  product: Product | null
  effective: Effective
  programme: ProgrammeInfo
  /** The form in use (retired questions included, for old answers). */
  form: { id: string | null; name: string; version: number | null; fields: FormField[] }
  entryTypes: EntryType[]
  registrations: RegistrationRow[]
  groups: GroupRow[]
  /** Other targets of the same programme, for "Move to". */
  moveTargets: { ref: TargetRef; label: string }[]
}

const entryTypeOf = (r: { freeAgent: boolean; groupId: string | null }): EntryType =>
  r.freeAgent ? 'free_agent' : r.groupId ? 'team' : 'player'

async function loadRegistrationRows(db: AppDb, productId: string): Promise<RegistrationRow[]> {
  const rows = await db
    .select({
      r: registrations,
      p: {
        id: players.id,
        firstName: players.firstName,
        lastName: players.lastName,
        email: players.email,
        phone: players.phone,
        birthYear: players.birthYear,
        guardianName: players.guardianName,
        guardianEmail: players.guardianEmail,
        guardianPhone: players.guardianPhone,
        emergencyContact: players.emergencyContact,
      },
      teamName: groups.name,
      markedBy: user.email,
    })
    .from(registrations)
    .innerJoin(players, eq(players.id, registrations.playerId))
    .leftJoin(groups, eq(groups.id, registrations.groupId))
    .leftJoin(user, eq(user.id, registrations.paidMarkedBy))
    .where(eq(registrations.productId, productId))
    .orderBy(asc(registrations.createdAt))
    .limit(2000)
    .all()
  const individuals = rows.map((x) => x.r).filter((r) => !r.groupId || r.freeAgent)
  const ranks = waitlistRanks(individuals)
  return rows.map(({ r, p, teamName, markedBy }) => ({
    id: r.id,
    reference: r.reference,
    status: r.status,
    entryType: entryTypeOf(r),
    groupId: r.groupId,
    teamName,
    waitlistPosition: r.waitlistPosition,
    waitlistRank: ranks.get(r.id) ?? null,
    confirmBy: r.status === 'pending_email' ? r.holdExpiresAt : null,
    offeredAt: r.offeredAt,
    offerExpiresAt: r.offerExpiresAt,
    amountCents: r.amountCents,
    paidAt: r.paidAt,
    paidMarkedBy: markedBy,
    paymentNote: r.paymentNote,
    source: r.source,
    createdAt: r.createdAt,
    cancelledAt: r.cancelledAt,
    cancelReason: r.cancelReason,
    answers: r.answers,
    formVersion: r.formVersion,
    vnswConfirmed: r.vnswConfirmed,
    player: p,
  }))
}

/** Other targets of a programme (for moves): upcoming first, at most 100. */
async function siblingTargets(db: AppDb, programme: ProgrammeInfo, except: TargetRef, today: string) {
  const kind = TARGET_FOR_PROGRAMME[programme.kind]
  const list: { ref: TargetRef; label: string }[] = []
  if (kind === 'season') {
    const rows = await db
      .select({ id: seasons.id, name: seasons.name })
      .from(seasons)
      .where(and(eq(seasons.leagueId, programme.id), ne(seasons.status, 'archived')))
      .orderBy(desc(seasons.startDate))
      .limit(100)
      .all()
    for (const r of rows) list.push({ ref: { kind, id: r.id }, label: r.name })
  } else if (kind === 'session') {
    const rows = await db
      .select()
      .from(programmeSessions)
      .where(and(eq(programmeSessions.programmeId, programme.id), isNull(programmeSessions.termId), gte(programmeSessions.date, today)))
      .orderBy(asc(programmeSessions.date))
      .limit(100)
      .all()
    for (const r of rows) list.push({ ref: { kind, id: r.id }, label: sessionLabel(r) })
  } else if (kind === 'term') {
    const rows = await db
      .select({ id: developmentTerms.id, name: developmentTerms.name })
      .from(developmentTerms)
      .where(eq(developmentTerms.programmeId, programme.id))
      .orderBy(desc(developmentTerms.startDate))
      .limit(100)
      .all()
    for (const r of rows) list.push({ ref: { kind, id: r.id }, label: r.name })
  } else {
    const rows = await db
      .select({ id: events.id, name: events.name })
      .from(events)
      .where(eq(events.programmeId, programme.id))
      .orderBy(desc(events.startDate))
      .limit(100)
      .all()
    for (const r of rows) list.push({ ref: { kind, id: r.id }, label: r.name })
  }
  return list.filter((t) => t.ref.id !== except.id)
}

export const parseTargetRef = (kind: unknown, id: unknown): TargetRef => {
  if (!isTargetKind(kind) || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw notFound('enrolment target')
  return { kind, id }
}

const NO_ROWS = Promise.resolve([])

/** One target with all its entries. Read-only: a target without a product row yet shows the programme's defaults. */
export async function getTargetDetail(db: AppDb, ref: TargetRef, now = new Date()): Promise<TargetDetail> {
  const today = sydneyDate(now)
  const target = await loadTarget(db, ref, today)
  if (!target) throw notFound('enrolment target')
  const product = target.product
  const eff = effective(target.programme, product)
  const [regs, groupRows, form, moveTargets, counts] = await Promise.all([
    product ? loadRegistrationRows(db, product.id) : NO_ROWS,
    product
      ? db
          .select({
            id: groups.id,
            name: groups.name,
            status: groups.status,
            waitlistPosition: groups.waitlistPosition,
            offeredAt: groups.offeredAt,
            offerExpiresAt: groups.offerExpiresAt,
            captainPlayerId: groups.captainPlayerId,
            teamId: groups.teamId,
            notes: groups.notes,
            createdAt: groups.createdAt,
            cancelledAt: groups.cancelledAt,
          })
          .from(groups)
          .where(eq(groups.productId, product.id))
          .orderBy(asc(groups.createdAt))
          .all()
      : NO_ROWS,
    resolveFormWithRetired(db, eff.formId, target.programme.kind),
    siblingTargets(db, target.programme, ref, today),
    product ? countsByProduct(db, [product.id]) : Promise.resolve(new Map<string, Counts>()),
  ])
  const groupRanks = waitlistRanks(groupRows)
  const p = target.programme
  return {
    summary: {
      ref,
      label: target.label,
      startsOn: target.startsOn,
      endsOn: target.endsOn,
      status: target.closedReason ?? 'open',
      programme: { id: p.id, name: p.name, code: p.code, kind: p.kind, status: p.status },
      productId: product?.id ?? null,
      caps: { players: eff.capPlayers, teams: eff.capTeams },
      counts: (product && counts.get(product.id)) ?? emptyCounts(),
      open: isOpen(target, now.toISOString()),
    },
    product,
    effective: eff,
    programme: p,
    form,
    entryTypes: entryTypesFor(p.kind, eff),
    registrations: regs,
    groups: groupRows.map((g) => ({ ...g, waitlistRank: groupRanks.get(g.id) ?? null })),
    moveTargets,
  }
}

/**
 * The CSV of a target's entries (`all` includes cancelled and expired ones), audited as enrolment.export with how
 * many rows went out: it's everyone's personal details, juniors' included.
 */
export async function exportEnrolments(db: AppDb, actor: Editor, ref: TargetRef, all: boolean, now = new Date()) {
  const detail = await getTargetDetail(db, ref, now)
  const rows = detail.registrations.filter((r) => all || !['cancelled', 'expired', 'refunded'].includes(r.status))
  await audit(
    db,
    actor,
    'enrolment.export',
    { type: 'product', id: detail.product?.id ?? `${ref.kind}:${ref.id}` },
    null,
    { target: `${ref.kind}:${ref.id}`, label: detail.summary.label, rows: rows.length, includeCancelled: all },
    now.toISOString(),
  )
  const name = `${detail.summary.programme.code}-${detail.summary.label}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return { csv: enrolmentsCsv(detail.form.fields, rows), filename: `${name || 'enrolments'}-enrolments.csv` }
}

/** Like resolveForm, but keeps retired questions (so old answers keep their labels in the admin and CSV). */
async function resolveFormWithRetired(db: AppDb, formId: string | null, kind: ProgrammeKind) {
  if (formId) {
    const f = await db
      .select({ id: enrolmentForms.id, name: enrolmentForms.name, version: enrolmentForms.version, fields: enrolmentForms.fields })
      .from(enrolmentForms)
      .where(eq(enrolmentForms.id, formId))
      .get()
    if (f) return f
  }
  const d = await resolveForm(db, null, kind)
  return { id: null, name: d.name, version: null, fields: d.fields }
}

// ── Product settings ──────────────────────────────────────────────────────────

const int = (v: unknown, label: string, min: number, max: number): number | null => {
  if (v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${label} must be a whole number from ${min} to ${max}.`)
  return n
}
const bool = (v: unknown, label: string): boolean | null => {
  if (v === null) return null
  if (typeof v !== 'boolean') throw invalid(`${label} must be on or off.`)
  return v
}
const instant = (v: unknown, label: string): string | null => {
  if (v === null || v === '') return null
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw invalid(`${label} must be a date and time.`)
  return new Date(v).toISOString()
}

export type ProductInput = Partial<
  Record<
    | 'capacity'
    | 'capacityTeams'
    | 'priceCents'
    | 'formId'
    | 'waitlistEnabled'
    | 'waitlistOfferHours'
    | 'allowTeamEntries'
    | 'allowFreeAgents'
    | 'opensAt'
    | 'closesAt'
    | 'active'
    | 'emailConfirm'
    | 'baseUpdatedAt',
    unknown
  >
>

/** Changes one target's settings. Null clears an override (back to the programme's). A raised cap offers spots. */
export async function updateProduct(deps: EnrolmentDeps, actor: Editor, productId: string, input: ProductInput) {
  const { db } = deps
  const now = deps.now ?? new Date()
  const loaded = await loadProduct(db, productId)
  if (!loaded) throw notFound('product')
  const { product, programme, label } = loaded
  if (typeof input.baseUpdatedAt === 'string' && input.baseUpdatedAt && input.baseUpdatedAt !== product.updatedAt)
    throw new HttpError(409, 'conflict', 'Someone else changed these settings since you loaded them. Reload and try again.')
  const set: Partial<Product> = {}
  if ('capacity' in input) set.capacity = int(input.capacity, 'The player cap', 0, 10_000)
  if ('capacityTeams' in input) set.capacityTeams = int(input.capacityTeams, 'The team cap', 0, 1_000)
  if ('priceCents' in input) set.priceCents = int(input.priceCents, 'The price', 0, 10_000_000) ?? 0
  if ('waitlistOfferHours' in input) set.waitlistOfferHours = int(input.waitlistOfferHours, 'The offer time', 1, 336)
  if ('waitlistEnabled' in input) set.waitlistEnabled = bool(input.waitlistEnabled, 'Waitlist')
  if ('allowTeamEntries' in input) set.allowTeamEntries = bool(input.allowTeamEntries, 'Team entries')
  if ('allowFreeAgents' in input) set.allowFreeAgents = bool(input.allowFreeAgents, 'Free agents')
  if ('opensAt' in input) set.opensAt = instant(input.opensAt, 'Opens')
  if ('closesAt' in input) set.closesAt = instant(input.closesAt, 'Closes')
  if ('active' in input) set.active = bool(input.active, 'Taking enrolments') ?? true
  if ('emailConfirm' in input) set.emailConfirm = bool(input.emailConfirm, 'Email confirmation')
  if ('formId' in input) {
    if (input.formId === null || input.formId === '') set.formId = null
    else {
      if (typeof input.formId !== 'string') throw invalid('Choose a form.')
      const form = await db
        .select({ id: enrolmentForms.id, archivedAt: enrolmentForms.archivedAt })
        .from(enrolmentForms)
        .where(eq(enrolmentForms.id, input.formId))
        .get()
      if (!form) throw invalid('That form no longer exists.')
      if (form.archivedAt) throw invalid('That form is archived. Restore it first.')
      set.formId = form.id
    }
  }
  const opens = 'opensAt' in set ? set.opensAt : product.opensAt
  const closes = 'closesAt' in set ? set.closesAt : product.closesAt
  if (opens && closes && opens >= closes) throw invalid('Enrolment must open before it closes.')
  const before = Object.fromEntries(Object.keys(set).map((k) => [k, product[k as keyof Product]]))
  if (Object.keys(set).length === 0) return { product, offered: 0, purge: {} as PurgeTargets }
  const at = now.toISOString()
  const [updated] = (await runBatch(db, [
    db
      .update(products)
      .set({ ...set, updatedAt: at, updatedBy: actor.id })
      .where(eq(products.id, productId))
      .returning(),
    audit(db, actor, 'product.update', { type: 'product', id: productId }, before, set, at),
  ])) as [Product[]]
  const offers = await offerNext(db, productId, now)
  const offered = await sendOfferEmails(deps, offers, { programme: programme.name, target: label })
  return {
    product: updated![0]!,
    offered,
    purge: { tags: [tags.page('/enrol'), tags.page(programmePath(programme.kind, programme.slug))] } as PurgeTargets,
  }
}

/** Saves a target's settings, creating its product row first if it has none yet (PATCH targets/:kind/:id). */
export async function updateTargetSettings(deps: EnrolmentDeps, actor: Editor, ref: TargetRef, input: ProductInput) {
  const now = deps.now ?? new Date()
  const target = await loadTarget(deps.db, ref, sydneyDate(now))
  if (!target) throw notFound('enrolment target')
  const product = await ensureProduct(deps.db, target, actor.id)
  return updateProduct(deps, actor, product.id, input)
}

// ── Adding an entry (admin) ───────────────────────────────────────────────────

export type AdminEntryInput = { entryType?: unknown; person?: unknown; answers?: unknown; status?: unknown; notify?: unknown }

/** Adds an enrolment by hand: no Turnstile or open check, required questions optional. `status` auto | confirmed | waitlist. */
export async function addEntry(deps: EnrolmentDeps, actor: Editor, ref: TargetRef, input: AdminEntryInput) {
  const { db } = deps
  const now = deps.now ?? new Date()
  const target = await loadTarget(db, ref, sydneyDate(now))
  if (!target) throw notFound('enrolment target')
  const eff = effective(target.programme, target.product)
  const allowed: EntryType[] = target.programme.kind === 'league' || target.programme.kind === 'event' ? ['team', 'free_agent'] : ['player']
  const entryType = (input.entryType ?? allowed[0]) as EntryType
  if (!allowed.includes(entryType)) throw invalid('Choose the kind of entry.')
  const form = await resolveForm(db, eff.formId, target.programme.kind)
  const check = validateEnrolment(form.fields, entryType, input.person, input.answers, {
    currentYear: Number(sydneyDate(now).slice(0, 4)),
    relaxRequired: true,
  })
  if (!check.ok) throw invalid('Please check the highlighted answers.', { fieldErrors: check.errors })
  const status = input.status === 'confirmed' || input.status === 'waitlist' ? (input.status as EnrolStatus) : null
  const at = now.toISOString()
  const result = await createEntry(db, target, eff, form, entryType, check, {
    source: 'admin',
    actorId: actor.id,
    forceStatus: status,
    now,
    extra: ({ registrationId, reference }) => [
      audit(
        db,
        actor,
        'enrolment.create',
        { type: 'registration', id: registrationId },
        null,
        { reference, entryType, status: status ?? 'auto' },
        at,
      ),
    ],
  })
  if (input.notify === true && result.status !== 'pending_email')
    await emailNewEntry(
      db,
      deps.mailer,
      check.person.email,
      check.person.firstName,
      { ...result, status: result.status },
      { priority: true },
    )
  return result
}

/** A team entry made by the admin (no captain yet), e.g. to place free agents into. Confirmed, whatever the cap. */
export async function addGroup(deps: EnrolmentDeps, actor: Editor, ref: TargetRef, input: { name?: unknown }) {
  const { db } = deps
  const now = deps.now ?? new Date()
  const target = await loadTarget(db, ref, sydneyDate(now))
  if (!target) throw notFound('enrolment target')
  const product = await ensureProduct(db, target, actor.id)
  const name = optionalText(input.name, 'Team name', 80)
  if (!name) throw invalid('Enter a team name.')
  await assertTeamNameFree(db, product.id, name)
  const at = now.toISOString()
  const id = crypto.randomUUID()
  try {
    await runBatch(db, [
      db.insert(groups).values({
        id,
        kind: 'team',
        name,
        productId: product.id,
        status: 'confirmed',
        answers: {},
        createdAt: at,
        updatedAt: at,
        updatedBy: actor.id,
      }),
      audit(db, actor, 'enrolment.create', { type: 'group', id }, null, { name }, at),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'groups.product_id')) throw teamNameTaken(name)
    throw e
  }
  return { id, name }
}

const teamNameTaken = (name: string) => new HttpError(409, 'team_name_taken', `There's already a team entry called “${name}”.`)

async function assertTeamNameFree(db: AppDb, productId: string, name: string, exceptId?: string) {
  const same = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.productId, productId), ne(groups.status, 'cancelled'), sql`lower(trim(${groups.name})) = lower(${name})`))
    .all()
  if (same.some((g) => g.id !== exceptId)) throw teamNameTaken(name)
}

// ── Actions on one registration ───────────────────────────────────────────────

export const PAYMENT_METHODS = { payid: 'PayID', cash: 'Cash', bank: 'Bank transfer', card: 'Card', other: 'Other' } as const
export type PaymentMethod = keyof typeof PAYMENT_METHODS

export type RegistrationActionInput = {
  action?: unknown
  method?: unknown
  note?: unknown
  reason?: unknown
  notify?: unknown
  to?: unknown
  force?: unknown
  groupId?: unknown
  person?: unknown
  birthYear?: unknown
  guardian?: unknown
  emergencyContact?: unknown
}

export const registrationActions = [
  'mark_paid',
  'mark_unpaid',
  'cancel',
  'reinstate',
  'offer',
  'confirm',
  'resend_offer',
  'move',
  'place',
  'edit',
  'delete',
  'verify',
  'resend_confirm',
] as const
export type RegistrationAction = (typeof registrationActions)[number]

const HOLDS = (s: string) => HOLDING.includes(s)
const CLOSED = (s: string) => s === 'cancelled' || s === 'expired' || s === 'refunded'

async function loadRegistration(db: AppDb, id: string) {
  const row = await joinTargetRows(
    db
      .select({
        r: registrations,
        player: players,
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
    .where(eq(registrations.id, id))
    .get()
  if (!row) throw notFound('enrolment')
  return { ...row, label: labelOfRow(row) }
}

/** The deadline a resent confirm link gets: now plus Settings → Enrolment's hours. */
async function confirmDeadline(db: AppDb, now: Date) {
  return new Date(now.getTime() + (await getSettings(db)).enrolment.confirmHours * 3_600_000).toISOString()
}

const text = (v: unknown, label: string, max: number, required = false) => {
  const s = optionalText(v, label, max)
  if (required && !s) throw invalid(`${label} is required.`)
  return s
}

const conflict = (message: string) => new HttpError(409, 'conflict', message)

const wrongState = (what: string) => conflict(`This enrolment is ${what}, so that can't be done. Reload to see its latest state.`)

/** One admin action on an enrolment (see registrationActions). Returns the updated row's id and any offers made. */
export async function registrationAction(deps: EnrolmentDeps, actor: Editor, id: string, input: RegistrationActionInput) {
  const { db } = deps
  const now = deps.now ?? new Date()
  const at = now.toISOString()
  const action = input.action as RegistrationAction
  if (!(registrationActions as readonly string[]).includes(action)) throw invalid('Unknown action.')
  const row = await loadRegistration(db, id)
  const { r, player, product, programme } = row
  const what = { programme: programme.name, target: row.label }
  const isCaptain = !!r.groupId && !r.freeAgent
  const auditOf = (a: Parameters<typeof auditEntry>[1], before: unknown, after: unknown) =>
    audit(db, actor, a, { type: 'registration', id }, before, after, at)
  const same = and(eq(registrations.id, id), eq(registrations.status, r.status))
  const run = async (statements: BatchItem<'sqlite'>[]) => {
    const results = await runBatch(db, statements)
    if ((results[0] as unknown[]).length === 0) throw conflict('Someone else changed this enrolment just now. Reload and try again.')
    return results
  }
  const base = { name: player.firstName, ...what, reference: r.reference, teamName: isCaptain ? row.groupName : null }
  let offers = 0
  const freeSpot = async () => {
    offers += await sendOfferEmails(deps, await offerNext(db, product.id, now), what)
  }

  switch (action) {
    case 'mark_paid': {
      const method = input.method as PaymentMethod
      if (!(method in PAYMENT_METHODS)) throw invalid('Choose how they paid.')
      const note = optionalText(input.note, 'The note', 200)
      const paymentNote = `${PAYMENT_METHODS[method]}${note ? `: ${note}` : ''}`
      await run([
        db
          .update(registrations)
          .set({ paidAt: at, paidMarkedBy: actor.id, paymentNote, updatedBy: actor.id })
          .where(eq(registrations.id, id))
          .returning({ id: registrations.id }),
        auditOf('enrolment.mark_paid', { paidAt: r.paidAt, paymentNote: r.paymentNote }, { paidAt: at, paymentNote }),
      ])
      break
    }
    case 'mark_unpaid': {
      const note = optionalText(input.note, 'The note', 200)
      await run([
        db
          .update(registrations)
          .set({ paidAt: null, paidMarkedBy: null, paymentNote: note, updatedBy: actor.id })
          .where(eq(registrations.id, id))
          .returning({ id: registrations.id }),
        auditOf('enrolment.mark_unpaid', { paidAt: r.paidAt, paymentNote: r.paymentNote }, { paidAt: null, paymentNote: note }),
      ])
      break
    }
    case 'cancel': {
      if (isCaptain) throw conflict("This is a team captain's entry. Cancel the team entry instead.")
      if (CLOSED(r.status)) throw wrongState('already cancelled')
      const reason = optionalText(input.reason, 'The reason', 300)
      await run([
        db
          .update(registrations)
          .set({
            status: 'cancelled',
            cancelledAt: at,
            cancelReason: reason,
            offerExpiresAt: null,
            waitlistPosition: null,
            updatedBy: actor.id,
          })
          .where(same)
          .returning({ id: registrations.id }),
        auditOf('enrolment.status', { status: r.status }, { status: 'cancelled', reason }),
      ])
      if (input.notify === true)
        await sendQuietly(() => deps.mailer.sendEmail(player.email, 'enrolment.cancelled', { ...base, reason }), 'cancelled')
      if (HOLDS(r.status)) await freeSpot()
      break
    }
    case 'reinstate': {
      if (isCaptain) throw conflict('Reinstate the team entry instead.')
      if (!CLOSED(r.status)) throw wrongState(r.status)
      const eff = effective(programme, product)
      try {
        await run([
          db
            .update(registrations)
            .set({ status: 'confirmed', cancelledAt: null, cancelReason: null, updatedBy: actor.id })
            .where(same)
            .returning({ id: registrations.id }),
          ...settleStatements(db, { productId: product.id, registrationId: id, groupId: null }, { ...eff, waitlistEnabled: true }),
          auditOf('enrolment.status', { status: r.status }, { status: 'reinstated' }),
        ])
      } catch (e) {
        if (isUniqueFailure(e, 'registrations.product_id'))
          throw conflict(`${player.firstName} ${player.lastName} already has another live enrolment here.`)
        throw e
      }
      break
    }
    case 'verify':
    case 'resend_confirm': {
      if (isCaptain) throw conflict('This is part of a team entry. Use the team entry instead.')
      if (r.status !== 'pending_email') throw wrongState(r.status)
      if (action === 'resend_confirm') {
        // A fresh deadline, so the person has the full time again from this email.
        const until = await confirmDeadline(db, now)
        await run([
          db.update(registrations).set({ holdExpiresAt: until, updatedBy: actor.id }).where(same).returning({ id: registrations.id }),
          auditOf('enrolment.update', { confirmBy: r.holdExpiresAt }, { confirmBy: until }),
        ])
        const sent = await emailConfirmLink(
          deps,
          player.email,
          { firstName: player.firstName, ...what, teamName: null, registrationId: id, createdAt: r.createdAt, expiresAt: until },
          { priority: true },
        )
        return { id, offers: 0, emailed: sent }
      }
      const entry = await loadPendingEntry(db, id)
      if (!entry) throw notFound('enrolment')
      const state = await settlePending(deps, entry, at, {
        ignoreDeadline: true,
        notify: input.notify !== false,
        extra: [auditOf('enrolment.status', { status: r.status }, { status: 'email_confirmed' })],
      })
      if (!state) throw conflict('Someone else changed this enrolment just now. Reload and try again.')
      return { id, offers: 0, state }
    }
    case 'offer':
    case 'confirm':
    case 'resend_offer': {
      if (isCaptain) throw conflict('This is part of a team entry. Use the team entry instead.')
      if (action === 'offer' && r.status !== 'waitlist') throw wrongState(r.status)
      if (action === 'confirm' && r.status !== 'waitlist' && r.status !== 'offered' && r.status !== 'pending_email')
        throw wrongState(r.status)
      if (action === 'resend_offer') {
        if (r.status !== 'offered' || !r.offeredAt) throw wrongState(r.status)
        const sent = await sendOfferEmails(
          deps,
          [
            {
              type: 'registration',
              id,
              registrationId: id,
              reference: r.reference,
              email: player.email,
              firstName: player.firstName,
              teamName: null,
              offeredAt: r.offeredAt,
              expiresAt: r.offerExpiresAt ?? at,
              hours: effective(programme, product).offerHours,
            },
          ],
          what,
        )
        return { id, offers: sent }
      }
      const eff = effective(programme, product)
      const expires = new Date(now.getTime() + eff.offerHours * 3_600_000).toISOString()
      const set =
        action === 'offer'
          ? { status: 'offered' as const, offeredAt: at, offerExpiresAt: expires, waitlistPosition: null, updatedBy: actor.id }
          : { status: 'confirmed' as const, offerExpiresAt: null, holdExpiresAt: null, waitlistPosition: null, updatedBy: actor.id }
      await run([
        db.update(registrations).set(set).where(same).returning({ id: registrations.id }),
        auditOf(action === 'offer' ? 'enrolment.offer' : 'enrolment.status', { status: r.status }, { status: set.status }),
      ])
      if (action === 'offer') offers += await sendOfferEmails(deps, await offersMadeAt(db, product.id, at, eff.offerHours), what)
      else if (input.notify !== false)
        await emailNewEntry(
          db,
          deps.mailer,
          player.email,
          player.firstName,
          {
            ...base,
            status: 'confirmed',
            position: null,
            registrationId: id,
            groupId: null,
            amountCents: r.amountCents,
            message: null,
            programme: what.programme,
            target: what.target,
          },
          { priority: true },
        )
      break
    }
    case 'move': {
      if (isCaptain) throw conflict('Team entries move as a whole; this one is a team captain.')
      if (CLOSED(r.status)) throw wrongState(r.status)
      if (r.status === 'pending_email') throw conflict("This entry's email address isn't confirmed yet. Confirm it (or cancel it) first.")
      const to = input.to && typeof input.to === 'object' ? (input.to as Record<string, unknown>) : {}
      const ref = parseTargetRef(to.kind, to.id)
      const target = await loadTarget(db, ref, sydneyDate(now))
      if (!target) throw notFound('session')
      if (target.programme.id !== programme.id) throw invalid('Enrolments can only move within the same programme.')
      const dest = await ensureProduct(db, target, actor.id)
      if (dest.id === product.id) throw invalid("That's where it already is.")
      const eff = effective(target.programme, dest)
      const holds = HOLDS(r.status) || r.status === 'waitlist'
      const force = input.force === true
      try {
        await run([
          db
            .update(registrations)
            .set({
              productId: dest.id,
              groupId: null,
              status: r.status === 'waitlist' ? 'waitlist' : 'confirmed',
              waitlistPosition:
                r.status === 'waitlist'
                  ? sql`(select coalesce(max(r4.waitlist_position), 0) + 1 from registrations r4 where r4.product_id = ${dest.id} and r4.status = 'waitlist')`
                  : null,
              offerExpiresAt: null,
              updatedBy: actor.id,
            })
            .where(same)
            .returning({ id: registrations.id }),
          ...(r.status !== 'waitlist' && !force
            ? settleStatements(db, { productId: dest.id, registrationId: id, groupId: null }, { ...eff, waitlistEnabled: true })
            : []),
          auditOf('enrolment.update', { productId: product.id, status: r.status }, { productId: dest.id, target: target.label }),
        ])
      } catch (e) {
        if (isUniqueFailure(e, 'registrations.product_id'))
          throw conflict(`${player.firstName} ${player.lastName} is already enrolled in ${target.label}.`)
        throw e
      }
      if (holds && HOLDS(r.status)) await freeSpot()
      break
    }
    case 'place': {
      if (!r.freeAgent) throw conflict('Only free agents can be placed in a team.')
      const groupId = input.groupId === null || input.groupId === '' ? null : typeof input.groupId === 'string' ? input.groupId : undefined
      if (groupId === undefined) throw invalid('Choose a team.')
      if (groupId) {
        const g = await db.select({ productId: groups.productId, status: groups.status }).from(groups).where(eq(groups.id, groupId)).get()
        if (!g || g.productId !== product.id || g.status === 'cancelled') throw invalid("That team entry isn't in this list any more.")
      }
      await run([
        db.update(registrations).set({ groupId, updatedBy: actor.id }).where(eq(registrations.id, id)).returning({ id: registrations.id }),
        auditOf('enrolment.place', { groupId: r.groupId }, { groupId }),
      ])
      break
    }
    case 'edit': {
      const p = input.person && typeof input.person === 'object' ? (input.person as Record<string, unknown>) : {}
      const set: Partial<typeof players.$inferInsert> = {}
      if ('firstName' in p) set.firstName = text(p.firstName, 'First name', 80, true)!
      if ('lastName' in p) set.lastName = text(p.lastName, 'Last name', 80, true)!
      if ('email' in p) {
        const e = normaliseEmail(p.email)
        if (!isEmail(e)) throw invalid("That email address doesn't look right.")
        set.email = e
      }
      if ('phone' in p) {
        const ph = text(p.phone, 'Phone', 30)
        if (ph && !isPhone(ph)) throw invalid("That phone number doesn't look right.")
        set.phone = ph
      }
      if ('birthYear' in input) set.birthYear = int(input.birthYear, 'Year of birth', 1900, now.getUTCFullYear())
      if ('guardian' in input) {
        const g = input.guardian && typeof input.guardian === 'object' ? (input.guardian as Record<string, unknown>) : {}
        set.guardianName = text(g.name, 'Guardian name', 120)
        const ge = normaliseEmail(g.email)
        if (ge && !isEmail(ge)) throw invalid("The guardian's email address doesn't look right.")
        set.guardianEmail = ge || null
        set.guardianPhone = text(g.phone, 'Guardian phone', 30)
      }
      if ('emergencyContact' in input) set.emergencyContact = text(input.emergencyContact, 'Emergency contact', 200)
      if (Object.keys(set).length === 0) throw invalid('Nothing to change.')
      const before = Object.fromEntries(Object.keys(set).map((k) => [k, player[k as keyof typeof player]]))
      await run([
        db
          .update(players)
          .set({ ...set, updatedBy: actor.id })
          .where(eq(players.id, player.id))
          .returning({ id: players.id }),
        // Personal details aren't copied into the audit log; it records which fields changed.
        auditOf('enrolment.update', { fields: Object.keys(before) }, { fields: Object.keys(set) }),
      ])
      break
    }
    case 'delete': {
      if (isCaptain) throw conflict('Delete the team entry instead.')
      await run([
        db.delete(registrations).where(eq(registrations.id, id)).returning({ id: registrations.id }),
        db
          .delete(players)
          .where(and(eq(players.id, player.id), sql`not exists (select 1 from registrations r9 where r9.player_id = ${player.id})`)),
        auditOf('enrolment.delete', { reference: r.reference, status: r.status }, null),
      ])
      if (HOLDS(r.status)) await freeSpot()
      return { id: null, offers }
    }
  }
  return { id, offers }
}

// ── Actions on one team entry ─────────────────────────────────────────────────

export const groupActions = [
  'cancel',
  'reinstate',
  'offer',
  'confirm',
  'resend_offer',
  'rename',
  'notes',
  'link_team',
  'delete',
  'verify',
  'resend_confirm',
] as const
export type GroupAction = (typeof groupActions)[number]

export async function groupAction(
  deps: EnrolmentDeps,
  actor: Editor,
  id: string,
  input: { action?: unknown; name?: unknown; notes?: unknown; teamId?: unknown; reason?: unknown; notify?: unknown },
) {
  const { db } = deps
  const now = deps.now ?? new Date()
  const at = now.toISOString()
  const action = input.action as GroupAction
  if (!(groupActions as readonly string[]).includes(action)) throw invalid('Unknown action.')
  const row = await joinTargetRows(
    db
      .select({ g: groups, product: products, programme: programmeColumns, ...targetLabelColumns })
      .from(groups)
      .innerJoin(products, eq(products.id, groups.productId))
      .innerJoin(programmes, eq(programmes.id, products.programmeId))
      .$dynamic(),
  )
    .where(eq(groups.id, id))
    .get()
  if (!row) throw notFound('team entry')
  const { g, product, programme } = row
  const what = { programme: programme.name, target: labelOfRow(row) }
  const captain = g.captainPlayerId
    ? await db
        .select({
          id: registrations.id,
          reference: registrations.reference,
          email: players.email,
          firstName: players.firstName,
          amountCents: registrations.amountCents,
          createdAt: registrations.createdAt,
          holdExpiresAt: registrations.holdExpiresAt,
          status: registrations.status,
        })
        .from(registrations)
        .innerJoin(players, eq(players.id, registrations.playerId))
        .where(and(eq(registrations.groupId, id), eq(registrations.freeAgent, false), eq(registrations.playerId, g.captainPlayerId)))
        .get()
    : undefined
  const auditOf = (a: Parameters<typeof auditEntry>[1], before: unknown, after: unknown) =>
    audit(db, actor, a, { type: 'group', id }, before, after, at)
  const same = and(eq(groups.id, id), eq(groups.status, g.status))
  const captainRows = and(eq(registrations.groupId, id), eq(registrations.freeAgent, false))
  const run = async (statements: BatchItem<'sqlite'>[]) => {
    const results = await runBatch(db, statements)
    if ((results[0] as unknown[]).length === 0) throw conflict('Someone else changed this team entry just now. Reload and try again.')
    return results
  }
  const base = captain ? { name: captain.firstName, ...what, reference: captain.reference, teamName: g.name } : null
  let offers = 0
  const freeSpot = async () => {
    offers += await sendOfferEmails(deps, await offerNext(db, product.id, now), what)
  }
  const holds = g.status === 'confirmed' || g.status === 'offered'

  switch (action) {
    case 'cancel': {
      if (g.status === 'cancelled') throw wrongState('already cancelled')
      const reason = optionalText(input.reason, 'The reason', 300)
      await run([
        db
          .update(groups)
          .set({ status: 'cancelled', cancelledAt: at, offerExpiresAt: null, waitlistPosition: null, updatedBy: actor.id })
          .where(same)
          .returning({ id: groups.id }),
        db
          .update(registrations)
          .set({ status: 'cancelled', cancelledAt: at, cancelReason: reason, offerExpiresAt: null, updatedBy: actor.id })
          .where(and(captainRows, sql`${registrations.status} not in ('cancelled', 'expired', 'refunded')`)),
        // Free agents placed in it go back to unplaced.
        db
          .update(registrations)
          .set({ groupId: null, updatedBy: actor.id })
          .where(and(eq(registrations.groupId, id), eq(registrations.freeAgent, true))),
        auditOf('enrolment.status', { status: g.status }, { status: 'cancelled', reason }),
      ])
      if (input.notify === true && captain && base)
        await sendQuietly(() => deps.mailer.sendEmail(captain.email, 'enrolment.cancelled', { ...base, reason }), 'cancelled')
      if (holds) await freeSpot()
      break
    }
    case 'reinstate': {
      if (g.status !== 'cancelled') throw wrongState(g.status)
      await assertTeamNameFree(db, product.id, g.name, id)
      const eff = effective(programme, product)
      await run([
        db.update(groups).set({ status: 'confirmed', cancelledAt: null, updatedBy: actor.id }).where(same).returning({ id: groups.id }),
        db
          .update(registrations)
          .set({ status: 'confirmed', cancelledAt: null, cancelReason: null, updatedBy: actor.id })
          .where(captainRows),
        ...(captain
          ? settleStatements(db, { productId: product.id, registrationId: captain.id, groupId: id }, { ...eff, waitlistEnabled: true })
          : []),
        auditOf('enrolment.status', { status: g.status }, { status: 'reinstated' }),
      ])
      break
    }
    case 'verify':
    case 'resend_confirm': {
      if (g.status !== 'pending_email' || !captain) throw wrongState(g.status)
      if (action === 'resend_confirm') {
        const until = await confirmDeadline(db, now)
        await run([
          db.update(groups).set({ updatedBy: actor.id }).where(same).returning({ id: groups.id }),
          db
            .update(registrations)
            .set({ holdExpiresAt: until, updatedBy: actor.id })
            .where(and(eq(registrations.id, captain.id), eq(registrations.status, 'pending_email'))),
          auditOf('enrolment.update', { confirmBy: captain.holdExpiresAt }, { confirmBy: until }),
        ])
        const sent = await emailConfirmLink(
          deps,
          captain.email,
          {
            firstName: captain.firstName,
            ...what,
            teamName: g.name,
            registrationId: captain.id,
            createdAt: captain.createdAt,
            expiresAt: until,
          },
          { priority: true },
        )
        return { id, offers: 0, emailed: sent }
      }
      const entry = await loadPendingEntry(db, captain.id)
      if (!entry) throw notFound('enrolment')
      const state = await settlePending(deps, entry, at, {
        ignoreDeadline: true,
        notify: input.notify !== false,
        extra: [auditOf('enrolment.status', { status: g.status }, { status: 'email_confirmed' })],
      })
      if (!state) throw conflict('Someone else changed this team entry just now. Reload and try again.')
      return { id, offers: 0, state }
    }
    case 'offer':
    case 'confirm':
    case 'resend_offer': {
      if (action === 'offer' && g.status !== 'waitlist') throw wrongState(g.status)
      if (action === 'confirm' && g.status !== 'waitlist' && g.status !== 'offered' && g.status !== 'pending_email')
        throw wrongState(g.status)
      if (action === 'resend_offer') {
        if (g.status !== 'offered' || !g.offeredAt || !captain) throw wrongState(g.status)
        const sent = await sendOfferEmails(
          deps,
          [
            {
              type: 'group',
              id,
              registrationId: captain.id,
              reference: captain.reference,
              email: captain.email,
              firstName: captain.firstName,
              teamName: g.name,
              offeredAt: g.offeredAt,
              expiresAt: g.offerExpiresAt ?? at,
              hours: effective(programme, product).offerHours,
            },
          ],
          what,
        )
        return { id, offers: sent }
      }
      const eff = effective(programme, product)
      const expires = new Date(now.getTime() + eff.offerHours * 3_600_000).toISOString()
      const set =
        action === 'offer'
          ? { status: 'offered' as const, offeredAt: at, offerExpiresAt: expires, waitlistPosition: null, updatedBy: actor.id }
          : { status: 'confirmed' as const, offerExpiresAt: null, waitlistPosition: null, updatedBy: actor.id }
      await run([
        db.update(groups).set(set).where(same).returning({ id: groups.id }),
        db
          .update(registrations)
          .set(
            action === 'offer'
              ? { status: 'offered', offeredAt: at, offerExpiresAt: expires }
              : { status: 'confirmed', offerExpiresAt: null, holdExpiresAt: null },
          )
          .where(and(captainRows, sql`${registrations.status} in ('waitlist', 'offered', 'pending_email')`)),
        auditOf(action === 'offer' ? 'enrolment.offer' : 'enrolment.status', { status: g.status }, { status: set.status }),
      ])
      if (action === 'offer') offers += await sendOfferEmails(deps, await offersMadeAt(db, product.id, at, eff.offerHours), what)
      else if (input.notify !== false && captain && base)
        await emailNewEntry(
          db,
          deps.mailer,
          captain.email,
          captain.firstName,
          {
            ...base,
            status: 'confirmed',
            position: null,
            registrationId: captain.id,
            groupId: id,
            amountCents: captain.amountCents,
            message: null,
          },
          { priority: true },
        )
      break
    }
    case 'rename': {
      const name = optionalText(input.name, 'Team name', 80)
      if (!name) throw invalid('Enter a team name.')
      await assertTeamNameFree(db, product.id, name, id)
      try {
        await run([
          db.update(groups).set({ name, updatedBy: actor.id }).where(eq(groups.id, id)).returning({ id: groups.id }),
          auditOf('enrolment.update', { name: g.name }, { name }),
        ])
      } catch (e) {
        if (isUniqueFailure(e, 'groups.product_id')) throw teamNameTaken(name)
        throw e
      }
      break
    }
    case 'notes': {
      const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 2000) || null : null
      await run([
        db.update(groups).set({ notes, updatedBy: actor.id }).where(eq(groups.id, id)).returning({ id: groups.id }),
        auditOf('enrolment.update', { notes: !!g.notes }, { notes: !!notes }),
      ])
      break
    }
    case 'link_team': {
      const teamId = input.teamId === null || input.teamId === '' ? null : typeof input.teamId === 'string' ? input.teamId : undefined
      if (teamId === undefined) throw invalid('Choose a team.')
      try {
        await run([
          db.update(groups).set({ teamId, updatedBy: actor.id }).where(eq(groups.id, id)).returning({ id: groups.id }),
          auditOf('enrolment.update', { teamId: g.teamId }, { teamId }),
        ])
      } catch (e) {
        if (/FOREIGN KEY/i.test(String((e as { cause?: Error }).cause?.message ?? e))) throw invalid("That team doesn't exist any more.")
        throw e
      }
      break
    }
    case 'delete': {
      await run([
        db.delete(groups).where(eq(groups.id, id)).returning({ id: groups.id }),
        // The captain's registration (now group_id null, free_agent 0, created with the group) goes too.
        ...(captain ? [db.delete(registrations).where(eq(registrations.id, captain.id))] : []),
        ...(g.captainPlayerId
          ? [
              db
                .delete(players)
                .where(
                  and(
                    eq(players.id, g.captainPlayerId),
                    sql`not exists (select 1 from registrations r9 where r9.player_id = ${g.captainPlayerId})`,
                  ),
                ),
            ]
          : []),
        auditOf('enrolment.delete', { name: g.name, status: g.status }, null),
      ])
      if (holds) await freeSpot()
      return { id: null, offers }
    }
  }
  return { id, offers }
}

export type { TargetKind, Mailer }
export { offerEmail }
