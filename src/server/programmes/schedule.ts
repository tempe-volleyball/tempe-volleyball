import { and, asc, count, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm'
import { slugify } from '../../lib/content/paths'
import { programmePath } from '../../lib/programmes'
import { weeklyDates } from '../../lib/weekly'
import { tags, type PurgeTargets } from '../cache'
import { runBatch, type AppDb } from '../db'
import {
  categories,
  courts,
  developmentTerms,
  events,
  occurrenceStatuses,
  products,
  programmes,
  programmeSessions,
  registrations,
  groups,
  spotHoldingStatuses,
  venues,
  type AuditAction,
  type DevelopmentTerm,
  type NewProduct,
  type OccurrenceStatus,
  type Product,
  type Programme,
  type ProgrammeEvent,
  type ProgrammeKind,
  type ProgrammeSession,
} from '../db/schema'
import { audit, conflict, isUniqueFailure, notFound, optionalText, requiredText, type Changed, type Editor } from '../content/common'
import { chunkByParams } from '../competition/draw'
import {
  blockPageTags,
  date,
  dateOrNull,
  has,
  idOrNull,
  int,
  intOrNull,
  invalid,
  moveTreeStatements,
  programmeTags,
  purgeOf,
  slug as parseSlug,
  timeOrNull,
} from './common'
import { PROGRAMME_LIMITS } from './programmes'

// What non-league programmes run (docs/admin.md §3.1): training sessions, development terms and their sessions, and
// event dates. Leagues run seasons (src/server/competition). Each training session, term and event gets its product
// (one per target, products.session_id / term_id / event_id) when it's created, so enrolment always has a row to
// hold that instance's caps and overrides; term sessions don't (people enrol in the term).
//
// Rules:
//  - Sessions belong to training programmes, or to a development term. Terms belong to development programmes and
//    events to event programmes.
//  - "Add weekly sessions" makes one session per week between two dates (at most MAX_RUN), skipping dates that
//    already have one, so running it twice is harmless.
//  - Moving a session or event to another date keeps the first date in original_date / original_start_date.
//  - Anything with enrolments can't be deleted (cancel it instead); products cascade with their instance otherwise.
//  - Changes purge the programme's page, its category page and programme listings (next start dates), only once the
//    programme is public.

export const MAX_RUN = 60

const INSTANCE_LIMITS = { name: 120, title: 120, note: 500, ageGroup: 60 } as const

// ── Shared ────────────────────────────────────────────────────────────────────

async function loadProgramme(db: AppDb, id: string, kinds: ProgrammeKind[], what: string): Promise<Programme> {
  const p = await db.select().from(programmes).where(eq(programmes.id, id)).get()
  if (!p) throw notFound('programme')
  if (!kinds.includes(p.kind)) throw invalid(`Only ${kinds.join(' and ')} programmes have ${what}.`)
  return p
}

/** The programme's page, its category page and every programme listing. Nothing while it's a draft. */
async function schedulePurge(db: AppDb, p: Programme): Promise<PurgeTargets> {
  if (p.status === 'draft') return {}
  const cat = p.categoryId ? await db.select({ slug: categories.slug }).from(categories).where(eq(categories.id, p.categoryId)).get() : null
  return purgeOf([...programmeTags(p), ...(cat ? [tags.category(cat.slug)] : []), tags.programmes, ...(await blockPageTags(db, []))])
}

function status(v: unknown): OccurrenceStatus {
  if (typeof v !== 'string' || !(occurrenceStatuses as readonly string[]).includes(v))
    throw invalid('Status must be scheduled, postponed or cancelled.')
  return v as OccurrenceStatus
}

/** Venue and court must exist, and the court must be at the venue when both are set. */
async function checkPlace(db: AppDb, venueId: string | null | undefined, courtId: string | null | undefined) {
  const [v, c] = await Promise.all([
    venueId ? db.select({ id: venues.id }).from(venues).where(eq(venues.id, venueId)).get() : null,
    courtId ? db.select({ id: courts.id, venueId: courts.venueId }).from(courts).where(eq(courts.id, courtId)).get() : null,
  ])
  if (venueId && !v) throw invalid('That venue no longer exists.')
  if (courtId && !c) throw invalid('That court no longer exists.')
  if (venueId && c && c.venueId !== venueId) throw invalid('That court is at a different venue.')
}

function checkTimes(start: string | null | undefined, end: string | null | undefined) {
  if (start && end && end <= start) throw invalid('The finish time must be after the start time.')
  if (!start && end) throw invalid('Set a start time as well as the finish time.')
}

type ProductTarget =
  { kind: 'training_session'; sessionId: string } | { kind: 'development_term'; termId: string } | { kind: 'event_entry'; eventId: string }

/** The product row for a new session, term or event. Every column with a JS default is set, for chunkByParams. */
function productRow(p: Programme, target: ProductTarget, name: string, startsOn: string, endsOn: string | null, caps: Caps): NewProduct {
  const targetId = 'sessionId' in target ? target.sessionId : 'termId' in target ? target.termId : target.eventId
  return {
    id: crypto.randomUUID(),
    name,
    slug: `${target.kind.replace(/_/g, '-')}-${targetId}`,
    priceCents: p.priceCents ?? 0,
    paymentMethods: ['stripe', 'payid'],
    active: true,
    programmeId: p.id,
    startsOn,
    ...(endsOn ? { endsOn } : {}),
    ...target,
    ...(caps.capacity !== undefined && caps.capacity !== null ? { capacity: caps.capacity } : {}),
    ...(caps.capacityTeams !== undefined && caps.capacityTeams !== null ? { capacityTeams: caps.capacityTeams } : {}),
  }
}

/** Per-instance cap overrides (null = the programme's default). */
type Caps = { capacity?: number | null; capacityTeams?: number | null }

function parseCaps(input: Record<string, unknown>): Caps {
  const out: Caps = {}
  if (has(input, 'capacity')) out.capacity = intOrNull(input.capacity, 'Player cap', 0, PROGRAMME_LIMITS.cap)
  if (has(input, 'capacityTeams')) out.capacityTeams = intOrNull(input.capacityTeams, 'Team cap', 0, PROGRAMME_LIMITS.cap)
  return out
}

/** The enrolment side of an instance, for the admin lists. */
export type InstanceProduct = Pick<Product, 'id' | 'capacity' | 'capacityTeams' | 'active' | 'priceCents'> & {
  /** Registrations holding a spot. */
  enrolled: number
  /** Team entries holding a spot. */
  teams: number
}

const productColumns = {
  id: products.id,
  sessionId: products.sessionId,
  termId: products.termId,
  eventId: products.eventId,
  capacity: products.capacity,
  capacityTeams: products.capacityTeams,
  active: products.active,
  priceCents: products.priceCents,
}

type ProductListRow = { id: string; sessionId: string | null; termId: string | null; eventId: string | null } & Omit<
  InstanceProduct,
  'enrolled' | 'teams'
>

/** The products of one programme with their spot counts. Three queries in one batch. */
async function productsOf(db: AppDb, programmeId: string) {
  const ids = db.select({ id: products.id }).from(products).where(eq(products.programmeId, programmeId))
  const [rows, regs, teams] = (await runBatch(db, [
    db.select(productColumns).from(products).where(eq(products.programmeId, programmeId)),
    db
      .select({ productId: registrations.productId, n: count() })
      .from(registrations)
      .where(and(inArray(registrations.productId, ids), inArray(registrations.status, [...spotHoldingStatuses])))
      .groupBy(registrations.productId),
    db
      .select({ productId: groups.productId, n: count() })
      .from(groups)
      .where(and(inArray(groups.productId, ids), ne(groups.status, 'cancelled'), ne(groups.status, 'waitlist')))
      .groupBy(groups.productId),
  ])) as unknown as [ProductListRow[], { productId: string; n: number }[], { productId: string; n: number }[]]
  const view = (r: ProductListRow): InstanceProduct => ({
    id: r.id,
    capacity: r.capacity,
    capacityTeams: r.capacityTeams,
    active: r.active,
    priceCents: r.priceCents,
    enrolled: regs.find((x) => x.productId === r.id)?.n ?? 0,
    teams: teams.find((x) => x.productId === r.id)?.n ?? 0,
  })
  return {
    session: new Map(rows.filter((r) => r.sessionId).map((r) => [r.sessionId!, view(r)])),
    term: new Map(rows.filter((r) => r.termId).map((r) => [r.termId!, view(r)])),
    event: new Map(rows.filter((r) => r.eventId).map((r) => [r.eventId!, view(r)])),
  }
}

/** Refuses deleting something people enrolled in. */
async function assertNoEnrolments(db: AppDb, productId: string | undefined, what: string) {
  if (!productId) return
  const [r, g] = (await runBatch(db, [
    db.select({ n: count() }).from(registrations).where(eq(registrations.productId, productId)),
    db.select({ n: count() }).from(groups).where(eq(groups.productId, productId)),
  ])) as unknown as [{ n: number }[], { n: number }[]]
  if ((r[0]?.n ?? 0) + (g[0]?.n ?? 0) > 0)
    throw conflict(`People have enrolled in this ${what}, so it can't be deleted. Cancel it instead.`)
}

const productUpdate = (db: AppDb, actor: Editor, where: ReturnType<typeof eq>, caps: Caps, extra: Partial<NewProduct>, at: string) =>
  db
    .update(products)
    .set({ ...caps, ...extra, updatedAt: at, updatedBy: actor.id })
    .where(where)

// ── Training sessions (and term sessions) ─────────────────────────────────────

export type SessionRow = ProgrammeSession & { product: InstanceProduct | null }

export async function listSessions(
  db: AppDb,
  programmeId: string,
  opts: { termId?: string | null; from?: string; to?: string } = {},
): Promise<SessionRow[]> {
  await loadProgramme(db, programmeId, ['training', 'development'], 'sessions')
  const where = and(
    eq(programmeSessions.programmeId, programmeId),
    opts.termId === undefined
      ? undefined
      : opts.termId === null
        ? isNull(programmeSessions.termId)
        : eq(programmeSessions.termId, opts.termId),
    opts.from ? gte(programmeSessions.date, opts.from) : undefined,
    opts.to ? lte(programmeSessions.date, opts.to) : undefined,
  )
  const [rows, prods] = await Promise.all([
    db
      .select()
      .from(programmeSessions)
      .where(where)
      .orderBy(asc(programmeSessions.date), asc(programmeSessions.startTime))
      .limit(500)
      .all(),
    productsOf(db, programmeId),
  ])
  return rows.map((s) => ({ ...s, product: prods.session.get(s.id) ?? null }))
}

type SessionFields = Partial<
  Pick<ProgrammeSession, 'date' | 'startTime' | 'endTime' | 'venueId' | 'courtId' | 'title' | 'note' | 'status' | 'termId'>
>

function parseSessionFields(input: Record<string, unknown>): SessionFields {
  const out: SessionFields = {}
  if (has(input, 'date')) out.date = date(input.date, 'Date')
  if (has(input, 'startTime')) out.startTime = timeOrNull(input.startTime, 'Start time')
  if (has(input, 'endTime')) out.endTime = timeOrNull(input.endTime, 'Finish time')
  if (has(input, 'venueId')) out.venueId = idOrNull(input.venueId, 'Venue')
  if (has(input, 'courtId')) out.courtId = idOrNull(input.courtId, 'Court')
  if (has(input, 'title')) out.title = optionalText(input.title, 'Title', INSTANCE_LIMITS.title)
  if (has(input, 'note')) out.note = optionalText(input.note, 'Note', INSTANCE_LIMITS.note)
  if (has(input, 'status')) out.status = status(input.status)
  if (has(input, 'termId')) out.termId = idOrNull(input.termId, 'Term')
  return out
}

export type AddSessionsInput = Record<string, unknown> & {
  /** One date … */
  date?: unknown
  /** … or a weekly run from `from` to `to` on `weekday` (default: the term's, else the programme's day). */
  from?: unknown
  to?: unknown
  weekday?: unknown
  everyWeeks?: unknown
  /** Dates to leave out of the run (public holidays). */
  skip?: unknown
}

/**
 * Adds one session, or one per week between two dates, to a training programme (or a development term with termId).
 * Times, venue and court default to the term's, then the programme's. Dates that already have a session are skipped.
 */
export async function addSessions(
  db: AppDb,
  actor: Editor,
  programmeId: string,
  input: AddSessionsInput,
  now = new Date(),
): Promise<Changed<{ added: SessionRow[]; skipped: string[] }>> {
  const p = await loadProgramme(db, programmeId, ['training', 'development'], 'sessions')
  const fields = parseSessionFields(input)
  const caps = parseCaps(input)
  delete fields.date
  const term = fields.termId
    ? await db
        .select()
        .from(developmentTerms)
        .where(and(eq(developmentTerms.id, fields.termId), eq(developmentTerms.programmeId, programmeId)))
        .get()
    : null
  if (fields.termId && !term) throw invalid('That term no longer exists.')
  if (p.kind === 'development' && !term) throw invalid('Development sessions belong to a term: pick one.')
  if (p.kind === 'training' && term) throw invalid('Training sessions don’t belong to terms.')

  let dates: string[]
  if (input.date !== undefined) dates = [date(input.date, 'Date')]
  else {
    const from = date(input.from, 'From')
    const to = date(input.to, 'To')
    if (to < from) throw invalid('The run must end on or after it starts.')
    const weekday = input.weekday === undefined ? (term?.weekday ?? p.weekday) : int(input.weekday, 'Day', 0, 6)
    const everyWeeks = input.everyWeeks === undefined ? 1 : int(input.everyWeeks, 'Every … weeks', 1, 8)
    const skip = input.skip === undefined ? [] : Array.isArray(input.skip) ? input.skip.map((d) => date(d, 'Skipped date')) : []
    dates = weeklyDates(from, to, weekday, { everyWeeks, skip, max: MAX_RUN + 1 })
    if (dates.length > MAX_RUN) throw invalid(`That's more than ${MAX_RUN} sessions. Add them in shorter runs.`)
  }
  if (dates.length === 0) throw invalid('No dates in that range fall on that day.')

  const values = {
    startTime: fields.startTime !== undefined ? fields.startTime : (term?.startTime ?? p.startTime),
    endTime: fields.endTime !== undefined ? fields.endTime : (term?.endTime ?? p.endTime),
    venueId: fields.venueId !== undefined ? fields.venueId : (term?.venueId ?? null),
    courtId: fields.courtId !== undefined ? fields.courtId : (term?.courtId ?? null),
  }
  checkTimes(values.startTime, values.endTime)
  await checkPlace(db, values.venueId, values.courtId)

  const existing = await db
    .select({ date: programmeSessions.date })
    .from(programmeSessions)
    .where(
      and(
        eq(programmeSessions.programmeId, programmeId),
        term ? eq(programmeSessions.termId, term.id) : isNull(programmeSessions.termId),
        inArray(programmeSessions.date, dates),
      ),
    )
    .all()
  const taken = new Set(existing.map((e) => e.date))
  const fresh = dates.filter((d) => !taken.has(d))
  const skipped = dates.filter((d) => taken.has(d))
  if (fresh.length === 0) return { result: { added: [], skipped }, purge: {} }

  const at = now.toISOString()
  const rows = fresh.map((d) => ({
    id: crypto.randomUUID(),
    programmeId,
    date: d,
    status: (fields.status ?? 'scheduled') as OccurrenceStatus,
    ...(term ? { termId: term.id } : {}),
    ...Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null)),
    ...(fields.title ? { title: fields.title } : {}),
    ...(fields.note ? { note: fields.note } : {}),
    updatedBy: actor.id,
  }))
  // Term sessions are enrolled through the term, so only training sessions get a product.
  const productRows = term
    ? []
    : rows.map((r) => productRow(p, { kind: 'training_session', sessionId: r.id }, `${p.name} ${r.date}`, r.date, null, caps))
  await runBatch(db, [
    ...chunkByParams(rows).map((chunk) => db.insert(programmeSessions).values(chunk)),
    ...chunkByParams(productRows as Record<string, unknown>[]).map((chunk) => db.insert(products).values(chunk as NewProduct[])),
    audit(
      db,
      actor,
      'session.create',
      { type: 'programme', id: programmeId },
      null,
      { dates: fresh, termId: term?.id ?? null, ...values, ...caps },
      at,
    ),
  ])
  const added = (await listSessions(db, programmeId, { termId: term?.id ?? null })).filter((s) => fresh.includes(s.date))
  return { result: { added, skipped }, purge: await schedulePurge(db, p) }
}

