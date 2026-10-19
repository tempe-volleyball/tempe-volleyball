import { and, asc, count, eq, gte, inArray, isNull, min, ne, or } from 'drizzle-orm'
import { slugify } from '../../lib/content/paths'
import { generatedInterestLine, generatedSummaryLine, nextStartsLine, scheduleText, summaryLine } from '../../lib/programme-text'
import { enrolmentOpen, isReservedProgrammeSlug, programmePath } from '../../lib/programmes'
import { sydneyDate } from '../../lib/time'
import { tags, type PurgeTargets } from '../cache'
import { runBatch, type AppDb } from '../db'
import {
  categories,
  defaultSignupMode,
  developmentTerms,
  enrolmentForms,
  events,
  leagueFormats,
  menuItems,
  pageDataRefs,
  pages,
  products,
  programmeKinds,
  programmes,
  programmeSessions,
  PROGRAMME_CODE_PATTERN,
  seasons,
  signupModes,
  venues,
  type Category,
  type NewProgramme,
  type Programme,
  type ProgrammeKind,
  type ProgrammeStatus,
  type SignupMode,
  type Venue,
} from '../db/schema'
import {
  assertMedia,
  audit,
  conflict,
  isUniqueFailure,
  notFound,
  optionalText,
  requiredText,
  type Changed,
  type Editor,
} from '../content/common'
import {
  assertNoPageAt,
  blockPageTags,
  bool,
  dateOrNull,
  has,
  idOrNull,
  instantOrNull,
  int,
  intOrNull,
  invalid,
  linkOrNull,
  moveTreeStatements,
  programmeTags,
  purgeOf,
  requiredId,
  richText,
  slug as parseSlug,
  timeOrNull,
} from './common'

// Programmes in the admin (docs/admin.md §3.1, §3.3; API in docs/api/programmes.md): leagues, training, development
// programmes and events share one table (`leagues`, exported as `programmes`). This module creates, edits, changes
// the status of and deletes them. Seasons stay in src/server/competition; sessions, terms and events are schedule.ts.
//
// Rules:
//  - The kind is fixed at creation. Code and slug are unique across every kind.
//  - Every programme needs a category; it can't go live without one (imported leagues may start with none).
//  - Status: draft -> active -> retired -> active. Back to draft only while it has no history. `active` (the old
//    boolean) is kept equal to status = 'active'.
//  - A slug change on a programme that has been public leaves 301s for its page and every page under it.
//  - Delete only while it has no seasons, sessions, terms, events or products, isn't in the menu and no page block
//    uses it. After that it can only be retired.
//  - Writes take baseUpdatedAt (409 if someone saved since), run as one batch with their audit row, and report which
//    public pages to purge.

export const PROGRAMME_LIMITS = {
  name: 120,
  line: 200,
  seoTitle: 120,
  seoDescription: 300,
  cap: 10_000,
  priceCents: 10_000_000,
  offerHours: 720,
  age: 99,
  interestText: 500,
} as const

export const KIND_LABEL: Record<ProgrammeKind, string> = {
  league: 'league',
  training: 'training program',
  development: 'development program',
  event: 'event',
}

const staleProgramme = () =>
  conflict('Someone else changed this programme while you were working on it. Reload to see their changes (copy yours first).')

// ── Next start dates ──────────────────────────────────────────────────────────

/**
 * The queries behind nextInstanceDates(), for callers that fold them into a bigger batch: each returns
 * { programmeId, date } rows, the earliest upcoming season (not archived), training session (scheduled, not part of
 * a term), development term or event (not cancelled) on or after `today` (YYYY-MM-DD, Sydney).
 */
export const nextInstanceQueries = (db: AppDb, today: string) => [
  db
    .select({ programmeId: seasons.leagueId, date: min(seasons.startDate) })
    .from(seasons)
    .where(and(gte(seasons.startDate, today), ne(seasons.status, 'archived')))
    .groupBy(seasons.leagueId),
  db
    .select({ programmeId: programmeSessions.programmeId, date: min(programmeSessions.date) })
    .from(programmeSessions)
    .where(and(gte(programmeSessions.date, today), eq(programmeSessions.status, 'scheduled'), isNull(programmeSessions.termId)))
    .groupBy(programmeSessions.programmeId),
  db
    .select({ programmeId: developmentTerms.programmeId, date: min(developmentTerms.startDate) })
    .from(developmentTerms)
    .where(and(gte(developmentTerms.startDate, today), ne(developmentTerms.status, 'cancelled')))
    .groupBy(developmentTerms.programmeId),
  db
    .select({ programmeId: events.programmeId, date: min(events.startDate) })
    .from(events)
    .where(and(gte(events.startDate, today), ne(events.status, 'cancelled')))
    .groupBy(events.programmeId),
]

type DateRow = { programmeId: string; date: string | null }

/** Folds nextInstanceQueries() results into programme id -> earliest date. */
export function nextInstanceMap(results: DateRow[][]): Map<string, string> {
  const out = new Map<string, string>()
  for (const rows of results)
    for (const r of rows) {
      if (!r.date) continue
      const cur = out.get(r.programmeId)
      if (!cur || r.date < cur) out.set(r.programmeId, r.date)
    }
  return out
}

/** Programme id -> the start date of its next season, session, term or event (see nextInstanceQueries). */
export async function nextInstanceDates(db: AppDb, today: string): Promise<Map<string, string>> {
  const [first, ...rest] = nextInstanceQueries(db, today)
  return nextInstanceMap((await runBatch(db, [first!, ...rest])) as unknown as DateRow[][])
}

// ── Reading ───────────────────────────────────────────────────────────────────

export type CategoryRef = Pick<Category, 'id' | 'name' | 'slug' | 'status'>
export type VenueRef = Pick<Venue, 'id' | 'name' | 'address'>

/** What the admin shows generated, next to the hand-editable fields. */
export type ProgrammeGenerated = {
  /** The generated summary line (what shows when summaryLine is null). */
  summaryLine: string
  /** What's shown now: summaryLine ?? generated. */
  shownSummaryLine: string
  /** Day and times as shown (scheduleLabel ?? generated). */
  schedule: string
  /** The generated day and times, ignoring scheduleLabel. */
  generatedSchedule: string
  /** "Next season starts …" as shown, or ''. */
  nextStarts: string
  /** The next season/session/term/event start date found, if any. */
  nextInstanceDate: string | null
  /** How it takes sign-ups now (signupMode, else the kind's default), and that default. */
  signupMode: SignupMode
  defaultSignupMode: SignupMode
  /** The join section's generated line (what shows when interestText is empty). */
  interestLine: string
}

export type ProgrammeListItem = Omit<Programme, 'description'> & {
  path: string
  category: CategoryRef | null
  venue: VenueRef | null
  generated: ProgrammeGenerated
  /** Enrolment is open right now (switch, status and window). */
  enrolmentOpenNow: boolean
  /** Seasons (leagues), sessions (training), terms (development) or events (events). */
  instances: number
}

export function generatedFor(p: Programme, venue: VenueRef | null, nextInstanceDate: string | null): ProgrammeGenerated {
  return {
    summaryLine: generatedSummaryLine(p, venue),
    shownSummaryLine: summaryLine(p, venue),
    schedule: scheduleText(p),
    generatedSchedule: scheduleText({ ...p, scheduleLabel: null }),
    nextStarts: nextStartsLine(p, nextInstanceDate),
    nextInstanceDate,
    signupMode: p.signupMode ?? defaultSignupMode(p.kind),
    defaultSignupMode: defaultSignupMode(p.kind),
    interestLine: generatedInterestLine(nextStartsLine(p, nextInstanceDate)),
  }
}

const enrolmentOpenNow = (p: Programme, now: Date) =>
  enrolmentOpen(
    { open: p.enrolmentOpen, status: p.status, opensAt: p.enrolmentOpensAt, closesAt: p.enrolmentClosesAt },
    null,
    now.toISOString(),
  )

const categoryRef = { id: categories.id, name: categories.name, slug: categories.slug, status: categories.status }
const venueRef = { id: venues.id, name: venues.name, address: venues.address }

type CountRow = { programmeId: string; n: number }

/** Every programme (optionally of one kind) with its category, venue, generated text and instance count. One batch. */
export async function listProgrammes(db: AppDb, opts: { kind?: ProgrammeKind } = {}, now = new Date()): Promise<ProgrammeListItem[]> {
  const kind = opts.kind
  if (kind !== undefined && !programmeKinds.includes(kind)) throw invalid('Unknown programme kind.')
  const today = sydneyDate(now)
  const where = kind ? eq(programmes.kind, kind) : undefined
  const res = (await runBatch(db, [
    db.select().from(programmes).where(where).orderBy(asc(programmes.sort), asc(programmes.name)),
    db.select(categoryRef).from(categories),
    db.select(venueRef).from(venues),
    db.select({ programmeId: seasons.leagueId, n: count() }).from(seasons).groupBy(seasons.leagueId),
    db
      .select({ programmeId: programmeSessions.programmeId, n: count() })
      .from(programmeSessions)
      .where(isNull(programmeSessions.termId))
      .groupBy(programmeSessions.programmeId),
    db.select({ programmeId: developmentTerms.programmeId, n: count() }).from(developmentTerms).groupBy(developmentTerms.programmeId),
    db.select({ programmeId: events.programmeId, n: count() }).from(events).groupBy(events.programmeId),
    ...nextInstanceQueries(db, today),
  ])) as unknown as [Programme[], CategoryRef[], VenueRef[], CountRow[], CountRow[], CountRow[], CountRow[], ...DateRow[][]]
  const [rows, cats, vens, ...rest] = res
  const counts = new Map<string, number>()
  for (const list of rest.slice(0, 4) as CountRow[][])
    for (const r of list) counts.set(r.programmeId, (counts.get(r.programmeId) ?? 0) + r.n)
  const next = nextInstanceMap(rest.slice(4) as DateRow[][])
  const catById = new Map(cats.map((c) => [c.id, c]))
  const venueById = new Map(vens.map((v) => [v.id, v]))
  return rows.map(({ description: _description, ...p }) => {
    const venue = (p.defaultVenueId && venueById.get(p.defaultVenueId)) || null
    const full = { ...p, description: { blocks: [], html: '' } } as Programme
    return {
      ...p,
      path: programmePath(p.kind, p.slug),
      category: (p.categoryId && catById.get(p.categoryId)) || null,
      venue,
      generated: generatedFor(full, venue, next.get(p.id) ?? null),
      enrolmentOpenNow: enrolmentOpenNow(full, now),
      instances: counts.get(p.id) ?? 0,
    }
  })
}