async function loadSession(db: AppDb, id: string) {
  const s = await db.select().from(programmeSessions).where(eq(programmeSessions.id, id)).get()
  if (!s) throw notFound('session')
  return s
}

/** Edits a session: date (the first date is kept as original_date), times, place, title, note, status, its caps. */
export async function updateSession(
  db: AppDb,
  actor: Editor,
  id: string,
  input: Record<string, unknown>,
  now = new Date(),
): Promise<Changed<SessionRow>> {
  const current = await loadSession(db, id)
  const p = await loadProgramme(db, current.programmeId, ['training', 'development'], 'sessions')
  if (typeof input.baseUpdatedAt === 'string' && input.baseUpdatedAt !== current.updatedAt)
    throw conflict('Someone else changed this session while you were working on it. Reload to see their changes.')
  const fields = parseSessionFields(input)
  delete fields.termId
  const caps = parseCaps(input)
  const next = { ...current, ...fields }
  checkTimes(next.startTime, next.endTime)
  if (fields.venueId !== undefined || fields.courtId !== undefined) await checkPlace(db, next.venueId, next.courtId)
  if (next.date !== current.date) {
    const clash = await db
      .select({ id: programmeSessions.id })
      .from(programmeSessions)
      .where(
        and(
          eq(programmeSessions.programmeId, current.programmeId),
          current.termId ? eq(programmeSessions.termId, current.termId) : isNull(programmeSessions.termId),
          eq(programmeSessions.date, next.date),
          ne(programmeSessions.id, id),
        ),
      )
      .get()
    if (clash) throw conflict(`There's already a session on ${next.date}.`)
  }
  const originalDate =
    next.date === current.date
      ? current.originalDate
      : (current.originalDate ?? current.date) === next.date
        ? null
        : (current.originalDate ?? current.date)
  const keys = (Object.keys(fields) as (keyof SessionFields)[]).filter((k) => current[k] !== next[k])
  if (keys.length === 0 && Object.keys(caps).length === 0) {
    const prods = await productsOf(db, p.id)
    return { result: { ...current, product: prods.session.get(id) ?? null }, purge: {} }
  }
  const at = now.toISOString()
  const action: AuditAction =
    keys.length === 1 && keys[0] === 'status' && Object.keys(caps).length === 0 ? 'session.status' : 'session.update'
  const pick = (s: ProgrammeSession) => Object.fromEntries(keys.map((k) => [k, s[k]]))
  await runBatch(db, [
    db
      .update(programmeSessions)
      .set({ ...fields, originalDate, updatedAt: at, updatedBy: actor.id })
      .where(eq(programmeSessions.id, id)),
    ...(current.termId
      ? []
      : [productUpdate(db, actor, eq(products.sessionId, id), caps, { name: `${p.name} ${next.date}`, startsOn: next.date }, at)]),
    audit(db, actor, action, { type: 'session', id }, pick(current), { ...pick(next as ProgrammeSession), ...caps }, at),
  ])
  const prods = await productsOf(db, p.id)
  return { result: { ...(await loadSession(db, id)), product: prods.session.get(id) ?? null }, purge: await schedulePurge(db, p) }
}

export async function deleteSession(db: AppDb, actor: Editor, id: string, now = new Date()): Promise<Changed<{ id: string }>> {
  const s = await loadSession(db, id)
  const p = await loadProgramme(db, s.programmeId, ['training', 'development'], 'sessions')
  const product = await db.select({ id: products.id }).from(products).where(eq(products.sessionId, id)).get()
  await assertNoEnrolments(db, product?.id, 'session')
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(programmeSessions).where(eq(programmeSessions.id, id)),
    audit(db, actor, 'session.delete', { type: 'session', id }, { programmeId: s.programmeId, termId: s.termId, date: s.date }, null, at),
  ])
  return { result: { id }, purge: await schedulePurge(db, p) }
}

// ── Development terms ─────────────────────────────────────────────────────────

export type TermRow = DevelopmentTerm & { sessions: number; product: InstanceProduct | null; path: string }

export async function listTerms(db: AppDb, programmeId: string): Promise<TermRow[]> {
  const p = await loadProgramme(db, programmeId, ['development'], 'terms')
  const [rows, counts, prods] = await Promise.all([
    db.select().from(developmentTerms).where(eq(developmentTerms.programmeId, programmeId)).orderBy(asc(developmentTerms.startDate)).all(),
    db
      .select({ termId: programmeSessions.termId, n: count() })
      .from(programmeSessions)
      .where(eq(programmeSessions.programmeId, programmeId))
      .groupBy(programmeSessions.termId)
      .all(),
    productsOf(db, programmeId),
  ])
  return rows.map((t) => ({
    ...t,
    sessions: counts.find((c) => c.termId === t.id)?.n ?? 0,
    product: prods.term.get(t.id) ?? null,
    path: `${programmePath(p.kind, p.slug)}/${t.slug}`,
  }))
}