/** What blocks deleting a programme (and going back to draft). */
export type ProgrammeHistory = {
  seasons: number
  sessions: number
  terms: number
  events: number
  products: number
  /** Menu items linking to it. */
  menuItems: { id: string; label: string }[]
  /** Pages whose Ladder or Fixtures blocks use it. */
  pages: { id: string; title: string; path: string }[]
}

export const hasHistory = (h: ProgrammeHistory) => h.seasons + h.sessions + h.terms + h.events + h.products > 0

/** Pickers for the programme form. Archived forms and retired categories are left out (but the current one shows). */
export type ProgrammeChoices = {
  categories: CategoryRef[]
  venues: VenueRef[]
  forms: { id: string; name: string; archived: boolean }[]
}

export type ProgrammeView = {
  programme: Programme
  path: string
  category: CategoryRef | null
  venue: VenueRef | null
  generated: ProgrammeGenerated
  enrolmentOpenNow: boolean
  history: ProgrammeHistory
  /** True when delete is allowed right now. */
  canDelete: boolean
  choices: ProgrammeChoices
}

const historyQueries = (db: AppDb, id: string) => [
  db.select({ n: count() }).from(seasons).where(eq(seasons.leagueId, id)),
  db.select({ n: count() }).from(programmeSessions).where(eq(programmeSessions.programmeId, id)),
  db.select({ n: count() }).from(developmentTerms).where(eq(developmentTerms.programmeId, id)),
  db.select({ n: count() }).from(events).where(eq(events.programmeId, id)),
  db.select({ n: count() }).from(products).where(eq(products.programmeId, id)),
  db.select({ id: menuItems.id, label: menuItems.label }).from(menuItems).where(eq(menuItems.leagueId, id)),
  db
    .selectDistinct({ id: pages.id, title: pages.title, path: pages.path })
    .from(pageDataRefs)
    .innerJoin(pages, eq(pages.id, pageDataRefs.pageId))
    .where(and(eq(pageDataRefs.refId, id), inArray(pageDataRefs.kind, ['ladder', 'fixtures']))),
]

type N = { n: number }[]
const historyOf = (r: unknown[]): ProgrammeHistory => {
  const [s, se, t, e, p, m, pg] = r as [N, N, N, N, N, ProgrammeHistory['menuItems'], ProgrammeHistory['pages']]
  return {
    seasons: s[0]?.n ?? 0,
    sessions: se[0]?.n ?? 0,
    terms: t[0]?.n ?? 0,
    events: e[0]?.n ?? 0,
    products: p[0]?.n ?? 0,
    menuItems: m,
    pages: pg,
  }
}

/** The pickers the programme form needs, for the "new programme" screen. */
export async function programmeChoices(db: AppDb): Promise<ProgrammeChoices> {
  const [cats, vens, forms] = (await runBatch(db, [
    db.select(categoryRef).from(categories).orderBy(asc(categories.sort), asc(categories.name)),
    db.select(venueRef).from(venues).orderBy(asc(venues.sort), asc(venues.name)),
    db
      .select({ id: enrolmentForms.id, name: enrolmentForms.name, archivedAt: enrolmentForms.archivedAt })
      .from(enrolmentForms)
      .orderBy(asc(enrolmentForms.name)),
  ])) as unknown as [CategoryRef[], VenueRef[], { id: string; name: string; archivedAt: string | null }[]]
  return { categories: cats, venues: vens, forms: forms.map((f) => ({ id: f.id, name: f.name, archived: !!f.archivedAt })) }
}

/** One programme with everything its admin screen needs. One batch plus the choices batch. */
export async function getProgramme(db: AppDb, id: string, now = new Date()): Promise<ProgrammeView> {
  const today = sydneyDate(now)
  const [rows, ...rest] = (await runBatch(db, [
    db.select().from(programmes).where(eq(programmes.id, id)),
    ...historyQueries(db, id),
    ...nextInstanceQueries(db, today),
  ])) as unknown as [Programme[], ...unknown[]]
  const p = rows[0]
  if (!p) throw notFound('programme')
  const history = historyOf(rest.slice(0, 7))
  const next = nextInstanceMap(rest.slice(7) as DateRow[][]).get(id) ?? null
  const choices = await programmeChoices(db)
  const venue = choices.venues.find((v) => v.id === p.defaultVenueId) ?? null
  return {
    programme: p,
    path: programmePath(p.kind, p.slug),
    category: choices.categories.find((c) => c.id === p.categoryId) ?? null,
    venue,
    generated: generatedFor(p, venue, next),
    enrolmentOpenNow: enrolmentOpenNow(p, now),
    history,
    canDelete: !hasHistory(history) && history.menuItems.length === 0 && history.pages.length === 0,
    choices,
  }
}

// ── Input ─────────────────────────────────────────────────────────────────────

export type ProgrammeInput = Record<string, unknown>

/** Fields that only change sign-ups: enrolment and expressions of interest (audited as programme.enrolment). */
const ENROLMENT_FIELDS = [
  'signupMode',
  'interestOpen',
  'depositPlayerCents',
  'depositTeamCents',
  'interestText',
  'enrolmentOpen',
  'enrolmentOpensAt',
  'enrolmentClosesAt',
  'nextStartsOn',
  'nextStartsText',
  'enrolmentFormId',
  'capTeams',
  'capPlayers',
  'priceCents',
  'allowTeamEntries',
  'allowFreeAgents',
  'waitlistEnabled',
  'waitlistOfferHours',
  'enrolmentEmailConfirm',
] as const satisfies readonly (keyof Programme)[]

/** Every field the admin can edit (status has its own endpoint, kind is fixed). */
export const EDITABLE_FIELDS = [
  'name',
  'code',
  'slug',
  'categoryId',
  'weekday',
  'defaultVenueId',
  'format',
  'sort',
  'startTime',
  'endTime',
  'scheduleLabel',
  'description',
  'summaryLine',
  'moreInfoUrl',
  'menuVisible',
  'ageMin',
  'ageMax',
  'seoTitle',
  'seoDescription',
  'imageId',
  ...ENROLMENT_FIELDS,
] as const

type Editable = (typeof EDITABLE_FIELDS)[number]
type Patch = Partial<Pick<NewProgramme, Editable>>