type TermFields = Partial<
  Pick<
    DevelopmentTerm,
    | 'name'
    | 'slug'
    | 'startDate'
    | 'endDate'
    | 'weekday'
    | 'startTime'
    | 'endTime'
    | 'venueId'
    | 'courtId'
    | 'ageGroup'
    | 'status'
    | 'note'
    | 'sort'
  >
>

function parseTermFields(input: Record<string, unknown>): TermFields {
  const out: TermFields = {}
  if (has(input, 'name')) out.name = requiredText(input.name, 'Name', INSTANCE_LIMITS.name)
  if (has(input, 'slug')) out.slug = parseSlug(input.slug)
  if (has(input, 'startDate')) out.startDate = date(input.startDate, 'Start date')
  if (has(input, 'endDate')) out.endDate = dateOrNull(input.endDate, 'End date')
  if (has(input, 'weekday')) out.weekday = intOrNull(input.weekday, 'Day', 0, 6)
  if (has(input, 'startTime')) out.startTime = timeOrNull(input.startTime, 'Start time')
  if (has(input, 'endTime')) out.endTime = timeOrNull(input.endTime, 'Finish time')
  if (has(input, 'venueId')) out.venueId = idOrNull(input.venueId, 'Venue')
  if (has(input, 'courtId')) out.courtId = idOrNull(input.courtId, 'Court')
  if (has(input, 'ageGroup')) out.ageGroup = optionalText(input.ageGroup, 'Age group', INSTANCE_LIMITS.ageGroup)
  if (has(input, 'status')) out.status = status(input.status)
  if (has(input, 'note')) out.note = optionalText(input.note, 'Note', INSTANCE_LIMITS.note)
  if (has(input, 'sort')) out.sort = int(input.sort, 'Order', -1_000_000, 1_000_000)
  return out
}