/** Checks the fields the client sent (shape only; references are checked against the database separately). */
export function parseProgrammeFields(input: ProgrammeInput): Patch {
  const out: Patch = {}
  const L = PROGRAMME_LIMITS
  if (has(input, 'name')) out.name = requiredText(input.name, 'Name', L.name)
  if (has(input, 'code')) {
    const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : ''
    if (!PROGRAMME_CODE_PATTERN.test(code))
      throw invalid('Code: use 1–16 capital letters, digits or hyphens, starting with a letter or digit (like TNL or ADP).')
    out.code = code
  }
  if (has(input, 'slug')) out.slug = parseSlug(input.slug)
  if (out.slug && isReservedProgrammeSlug(out.slug)) throw invalid(`URL: “${out.slug}” is used by the site itself; pick another.`)
  if (has(input, 'categoryId')) out.categoryId = requiredId(input.categoryId, 'Category')
  if (has(input, 'weekday')) out.weekday = int(input.weekday, 'Day', 0, 6)
  if (has(input, 'defaultVenueId')) out.defaultVenueId = idOrNull(input.defaultVenueId, 'Venue')
  if (has(input, 'format')) {
    if (typeof input.format !== 'string' || !(leagueFormats as readonly string[]).includes(input.format)) throw invalid('Unknown format.')
    out.format = input.format as Programme['format']
  }
  if (has(input, 'sort')) out.sort = int(input.sort, 'Order', -1_000_000, 1_000_000)
  if (has(input, 'startTime')) out.startTime = timeOrNull(input.startTime, 'Start time')
  if (has(input, 'endTime')) out.endTime = timeOrNull(input.endTime, 'Finish time')
  if (has(input, 'scheduleLabel')) out.scheduleLabel = optionalText(input.scheduleLabel, 'Day and times', L.line)
  if (has(input, 'description')) out.description = richText(input.description)
  if (has(input, 'summaryLine')) out.summaryLine = optionalText(input.summaryLine, 'Summary line', L.line)
  if (has(input, 'moreInfoUrl')) out.moreInfoUrl = linkOrNull(input.moreInfoUrl, 'More info link')
  if (has(input, 'menuVisible')) out.menuVisible = bool(input.menuVisible, 'Show in the menu')
  if (has(input, 'ageMin')) out.ageMin = intOrNull(input.ageMin, 'Minimum age', 0, L.age)
  if (has(input, 'ageMax')) out.ageMax = intOrNull(input.ageMax, 'Maximum age', 0, L.age)
  if (has(input, 'seoTitle')) out.seoTitle = optionalText(input.seoTitle, 'Search title', L.seoTitle)
  if (has(input, 'seoDescription')) out.seoDescription = optionalText(input.seoDescription, 'Search description', L.seoDescription)
  if (has(input, 'imageId')) out.imageId = idOrNull(input.imageId, 'Image')
  if (has(input, 'enrolmentOpen')) out.enrolmentOpen = bool(input.enrolmentOpen, 'Enrolment open')
  if (has(input, 'enrolmentOpensAt')) out.enrolmentOpensAt = instantOrNull(input.enrolmentOpensAt, 'Enrolment opens')
  if (has(input, 'enrolmentClosesAt')) out.enrolmentClosesAt = instantOrNull(input.enrolmentClosesAt, 'Enrolment closes')
  if (has(input, 'nextStartsOn')) out.nextStartsOn = dateOrNull(input.nextStartsOn, 'Next start date')
  if (has(input, 'nextStartsText')) out.nextStartsText = optionalText(input.nextStartsText, 'Next start text', L.line)
  if (has(input, 'enrolmentFormId')) out.enrolmentFormId = idOrNull(input.enrolmentFormId, 'Enrolment form')
  if (has(input, 'capTeams')) out.capTeams = intOrNull(input.capTeams, 'Team cap', 0, L.cap)
  if (has(input, 'capPlayers')) out.capPlayers = intOrNull(input.capPlayers, 'Player cap', 0, L.cap)
  if (has(input, 'priceCents')) out.priceCents = intOrNull(input.priceCents, 'Price', 0, L.priceCents)
  if (has(input, 'allowTeamEntries')) out.allowTeamEntries = bool(input.allowTeamEntries, 'Team entries')
  if (has(input, 'allowFreeAgents')) out.allowFreeAgents = bool(input.allowFreeAgents, 'Free agents')
  if (has(input, 'waitlistEnabled')) out.waitlistEnabled = bool(input.waitlistEnabled, 'Waitlist')
  if (has(input, 'waitlistOfferHours')) out.waitlistOfferHours = int(input.waitlistOfferHours, 'Offer time (hours)', 1, L.offerHours)
  // Sign-ups (docs/interest.md): null mode = the kind's default.
  if (has(input, 'signupMode')) {
    const m = input.signupMode === '' ? null : input.signupMode
    if (m !== null && !(signupModes as readonly unknown[]).includes(m)) throw invalid('Sign-ups: expressions of interest or enrolment.')
    out.signupMode = m as SignupMode | null
  }
  if (has(input, 'interestOpen')) out.interestOpen = bool(input.interestOpen, 'Taking expressions of interest')
  if (has(input, 'depositPlayerCents')) out.depositPlayerCents = intOrNull(input.depositPlayerCents, 'Player deposit', 0, L.priceCents)
  if (has(input, 'depositTeamCents')) out.depositTeamCents = intOrNull(input.depositTeamCents, 'Team deposit', 0, L.priceCents)
  if (has(input, 'interestText')) out.interestText = optionalText(input.interestText, 'The join section text', L.interestText)
  // Null = automatic (on when capped), true = always, false = never.
  if (has(input, 'enrolmentEmailConfirm'))
    out.enrolmentEmailConfirm = input.enrolmentEmailConfirm === null ? null : bool(input.enrolmentEmailConfirm, 'Email confirmation')
  return out
}

/** Rules across fields, on the merged result. */
function checkMerged(
  p: Pick<Programme, 'kind' | 'ageMin' | 'ageMax' | 'enrolmentOpensAt' | 'enrolmentClosesAt' | 'startTime' | 'endTime'>,
) {
  if (p.ageMin !== null && p.ageMax !== null && p.ageMin > p.ageMax) throw invalid('The minimum age is above the maximum age.')
  if (p.enrolmentOpensAt && p.enrolmentClosesAt && p.enrolmentOpensAt >= p.enrolmentClosesAt)
    throw invalid('Enrolment must open before it closes.')
  if (p.startTime && p.endTime && p.endTime <= p.startTime) throw invalid('The finish time must be after the start time.')
  if (!p.startTime && p.endTime) throw invalid('Set a start time as well as the finish time.')
}