const checkRange = (start: string, end: string | null) => {
  if (end && end < start) throw invalid('The end date is before the start date.')
}

const termSlugTaken = (s: string) => conflict(`Another term of this programme already uses the URL name “${s}”.`)

/**
 * A new term (with its product), and optionally its weekly sessions from the start to the end date
 * (`addSessions: true`, needs an end date).
 */
export async function createTerm(
  db: AppDb,
  actor: Editor,
  programmeId: string,
  input: Record<string, unknown> & { addSessions?: unknown },
  now = new Date(),
): Promise<Changed<TermRow>> {
  const p = await loadProgramme(db, programmeId, ['development'], 'terms')
  const fields = parseTermFields(input)
  const caps = parseCaps(input)
  if (!fields.name) throw invalid('Name is required (like “Term 4 2026”).')
  if (!fields.startDate) throw invalid('Start date is required.')
  const s = fields.slug ?? parseSlug(slugify(fields.name))
  checkRange(fields.startDate, fields.endDate ?? null)
  checkTimes(fields.startTime, fields.endTime)
  await checkPlace(db, fields.venueId, fields.courtId)
  const taken = await db
    .select({ id: developmentTerms.id })
    .from(developmentTerms)
    .where(and(eq(developmentTerms.programmeId, programmeId), eq(developmentTerms.slug, s)))
    .get()
  if (taken) throw termSlugTaken(s)
  const withSessions = input.addSessions === true
  if (withSessions && !fields.endDate) throw invalid('Set an end date to add the weekly sessions.')
  const term = {
    ...fields,
    name: fields.name,
    startDate: fields.startDate,
    slug: s,
    id: crypto.randomUUID(),
    programmeId,
    status: fields.status ?? 'scheduled',
    sort: fields.sort ?? 0,
    updatedBy: actor.id,
  }
  const at = now.toISOString()
  const product = productRow(
    p,
    { kind: 'development_term', termId: term.id },
    `${p.name} ${term.name}`,
    term.startDate,
    term.endDate ?? null,
    caps,
  )
  try {
    await runBatch(db, [
      db.insert(developmentTerms).values({ ...term, createdAt: at, updatedAt: at }),
      db.insert(products).values(product),
      audit(db, actor, 'term.create', { type: 'term', id: term.id }, null, { ...term, ...caps }, at),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'development_terms.')) throw termSlugTaken(s)
    throw e
  }
  if (withSessions) await addSessions(db, actor, programmeId, { termId: term.id, from: term.startDate, to: term.endDate }, now)
  const row = (await listTerms(db, programmeId)).find((t) => t.id === term.id)!
  return { result: row, purge: await schedulePurge(db, p) }
}

export async function updateTerm(
  db: AppDb,
  actor: Editor,
  id: string,
  input: Record<string, unknown>,
  now = new Date(),
): Promise<Changed<TermRow>> {
  const current = await db.select().from(developmentTerms).where(eq(developmentTerms.id, id)).get()
  if (!current) throw notFound('term')
  const p = await loadProgramme(db, current.programmeId, ['development'], 'terms')
  if (typeof input.baseUpdatedAt === 'string' && input.baseUpdatedAt !== current.updatedAt)
    throw conflict('Someone else changed this term while you were working on it. Reload to see their changes.')
  const fields = parseTermFields(input)
  const caps = parseCaps(input)
  const next = { ...current, ...fields }
  checkRange(next.startDate, next.endDate)
  checkTimes(next.startTime, next.endTime)
  if (fields.venueId !== undefined || fields.courtId !== undefined) await checkPlace(db, next.venueId, next.courtId)
  if (next.slug !== current.slug) {
    const taken = await db
      .select({ id: developmentTerms.id })
      .from(developmentTerms)
      .where(and(eq(developmentTerms.programmeId, p.id), eq(developmentTerms.slug, next.slug), ne(developmentTerms.id, id)))
      .get()
    if (taken) throw termSlugTaken(next.slug)
  }
  const keys = (Object.keys(fields) as (keyof TermFields)[]).filter((k) => current[k] !== next[k])
  if (keys.length === 0 && Object.keys(caps).length === 0)
    return { result: (await listTerms(db, p.id)).find((t) => t.id === id)!, purge: {} }
  const at = now.toISOString()
  const base = programmePath(p.kind, p.slug)
  const moved = next.slug !== current.slug && p.status !== 'draft'
  const pick = (t: DevelopmentTerm) => Object.fromEntries(keys.map((k) => [k, t[k]]))
  const action: AuditAction = keys.length === 1 && keys[0] === 'status' && Object.keys(caps).length === 0 ? 'term.status' : 'term.update'
  try {
    await runBatch(db, [
      db
        .update(developmentTerms)
        .set({ ...fields, updatedAt: at, updatedBy: actor.id })
        .where(eq(developmentTerms.id, id)),
      productUpdate(
        db,
        actor,
        eq(products.termId, id),
        caps,
        { name: `${p.name} ${next.name}`, startsOn: next.startDate, endsOn: next.endDate },
        at,
      ),
      audit(db, actor, action, { type: 'term', id }, pick(current), { ...pick(next), ...caps }, at),
      ...(moved ? moveTreeStatements(db, { from: `${base}/${current.slug}`, to: `${base}/${next.slug}` }, [], actor, at) : []),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'development_terms.')) throw termSlugTaken(next.slug)
    throw e
  }
  return { result: (await listTerms(db, p.id)).find((t) => t.id === id)!, purge: await schedulePurge(db, p) }
}