/** Checks that the ids the patch points at exist (category, venue, form, image) and the code, slug and URL are free. */
async function checkReferences(db: AppDb, patch: Patch, kind: ProgrammeKind, current: Programme | null) {
  const changed = <K extends keyof Patch>(k: K) => patch[k] !== undefined && (!current || patch[k] !== current[k as keyof Programme])
  const checks: Promise<unknown>[] = []
  if (changed('categoryId') && patch.categoryId) {
    checks.push(
      db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.id, patch.categoryId))
        .get()
        .then((r) => {
          if (!r) throw invalid('That category no longer exists.')
        }),
    )
  }
  if (changed('defaultVenueId') && patch.defaultVenueId) {
    checks.push(
      db
        .select({ id: venues.id })
        .from(venues)
        .where(eq(venues.id, patch.defaultVenueId))
        .get()
        .then((r) => {
          if (!r) throw invalid('That venue no longer exists.')
        }),
    )
  }
  if (changed('enrolmentFormId') && patch.enrolmentFormId) {
    checks.push(
      db
        .select({ id: enrolmentForms.id, archivedAt: enrolmentForms.archivedAt })
        .from(enrolmentForms)
        .where(eq(enrolmentForms.id, patch.enrolmentFormId))
        .get()
        .then((r) => {
          if (!r) throw invalid('That enrolment form no longer exists.')
          if (r.archivedAt) throw invalid('That enrolment form is archived.')
        }),
    )
  }
  if (changed('imageId')) checks.push(assertMedia(db, patch.imageId, 'Image'))
  const code = changed('code') ? patch.code : undefined
  const slugValue = changed('slug') ? patch.slug : undefined
  if (code || slugValue) {
    const conds = [code ? eq(programmes.code, code) : undefined, slugValue ? eq(programmes.slug, slugValue) : undefined]
    checks.push(
      db
        .select({ id: programmes.id, code: programmes.code, slug: programmes.slug, name: programmes.name })
        .from(programmes)
        .where(and(or(...conds), current ? ne(programmes.id, current.id) : undefined))
        .all()
        .then((taken) => {
          const byCode = code && taken.find((t) => t.code === code)
          if (byCode) throw conflict(`The code ${code} is already used by ${byCode.name}.`)
          const bySlug = slugValue && taken.find((t) => t.slug === slugValue)
          if (bySlug) throw conflict(`The URL ${programmePath(kind, slugValue)} is taken: ${bySlug.name} uses “${slugValue}”.`)
        }),
    )
  }
  if (slugValue) checks.push(assertNoPageAt(db, programmePath(kind, slugValue)))
  await Promise.all(checks)
}

const uniqueMessage = (e: unknown, p: Pick<Programme, 'code' | 'slug'>) =>
  isUniqueFailure(e, 'leagues.code')
    ? conflict(`The code ${p.code} is already used by another programme.`)
    : isUniqueFailure(e, 'leagues.slug')
      ? conflict(`The URL “${p.slug}” is already used by another programme.`)
      : null