/** Deletes a term and its sessions, unless anyone enrolled. */
export async function deleteTerm(db: AppDb, actor: Editor, id: string, now = new Date()): Promise<Changed<{ id: string }>> {
  const t = await db.select().from(developmentTerms).where(eq(developmentTerms.id, id)).get()
  if (!t) throw notFound('term')
  const p = await loadProgramme(db, t.programmeId, ['development'], 'terms')
  const product = await db.select({ id: products.id }).from(products).where(eq(products.termId, id)).get()
  await assertNoEnrolments(db, product?.id, 'term')
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(developmentTerms).where(eq(developmentTerms.id, id)),
    audit(
      db,
      actor,
      'term.delete',
      { type: 'term', id },
      { programmeId: t.programmeId, name: t.name, slug: t.slug, startDate: t.startDate },
      null,
      at,
    ),
  ])
  return { result: { id }, purge: await schedulePurge(db, p) }
}

// ── Events ────────────────────────────────────────────────────────────────────

export type EventRow = ProgrammeEvent & { product: InstanceProduct | null; path: string }

export async function listEvents(db: AppDb, programmeId: string): Promise<EventRow[]> {
  const p = await loadProgramme(db, programmeId, ['event'], 'event dates')
  const [rows, prods] = await Promise.all([
    db.select().from(events).where(eq(events.programmeId, programmeId)).orderBy(asc(events.startDate)).all(),
    productsOf(db, programmeId),
  ])
  return rows.map((e) => ({ ...e, product: prods.event.get(e.id) ?? null, path: `${programmePath(p.kind, p.slug)}/${e.slug}` }))
}

type EventFields = Partial<
  Pick<ProgrammeEvent, 'name' | 'slug' | 'startDate' | 'endDate' | 'startTime' | 'endTime' | 'venueId' | 'status' | 'note'>
>

function parseEventFields(input: Record<string, unknown>): EventFields {
  const out: EventFields = {}
  if (has(input, 'name')) out.name = requiredText(input.name, 'Name', INSTANCE_LIMITS.name)
  if (has(input, 'slug')) out.slug = parseSlug(input.slug)
  if (has(input, 'startDate')) out.startDate = date(input.startDate, 'Start date')
  if (has(input, 'endDate')) out.endDate = dateOrNull(input.endDate, 'End date')
  if (has(input, 'startTime')) out.startTime = timeOrNull(input.startTime, 'Start time')
  if (has(input, 'endTime')) out.endTime = timeOrNull(input.endTime, 'Finish time')
  if (has(input, 'venueId')) out.venueId = idOrNull(input.venueId, 'Venue')
  if (has(input, 'status')) out.status = status(input.status)
  if (has(input, 'note')) out.note = optionalText(input.note, 'Note', INSTANCE_LIMITS.note)
  return out
}

const eventSlugTaken = (s: string) => conflict(`Another date of this event already uses the URL name “${s}”.`)