/** The child page slugs under a programme's page (season, term or event pages), for redirects when its URL moves. */
async function childSlugs(db: AppDb, p: Programme): Promise<string[]> {
  if (p.kind === 'league')
    return (await db.select({ s: seasons.slug }).from(seasons).where(eq(seasons.leagueId, p.id)).all()).map((r) => r.s)
  if (p.kind === 'development')
    return (await db.select({ s: developmentTerms.slug }).from(developmentTerms).where(eq(developmentTerms.programmeId, p.id)).all()).map(
      (r) => r.s,
    )
  if (p.kind === 'event')
    return (await db.select({ s: events.slug }).from(events).where(eq(events.programmeId, p.id)).all()).map((r) => r.s)
  return []
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/** Fields shown in the menu or every programme listing; changing one on a public programme purges SITE. */
const LISTING_FIELDS = [
  'name',
  'code',
  'slug',
  'categoryId',
  'menuVisible',
  'sort',
  'status',
] as const satisfies readonly (keyof Programme)[]

const isPublic = (p: Programme | null | undefined): p is Programme => !!p && p.status !== 'draft'

/**
 * What a programme change purges: its page (old and new slug), its category pages (old and new), every programme
 * listing (tags.programmes), and SITE when something the menu shows changed (name, code, URL, category, status,
 * menu visibility, order). Otherwise also the pages whose blocks use it (page_data_refs). Nothing for drafts.
 */
export async function programmePurge(db: AppDb, before: Programme | null, after: Programme | null): Promise<PurgeTargets> {
  if (!isPublic(before) && !isPublic(after)) return {}
  const ps = [before, after].filter((p): p is Programme => !!p)
  const catIds = [...new Set(ps.map((p) => p.categoryId).filter((c): c is string => !!c))]
  const cats = catIds.length ? await db.select({ slug: categories.slug }).from(categories).where(inArray(categories.id, catIds)).all() : []
  const list = [...ps.flatMap(programmeTags), ...cats.map((c) => tags.category(c.slug)), tags.programmes]
  const listing = !before || !after || LISTING_FIELDS.some((k) => before[k] !== after[k])
  if (listing) list.push(tags.site)
  else list.push(...(await blockPageTags(db, [after!.id])))
  return purgeOf(list)
}

// ── Writes ────────────────────────────────────────────────────────────────────

const auditShape = (p: Partial<Programme>) => {
  const { description, ...rest } = p
  return description === undefined ? rest : { ...rest, description: '(rich text)' }
}

/** Only the fields that differ, for audit before/after. */
function diff(before: Programme, after: Programme) {
  const keys = EDITABLE_FIELDS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
  const pick = (p: Programme) => auditShape(Object.fromEntries(keys.map((k) => [k, p[k]])) as Partial<Programme>)
  return { keys, before: pick(before), after: pick(after) }
}

const loadRow = async (db: AppDb, id: string) => {
  const p = await db.select().from(programmes).where(eq(programmes.id, id)).get()
  if (!p) throw notFound('programme')
  return p
}

export type CreateProgrammeInput = ProgrammeInput & { kind?: unknown; status?: unknown }

/** A new programme of one kind, as a draft (or active, when asked and it has a category). Audited. */
export async function createProgramme(
  db: AppDb,
  actor: Editor,
  input: CreateProgrammeInput,
  now = new Date(),
): Promise<Changed<ProgrammeView>> {
  if (typeof input.kind !== 'string' || !(programmeKinds as readonly string[]).includes(input.kind))
    throw invalid('Unknown programme kind.')
  const kind = input.kind as ProgrammeKind
  const status: ProgrammeStatus =
    input.status === undefined ? 'draft' : input.status === 'active' ? 'active' : input.status === 'draft' ? 'draft' : 'retired'
  if (status === 'retired') throw invalid('A new programme starts as a draft or active.')
  const patch = parseProgrammeFields(input)
  if (!patch.name) throw invalid('Name is required.')
  if (!patch.code) throw invalid('Code is required (like TNL or ADP).')
  if (!patch.categoryId) throw invalid('Pick a category.')
  if (patch.weekday === undefined) throw invalid('Pick the usual day.')
  if (patch.format && kind !== 'league') delete patch.format
  const values = {
    sort: 0,
    ...patch,
    // Leagues are known by their code (/leagues/tnl); other kinds read better by name (/training/scrim-and-coached-training).
    slug: patch.slug ?? slugify(kind === 'league' ? patch.code : patch.name),
    id: crypto.randomUUID(),
    kind,
    status,
    active: status === 'active',
    updatedBy: actor.id,
  } as NewProgramme & { id: string; slug: string; code: string }
  if (!values.slug) throw invalid('URL: enter a slug, like tnl.')
  if (isReservedProgrammeSlug(values.slug)) throw invalid(`URL: “${values.slug}” is used by the site itself; pick another.`)
  checkMerged({
    kind,
    ageMin: values.ageMin ?? null,
    ageMax: values.ageMax ?? null,
    enrolmentOpensAt: values.enrolmentOpensAt ?? null,
    enrolmentClosesAt: values.enrolmentClosesAt ?? null,
    startTime: values.startTime ?? null,
    endTime: values.endTime ?? null,
  })
  await checkReferences(db, { ...patch, slug: values.slug }, kind, null)
  const at = now.toISOString()
  try {
    await runBatch(db, [
      db.insert(programmes).values({ ...values, createdAt: at, updatedAt: at }),
      audit(db, actor, 'programme.create', { type: 'programme', id: values.id }, null, auditShape({ ...values } as Partial<Programme>), at),
    ])
  } catch (e) {
    throw uniqueMessage(e, values) ?? e
  }
  const saved = await loadRow(db, values.id)
  return { result: await getProgramme(db, values.id, now), purge: await programmePurge(db, null, saved) }
}

/** Saves edits to a programme. Fields left out keep their value. Needs the baseUpdatedAt the editor loaded. */
export async function updateProgramme(
  db: AppDb,
  actor: Editor,
  id: string,
  input: ProgrammeInput & { baseUpdatedAt?: unknown },
  now = new Date(),
): Promise<Changed<ProgrammeView>> {
  const current = await loadRow(db, id)
  if (typeof input.baseUpdatedAt !== 'string') throw invalid('baseUpdatedAt is required: send the updatedAt you loaded.')
  if (input.baseUpdatedAt !== current.updatedAt) throw staleProgramme()
  const patch = parseProgrammeFields(input)
  if (patch.format && current.kind !== 'league') delete patch.format
  const next = { ...current, ...patch } as Programme
  checkMerged(next)
  await checkReferences(db, patch, current.kind, current)
  const d = diff(current, next)
  if (d.keys.length === 0) return { result: await getProgramme(db, id, now), purge: {} }
  const at = now.toISOString()
  const moved = next.slug !== current.slug && isPublic(current)
  const children = moved ? await childSlugs(db, current) : []
  const enrolmentOnly = d.keys.every((k) => (ENROLMENT_FIELDS as readonly string[]).includes(k))
  try {
    await runBatch(db, [
      db
        .update(programmes)
        .set({ ...patch, updatedAt: at, updatedBy: actor.id })
        .where(and(eq(programmes.id, id), eq(programmes.updatedAt, current.updatedAt))),
      audit(db, actor, enrolmentOnly ? 'programme.enrolment' : 'programme.update', { type: 'programme', id }, d.before, d.after, at),
      ...(moved
        ? moveTreeStatements(
            db,
            { from: programmePath(current.kind, current.slug), to: programmePath(current.kind, next.slug) },
            children,
            actor,
            at,
          )
        : []),
    ])
  } catch (e) {
    throw uniqueMessage(e, next) ?? e
  }
  const saved = await loadRow(db, id)
  // The conditional update matched nothing: someone saved between our read and write.
  if (saved.updatedAt !== at) throw staleProgramme()
  return { result: await getProgramme(db, id, now), purge: await programmePurge(db, current, saved) }
}

/**
 * Draft -> active (needs a category), active -> retired, retired -> active (reactivate: menu position, enrolment
 * settings and everything else come back as they were), active -> draft (only with no history). Audited.
 */
export async function setProgrammeStatus(
  db: AppDb,
  actor: Editor,
  id: string,
  input: { status?: unknown; baseUpdatedAt?: unknown },
  now = new Date(),
): Promise<Changed<ProgrammeView>> {
  const status = input.status
  if (status !== 'draft' && status !== 'active' && status !== 'retired') throw invalid('Status must be draft, active or retired.')
  const current = await loadRow(db, id)
  if (typeof input.baseUpdatedAt === 'string' && input.baseUpdatedAt !== current.updatedAt) throw staleProgramme()
  if (current.status === status) return { result: await getProgramme(db, id, now), purge: {} }
  if (status === 'active' && !current.categoryId) throw invalid('Pick a category for this programme before making it active.')
  if (status === 'retired' && current.status === 'draft')
    throw invalid('A draft can be deleted or made active; there is nothing to retire.')
  if (status === 'draft') {
    if (current.status === 'retired') throw invalid('Reactivate a retired programme instead; it has a public history.')
    const [first, ...rest] = historyQueries(db, id)
    const history = historyOf(await runBatch(db, [first!, ...rest]))
    if (hasHistory(history))
      throw conflict(
        'This programme already has seasons, sessions, terms, events or enrolments, so it can only be retired, not made a draft.',
      )
  }
  const at = now.toISOString()
  await runBatch(db, [
    db
      .update(programmes)
      .set({ status, active: status === 'active', retiredAt: status === 'retired' ? at : null, updatedAt: at, updatedBy: actor.id })
      .where(eq(programmes.id, id)),
    audit(
      db,
      actor,
      'programme.status',
      { type: 'programme', id },
      { status: current.status, code: current.code, name: current.name },
      { status, code: current.code, name: current.name },
      at,
    ),
  ])
  const saved = await loadRow(db, id)
  return { result: await getProgramme(db, id, now), purge: await programmePurge(db, current, saved) }
}

/** Deletes a programme that has no history (see ProgrammeHistory). Audited. */
export async function deleteProgramme(db: AppDb, actor: Editor, id: string, now = new Date()): Promise<Changed<{ id: string }>> {
  const current = await loadRow(db, id)
  const [first, ...rest] = historyQueries(db, id)
  const history = historyOf(await runBatch(db, [first!, ...rest]))
  if (hasHistory(history))
    throw conflict(
      `This ${KIND_LABEL[current.kind]} has seasons, sessions, terms, events or enrolments, so it can't be deleted. Retire it instead.`,
    )
  if (history.menuItems.length)
    throw conflict(
      `The menu links to this programme (${history.menuItems.map((m) => `“${m.label}”`).join(', ')}). Remove it from the menu first.`,
    )
  if (history.pages.length)
    throw conflict(`These pages show its ladder or fixtures: ${history.pages.map((p) => p.path).join(', ')}. Remove those blocks first.`)
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(programmes).where(eq(programmes.id, id)),
    audit(db, actor, 'programme.delete', { type: 'programme', id }, auditShape(current), null, at),
  ])
  return { result: { id }, purge: await programmePurge(db, current, null) }
}