/** One occurrence of an event (Tempe Cup 2026): a date or a short range, with its product. */
export async function createEvent(
  db: AppDb,
  actor: Editor,
  programmeId: string,
  input: Record<string, unknown>,
  now = new Date(),
): Promise<Changed<EventRow>> {
  const p = await loadProgramme(db, programmeId, ['event'], 'event dates')
  const fields = parseEventFields(input)
  const caps = parseCaps(input)
  if (!fields.startDate) throw invalid('Start date is required.')
  const name = fields.name ?? `${p.name} ${fields.startDate.slice(0, 4)}`
  const s = fields.slug ?? parseSlug(slugify(name))
  checkRange(fields.startDate, fields.endDate ?? null)
  if (fields.endDate === fields.startDate) fields.endDate = null
  checkTimes(fields.startTime, fields.endTime)
  await checkPlace(db, fields.venueId, null)
  const taken = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.programmeId, programmeId), eq(events.slug, s)))
    .get()
  if (taken) throw eventSlugTaken(s)
  const ev = {
    ...fields,
    name,
    slug: s,
    startDate: fields.startDate,
    id: crypto.randomUUID(),
    programmeId,
    status: fields.status ?? 'scheduled',
    updatedBy: actor.id,
  }
  const at = now.toISOString()
  try {
    await runBatch(db, [
      db.insert(events).values({ ...ev, createdAt: at, updatedAt: at }),
      db.insert(products).values(productRow(p, { kind: 'event_entry', eventId: ev.id }, name, ev.startDate, ev.endDate ?? null, caps)),
      audit(db, actor, 'event.create', { type: 'event', id: ev.id }, null, { ...ev, ...caps }, at),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'events.')) throw eventSlugTaken(s)
    throw e
  }
  return { result: (await listEvents(db, programmeId)).find((x) => x.id === ev.id)!, purge: await schedulePurge(db, p) }
}

export async function updateEvent(
  db: AppDb,
  actor: Editor,
  id: string,
  input: Record<string, unknown>,
  now = new Date(),
): Promise<Changed<EventRow>> {
  const current = await db.select().from(events).where(eq(events.id, id)).get()
  if (!current) throw notFound('event')
  const p = await loadProgramme(db, current.programmeId, ['event'], 'event dates')
  if (typeof input.baseUpdatedAt === 'string' && input.baseUpdatedAt !== current.updatedAt)
    throw conflict('Someone else changed this event while you were working on it. Reload to see their changes.')
  const fields = parseEventFields(input)
  const caps = parseCaps(input)
  const next = { ...current, ...fields }
  if (next.endDate === next.startDate) next.endDate = fields.endDate = null
  checkRange(next.startDate, next.endDate)
  checkTimes(next.startTime, next.endTime)
  if (fields.venueId !== undefined) await checkPlace(db, next.venueId, null)
  if (next.slug !== current.slug) {
    const taken = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.programmeId, p.id), eq(events.slug, next.slug), ne(events.id, id)))
      .get()
    if (taken) throw eventSlugTaken(next.slug)
  }
  const keys = (Object.keys(fields) as (keyof EventFields)[]).filter((k) => current[k] !== next[k])
  if (keys.length === 0 && Object.keys(caps).length === 0)
    return { result: (await listEvents(db, p.id)).find((x) => x.id === id)!, purge: {} }
  const original =
    next.startDate === current.startDate
      ? current.originalStartDate
      : (current.originalStartDate ?? current.startDate) === next.startDate
        ? null
        : (current.originalStartDate ?? current.startDate)
  const at = now.toISOString()
  const base = programmePath(p.kind, p.slug)
  const moved = next.slug !== current.slug && p.status !== 'draft'
  const pick = (e: ProgrammeEvent) => Object.fromEntries(keys.map((k) => [k, e[k]]))
  const action: AuditAction = keys.length === 1 && keys[0] === 'status' && Object.keys(caps).length === 0 ? 'event.status' : 'event.update'
  try {
    await runBatch(db, [
      db
        .update(events)
        .set({ ...fields, originalStartDate: original, updatedAt: at, updatedBy: actor.id })
        .where(eq(events.id, id)),
      productUpdate(db, actor, eq(products.eventId, id), caps, { name: next.name, startsOn: next.startDate, endsOn: next.endDate }, at),
      audit(db, actor, action, { type: 'event', id }, pick(current), { ...pick(next), ...caps }, at),
      ...(moved ? moveTreeStatements(db, { from: `${base}/${current.slug}`, to: `${base}/${next.slug}` }, [], actor, at) : []),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'events.')) throw eventSlugTaken(next.slug)
    throw e
  }
  return { result: (await listEvents(db, p.id)).find((x) => x.id === id)!, purge: await schedulePurge(db, p) }
}

export async function deleteEvent(db: AppDb, actor: Editor, id: string, now = new Date()): Promise<Changed<{ id: string }>> {
  const ev = await db.select().from(events).where(eq(events.id, id)).get()
  if (!ev) throw notFound('event')
  const p = await loadProgramme(db, ev.programmeId, ['event'], 'event dates')
  const product = await db.select({ id: products.id }).from(products).where(eq(products.eventId, id)).get()
  await assertNoEnrolments(db, product?.id, 'event')
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(events).where(eq(events.id, id)),
    audit(
      db,
      actor,
      'event.delete',
      { type: 'event', id },
      { programmeId: ev.programmeId, name: ev.name, startDate: ev.startDate },
      null,
      at,
    ),
  ])
  return { result: { id }, purge: await schedulePurge(db, p) }
}
