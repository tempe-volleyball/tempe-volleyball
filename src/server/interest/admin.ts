import { and, desc, eq, exists, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { defaultInterestFields } from '../../lib/enrolment/defaults'
import { activeFields, type FormField } from '../../lib/enrolment/forms'
import { answerText, isDisplayOnly, isEmail, isMapped, isPhone, normaliseEmail, validateEnrolment } from '../../lib/enrolment/validate'
import { toCsv } from '../../lib/enrolment/csv'
import { leagueWindow } from '../../lib/players/groups'
import { sydneyDate, sydneyToUtc } from '../../lib/time'
import { runBatch, type AppDb } from '../db'
import {
  auditLog,
  defaultSignupMode,
  enrolmentForms,
  genders,
  interestKinds,
  interestMembers,
  interestProgrammes,
  interests,
  interestStatuses,
  openInterestStatuses,
  players,
  poolOfKind,
  programmes,
  seasons,
  teams,
  user,
  type Gender,
  type InterestKind,
  type InterestSource,
  type InterestStatus,
  type MemberDetails,
  type PlayerPool,
  type ProgrammeKind,
  type RosterRole,
  type SignupMode,
} from '../db/schema'
import {
  audit,
  auditEntry,
  conflict,
  invalid,
  isUniqueFailure,
  likeEscaped,
  likePattern,
  notFound,
  optionalText,
  type Editor,
} from '../content/common'
import { getSettings } from '../content/settings'
import { PAYMENT_METHODS, type PaymentMethod } from '../enrolment/admin'
import { createInterest, emptyDetails } from '../players/core'

// Admin → Interest (docs/interest.md, docs/admin.md §3.16, docs/api/interest-admin.md): the inbox of expressions of
// interest (EOIs), each EOI's page, statuses per programme, deposits marked paid by hand, notes, archive, delete for
// good, EOIs added by hand (phone calls), "Use these details" onto a player record, CSV export, the nav badge and
// the dashboard counts, and the cron's retention prune. Admins and owners only (personal data), with the role
// re-read from D1 on every route; nothing here is cached.
//
// D1: every list is bounded (a page of 50, bulk actions at most MAX_BULK ids, the export EXPORT_LIMIT EOIs), the
// inbox is two batches (the page and counts, then the page's members and programmes), and an EOI's page one batch.

export const PAGE_SIZE = 50
/** Request bodies of the interest routes: small (an EOI typed in by hand is a few people). */
export const INTEREST_BODY_LIMIT = 64 * 1024
/** Bulk actions take at most this many EOIs (one statement each, under D1's 100 bound parameters). */
export const MAX_BULK = 90
/** The most EOIs one CSV export writes. */
export const EXPORT_LIMIT = 5000
/** The most people on an EOI typed in by hand (the public form's limit is Settings → Interest). */
export const ADMIN_MAX_MEMBERS = 30

const HOUR = 3_600_000

// ── Filters ───────────────────────────────────────────────────────────────────

/** Per programme: `open` = new or contacted (the default), a single status, or any. */
export const statusFilters = ['open', ...interestStatuses, 'any'] as const
export type StatusFilter = (typeof statusFilters)[number]
/** Not archived (the default), archived only, or both. */
export const archivedFilters = ['active', 'archived', 'all'] as const
export type ArchivedFilter = (typeof archivedFilters)[number]

export type InterestFilter = {
  programmeId: string | null
  status: StatusFilter
  kind: InterestKind | null
  /** `season`: sent since the programme's last season started (each programme's own, when none is chosen). */
  since: 'season' | 'all'
  archived: ArchivedFilter
  q: string | null
}

const pick = <T extends string>(list: readonly T[], v: string | null | undefined, fallback: T): T =>
  (list as readonly string[]).includes(v ?? '') ? (v as T) : fallback

/** The filter from a query string (unknown values fall back to the defaults). */
export function parseInterestFilter(p: URLSearchParams): InterestFilter {
  const programmeId = p.get('programme')?.trim() || null
  return {
    programmeId: programmeId && /^[\w-]{1,64}$/.test(programmeId) ? programmeId : null,
    status: pick(statusFilters, p.get('status'), 'open'),
    kind: (interestKinds as readonly string[]).includes(p.get('kind') ?? '') ? (p.get('kind') as InterestKind) : null,
    since: p.get('since') === 'season' ? 'season' : 'all',
    archived: pick(archivedFilters, p.get('archived'), 'active'),
    q: p.get('q')?.trim().slice(0, 100) || null,
  }
}

/** A programme that can be filtered by, with its window and counts (not archived) per status. */
export type InterestProgrammeOption = {
  id: string
  code: string
  name: string
  kind: ProgrammeKind
  status: string
  /** The effective mode (null in the row = the kind's default). */
  signupMode: SignupMode
  interestOpen: boolean
  depositPlayerCents: number | null
  depositTeamCents: number | null
  /** YYYY-MM-DD (Sydney): when its last season started, the start of "new interest". Null = no season yet. */
  since: string | null
  lastSeason: { id: string; name: string } | null
  counts: Record<InterestStatus, number>
  /** Open EOIs sent since the window started (the "New interest" group's EOIs). */
  openSince: number
}

const emptyCounts = () => Object.fromEntries(interestStatuses.map((s) => [s, 0])) as Record<InterestStatus, number>

/** The UTC instant a Sydney date starts. */
const startOfSydneyDay = (date: string) => sydneyToUtc(`${date}T00:00`) ?? `${date}T00:00:00.000Z`

/**
 * Every programme with EOIs or taking them, with each one's "since the last season started" window and counts per
 * status (EOIs not archived). One batch of three reads. The window is leagueWindow() over the programme's seasons,
 * as the Players screen's groups use.
 */
export async function interestProgrammeOptions(db: AppDb, now = new Date()): Promise<InterestProgrammeOption[]> {
  const today = sydneyDate(now)
  const [progs, seasonRows, countRows] = (await runBatch(db, [
    db
      .select({
        id: programmes.id,
        code: programmes.code,
        name: programmes.name,
        kind: programmes.kind,
        status: programmes.status,
        sort: programmes.sort,
        signupMode: programmes.signupMode,
        interestOpen: programmes.interestOpen,
        depositPlayerCents: programmes.depositPlayerCents,
        depositTeamCents: programmes.depositTeamCents,
      })
      .from(programmes)
      .orderBy(programmes.kind, programmes.sort, programmes.name),
    db
      .select({ id: seasons.id, name: seasons.name, startDate: seasons.startDate, leagueId: seasons.leagueId })
      .from(seasons)
      .innerJoin(programmes, eq(programmes.id, seasons.leagueId)),
    db
      .select({
        programmeId: interestProgrammes.programmeId,
        status: interestProgrammes.status,
        createdAt: interestProgrammes.createdAt,
      })
      .from(interestProgrammes)
      .innerJoin(interests, eq(interests.id, interestProgrammes.interestId))
      .where(isNull(interests.archivedAt)),
  ])) as unknown as [
    {
      id: string
      code: string
      name: string
      kind: ProgrammeKind
      status: string
      sort: number
      signupMode: SignupMode | null
      interestOpen: boolean
      depositPlayerCents: number | null
      depositTeamCents: number | null
    }[],
    { id: string; name: string; startDate: string; leagueId: string }[],
    { programmeId: string; status: InterestStatus; createdAt: string }[],
  ]
  const seasonsBy = new Map<string, typeof seasonRows>()
  for (const s of seasonRows) seasonsBy.set(s.leagueId, [...(seasonsBy.get(s.leagueId) ?? []), s])
  const out: InterestProgrammeOption[] = []
  for (const p of progs) {
    const mode = p.signupMode ?? defaultSignupMode(p.kind)
    const mine = countRows.filter((c) => c.programmeId === p.id)
    if (mode !== 'interest' && mine.length === 0) continue
    const ss = seasonsBy.get(p.id) ?? []
    const w = leagueWindow(ss, { today })
    const sinceIso = w.interestSince ? startOfSydneyDay(w.interestSince) : null
    const counts = emptyCounts()
    let openSince = 0
    for (const c of mine) {
      counts[c.status]++
      if ((openInterestStatuses as readonly string[]).includes(c.status) && (!sinceIso || c.createdAt >= sinceIso)) openSince++
    }
    const last = w.lastSeasonId ? ss.find((s) => s.id === w.lastSeasonId) : undefined
    out.push({
      id: p.id,
      code: p.code,
      name: p.name,
      kind: p.kind,
      status: p.status,
      signupMode: mode,
      interestOpen: p.interestOpen,
      depositPlayerCents: p.depositPlayerCents,
      depositTeamCents: p.depositTeamCents,
      since: w.interestSince,
      lastSeason: last ? { id: last.id, name: last.name } : null,
      counts,
      openSince,
    })
  }
  return out
}

const statusSql = (status: StatusFilter): SQL | undefined =>
  status === 'any'
    ? undefined
    : status === 'open'
      ? inArray(interestProgrammes.status, [...openInterestStatuses])
      : eq(interestProgrammes.status, status)

/** The WHERE for a filter; `options` gives each programme's window for `since: 'season'`. */
function filterWhere(db: AppDb, f: InterestFilter, options: readonly InterestProgrammeOption[]): SQL | undefined {
  // Each programme's own "since": with one chosen, its window; with none, any of its programmes inside its window.
  let sinceCond: SQL | undefined
  if (f.since === 'season') {
    const windows = options
      .filter((o) => !f.programmeId || o.id === f.programmeId)
      .map((o) =>
        o.since
          ? and(eq(interestProgrammes.programmeId, o.id), sql`${interestProgrammes.createdAt} >= ${startOfSydneyDay(o.since)}`)
          : eq(interestProgrammes.programmeId, o.id),
      )
    sinceCond = windows.length ? or(...windows) : sql`0`
  }
  const programmeCond = and(
    eq(interestProgrammes.interestId, interests.id),
    f.programmeId ? eq(interestProgrammes.programmeId, f.programmeId) : undefined,
    statusSql(f.status),
    sinceCond,
  )
  const needsProgramme = !!f.programmeId || f.status !== 'any' || f.since === 'season'
  return and(
    f.archived === 'active' ? isNull(interests.archivedAt) : f.archived === 'archived' ? isNotNull(interests.archivedAt) : undefined,
    f.kind ? eq(interests.kind, f.kind) : undefined,
    needsProgramme
      ? exists(
          db
            .select({ x: sql`1` })
            .from(interestProgrammes)
            .where(programmeCond),
        )
      : undefined,
    searchWhere(db, f.q),
  )
}

/** Every word must match a person's name or email on the EOI, the team name or the reference. */
function searchWhere(db: AppDb, q: string | null): SQL | undefined {
  const words = (q ?? '').split(/\s+/).filter(Boolean).slice(0, 5)
  if (words.length === 0) return undefined
  const hay = sql`(coalesce(json_extract(${interestMembers.details}, '$.firstName'), '') || ' ' || coalesce(json_extract(${interestMembers.details}, '$.lastName'), '') || ' ' || coalesce(json_extract(${interestMembers.details}, '$.email'), '') || ' ' || coalesce(json_extract(${interestMembers.details}, '$.phone'), ''))`
  return and(
    ...words.map((w) => {
      const p = likePattern(w)
      return or(
        likeEscaped(interests.teamName, p),
        likeEscaped(interests.reference, p),
        exists(
          db
            .select({ x: sql`1` })
            .from(interestMembers)
            .where(and(eq(interestMembers.interestId, interests.id), likeEscaped(hay, p))),
        ),
      )
    }),
  )
}

/** "createdAt|id" cursor, newest first. */
const cursorWhere = (before: string | null | undefined): SQL | undefined => {
  if (!before) return undefined
  const i = before.lastIndexOf('|')
  const createdAt = before.slice(0, i)
  const id = before.slice(i + 1)
  if (i < 0 || !createdAt || !id) return undefined
  return or(lt(interests.createdAt, createdAt), and(eq(interests.createdAt, createdAt), lt(interests.id, id)))
}

// ── The inbox ─────────────────────────────────────────────────────────────────

export type InterestProgrammeRow = {
  programmeId: string
  code: string
  name: string
  kind: ProgrammeKind
  status: InterestStatus
  seasonId: string | null
  seasonName: string | null
  teamId: string | null
  teamName: string | null
  updatedAt: string
}

export type InterestListItem = {
  id: string
  kind: InterestKind
  reference: string
  teamName: string | null
  source: InterestSource
  depositCents: number | null
  paidAt: string | null
  archivedAt: string | null
  createdAt: string
  hasNote: boolean
  /** The contact (the player, or the team's captain). */
  contact: { firstName: string; lastName: string; email: string | null; phone: string | null; playerId: string | null } | null
  members: number
  programmes: InterestProgrammeRow[]
  /** From the answers, when the form asked: playing level and position. */
  level: string | null
  position: string | null
}

export type InterestList = {
  rows: InterestListItem[]
  /** How many EOIs match the filter. */
  total: number
  next: string | null
  programmes: InterestProgrammeOption[]
  filter: InterestFilter
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)

/** A page of the inbox (newest first), how many match, and the programmes with their counts: two batches. */
export async function listInterests(
  db: AppDb,
  filter: InterestFilter,
  opts: { before?: string | null; limit?: number } = {},
  now = new Date(),
): Promise<InterestList> {
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 200)
  const options = await interestProgrammeOptions(db, now)
  const where = filterWhere(db, filter, options)
  const [rows, total] = (await runBatch(db, [
    db
      .select({
        id: interests.id,
        kind: interests.kind,
        reference: interests.reference,
        teamName: interests.teamName,
        source: interests.source,
        depositCents: interests.depositCents,
        paidAt: interests.paidAt,
        archivedAt: interests.archivedAt,
        createdAt: interests.createdAt,
        note: interests.note,
        answers: interests.answers,
      })
      .from(interests)
      .where(and(where, cursorWhere(opts.before)))
      .orderBy(desc(interests.createdAt), desc(interests.id))
      .limit(limit + 1),
    db
      .select({ n: sql<number>`count(*)` })
      .from(interests)
      .where(where),
  ])) as unknown as [
    {
      id: string
      kind: InterestKind
      reference: string
      teamName: string | null
      source: InterestSource
      depositCents: number | null
      paidAt: string | null
      archivedAt: string | null
      createdAt: string
      note: string | null
      answers: Record<string, unknown>
    }[],
    { n: number }[],
  ]
  const page = rows.slice(0, limit)
  const ids = page.map((r) => r.id)
  const { members, progs } = await pageExtras(db, ids)
  const last = page.at(-1)
  return {
    rows: page.map((r) => {
      const mine = members.filter((m) => m.interestId === r.id)
      const contact = mine.find((m) => m.sort === 0) ?? mine[0]
      const answers = (r.answers ?? {}) as Record<string, unknown>
      return {
        id: r.id,
        kind: r.kind,
        reference: r.reference,
        teamName: r.teamName,
        source: r.source,
        depositCents: r.depositCents,
        paidAt: r.paidAt,
        archivedAt: r.archivedAt,
        createdAt: r.createdAt,
        hasNote: !!r.note,
        contact: contact
          ? {
              firstName: contact.details.firstName,
              lastName: contact.details.lastName,
              email: contact.details.email,
              phone: contact.details.phone,
              playerId: contact.playerId,
            }
          : null,
        members: mine.length,
        programmes: progs.filter((p) => p.interestId === r.id).map(({ interestId: _interestId, ...p }) => p),
        level: str(answers.playing_level) ?? str(answers.skill_level),
        position: str(answers.position),
      }
    }),
    total: Number(total[0]?.n ?? 0),
    next: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null,
    programmes: options,
    filter,
  }
}

const programmeRowColumns = {
  interestId: interestProgrammes.interestId,
  programmeId: interestProgrammes.programmeId,
  code: programmes.code,
  name: sql<string>`${programmes.name}`.as('programme_name'),
  kind: programmes.kind,
  status: interestProgrammes.status,
  seasonId: interestProgrammes.seasonId,
  seasonName: sql<string | null>`${seasons.name}`.as('season_name'),
  teamId: interestProgrammes.teamId,
  teamName: sql<string | null>`${teams.name}`.as('placed_team_name'),
  updatedAt: interestProgrammes.updatedAt,
}

const programmeRowsQuery = (db: AppDb, where: SQL | undefined) =>
  db
    .select(programmeRowColumns)
    .from(interestProgrammes)
    .innerJoin(programmes, eq(programmes.id, interestProgrammes.programmeId))
    .leftJoin(seasons, eq(seasons.id, interestProgrammes.seasonId))
    .leftJoin(teams, eq(teams.id, interestProgrammes.teamId))
    .where(where)
    .orderBy(programmes.kind, programmes.sort, programmes.name)

/** The members and programmes of a page of EOIs (one batch; ≤ 50 ids per statement). */
async function pageExtras(db: AppDb, ids: string[]) {
  if (ids.length === 0) return { members: [], progs: [] }
  const [members, progs] = (await runBatch(db, [
    db
      .select({
        interestId: interestMembers.interestId,
        playerId: interestMembers.playerId,
        sort: interestMembers.sort,
        details: interestMembers.details,
      })
      .from(interestMembers)
      .where(inArray(interestMembers.interestId, ids))
      .orderBy(interestMembers.interestId, interestMembers.sort),
    programmeRowsQuery(db, inArray(interestProgrammes.interestId, ids)),
  ])) as unknown as [
    { interestId: string; playerId: string | null; sort: number; details: MemberDetails }[],
    (InterestProgrammeRow & { interestId: string })[],
  ]
  return { members, progs }
}

/** EOIs with a programme still `new` (not archived): the nav badge. One indexed count. */
export async function newInterestCount(db: AppDb): Promise<number> {
  const row = await db
    .select({ n: sql<number>`count(distinct ${interestProgrammes.interestId})` })
    .from(interestProgrammes)
    .innerJoin(interests, eq(interests.id, interestProgrammes.interestId))
    .where(and(eq(interestProgrammes.status, 'new'), isNull(interests.archivedAt)))
    .get()
  return Number(row?.n ?? 0)
}

export type InterestSummary = {
  /** EOIs with a programme still new. */
  newCount: number
  /** Per programme with open EOIs: new, open (new + contacted) and open since its last season started. */
  programmes: { id: string; code: string; name: string; new: number; open: number; openSince: number; since: string | null }[]
}

/** For the admin home page. */
export async function interestSummary(db: AppDb, now = new Date()): Promise<InterestSummary> {
  const [newCount, options] = await Promise.all([newInterestCount(db), interestProgrammeOptions(db, now)])
  return {
    newCount,
    programmes: options
      .map((o) => ({
        id: o.id,
        code: o.code,
        name: o.name,
        new: o.counts.new,
        open: o.counts.new + o.counts.contacted,
        openSince: o.openSince,
        since: o.since,
      }))
      .filter((o) => o.open > 0),
  }
}

// ── One EOI ───────────────────────────────────────────────────────────────────

/** The player columns a member's sent details can be compared with and applied to. */
export const DETAIL_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'gender',
  'birthYear',
  'suburb',
  'vnswNumber',
  'guardianName',
  'guardianEmail',
  'guardianPhone',
  'emergencyContact',
] as const satisfies readonly (keyof MemberDetails)[]
export type DetailField = (typeof DETAIL_FIELDS)[number]

export const DETAIL_LABELS: Record<DetailField, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  gender: 'Gender',
  birthYear: 'Year of birth',
  suburb: 'Suburb',
  vnswNumber: 'VNSW number',
  guardianName: 'Guardian name',
  guardianEmail: 'Guardian email',
  guardianPhone: 'Guardian phone',
  emergencyContact: 'Emergency contact',
}

type PlayerDetails = Pick<typeof players.$inferSelect, DetailField | 'id' | 'pool' | 'retiredAt'>

const norm = (f: DetailField, v: unknown) => {
  if (v === null || v === undefined || v === '') return ''
  const s = String(v).trim()
  return f === 'email' || f === 'guardianEmail' || f === 'firstName' || f === 'lastName'
    ? s.toLowerCase()
    : f === 'phone' || f === 'guardianPhone'
      ? s.replace(/[\s().-]/g, '')
      : s
}

/** The fields where what was sent (and isn't blank) differs from the player row. */
export function detailsDiff(sent: MemberDetails, player: PlayerDetails | null): { field: DetailField; sent: unknown; current: unknown }[] {
  if (!player) return []
  return DETAIL_FIELDS.filter((f) => norm(f, sent[f]) !== '' && norm(f, sent[f]) !== norm(f, player[f])).map((f) => ({
    field: f,
    sent: sent[f],
    current: player[f] ?? null,
  }))
}

export type InterestMemberView = {
  id: string
  role: RosterRole
  sort: number
  details: MemberDetails
  player: (PlayerDetails & { createdAt: string; source: string | null }) | null
  /** Sent details that differ from the player record (for "Use these details"). */
  diff: { field: DetailField; sent: unknown; current: unknown }[]
  /** The player row was created by this EOI. */
  createdHere: boolean
}

export type InterestDetail = {
  interest: {
    id: string
    kind: InterestKind
    reference: string
    teamName: string | null
    answers: Record<string, unknown>
    formId: string | null
    formVersion: number | null
    depositCents: number | null
    paidAt: string | null
    paidByName: string | null
    paymentNote: string | null
    note: string | null
    source: InterestSource
    archivedAt: string | null
    createdAt: string
    updatedAt: string
    updatedByName: string | null
  }
  members: InterestMemberView[]
  programmes: InterestProgrammeRow[]
  /** The answers with their questions' labels, in form order (questions the form no longer has last). */
  answers: { key: string; label: string; text: string }[]
  formName: string
  /** The latest audit entries for this EOI. */
  history: { at: string; action: string; actorEmail: string | null; after: unknown }[]
  /** The pool its people are in. */
  pool: PlayerPool
}

const paidBy = alias(user, 'paid_by')
const updatedByUser = alias(user, 'updated_by_user')
const auditActor = alias(user, 'audit_actor')

/** One EOI with its people, programmes, answers and history: one batch of five reads (plus its form). */
export async function getInterest(db: AppDb, id: string): Promise<InterestDetail> {
  const [rows, members, progs, history] = (await runBatch(db, [
    db
      .select({
        id: interests.id,
        kind: interests.kind,
        reference: interests.reference,
        teamName: interests.teamName,
        answers: interests.answers,
        formId: interests.formId,
        formVersion: interests.formVersion,
        depositCents: interests.depositCents,
        paidAt: interests.paidAt,
        paidByName: sql<string | null>`${paidBy.name}`.as('paid_by_name'),
        paymentNote: interests.paymentNote,
        note: interests.note,
        source: interests.source,
        archivedAt: interests.archivedAt,
        createdAt: interests.createdAt,
        updatedAt: interests.updatedAt,
        updatedByName: sql<string | null>`${updatedByUser.name}`.as('updated_by_name'),
        formName: sql<string | null>`${enrolmentForms.name}`.as('form_name'),
        formFields: sql<string | null>`${enrolmentForms.fields}`.as('form_fields'),
      })
      .from(interests)
      .leftJoin(paidBy, eq(paidBy.id, interests.paidMarkedBy))
      .leftJoin(updatedByUser, eq(updatedByUser.id, interests.updatedBy))
      .leftJoin(enrolmentForms, eq(enrolmentForms.id, interests.formId))
      .where(eq(interests.id, id)),
    db
      .select({
        id: interestMembers.id,
        role: interestMembers.role,
        sort: interestMembers.sort,
        details: interestMembers.details,
        pId: sql<string | null>`${players.id}`.as('p_id'),
        pPool: players.pool,
        pFirstName: sql<string | null>`${players.firstName}`.as('p_first_name'),
        pLastName: sql<string | null>`${players.lastName}`.as('p_last_name'),
        pEmail: sql<string | null>`${players.email}`.as('p_email'),
        pPhone: sql<string | null>`${players.phone}`.as('p_phone'),
        pGender: players.gender,
        pBirthYear: players.birthYear,
        pSuburb: players.suburb,
        pVnswNumber: players.vnswNumber,
        pGuardianName: players.guardianName,
        pGuardianEmail: players.guardianEmail,
        pGuardianPhone: players.guardianPhone,
        pEmergencyContact: players.emergencyContact,
        pRetiredAt: players.retiredAt,
        pCreatedAt: sql<string | null>`${players.createdAt}`.as('p_created_at'),
        pSource: players.source,
      })
      .from(interestMembers)
      .leftJoin(players, eq(players.id, interestMembers.playerId))
      .where(eq(interestMembers.interestId, id))
      .orderBy(interestMembers.sort),
    programmeRowsQuery(db, eq(interestProgrammes.interestId, id)),
    db
      .select({
        at: auditLog.at,
        action: auditLog.action,
        actorEmail: sql<string | null>`${auditActor.email}`.as('actor_email'),
        after: auditLog.after,
      })
      .from(auditLog)
      .leftJoin(auditActor, eq(auditActor.id, auditLog.actorUserId))
      .where(and(eq(auditLog.targetType, 'interest'), eq(auditLog.targetId, id)))
      .orderBy(desc(auditLog.at))
      .limit(20),
  ])) as unknown as [
    (InterestDetail['interest'] & { formName: string | null; formFields: string | FormField[] | null })[],
    Record<string, unknown>[],
    (InterestProgrammeRow & { interestId: string })[],
    InterestDetail['history'],
  ]
  const row = rows[0]
  if (!row) throw notFound('expression of interest')
  const { formName, formFields, ...interest } = row
  const fields: FormField[] = formFields
    ? typeof formFields === 'string'
      ? (JSON.parse(formFields) as FormField[])
      : formFields
    : defaultInterestFields()
  const memberViews: InterestMemberView[] = members.map((m) => {
    const details = (typeof m.details === 'string' ? JSON.parse(m.details) : m.details) as MemberDetails
    const player = m.pId
      ? {
          id: m.pId as string,
          pool: m.pPool as PlayerPool,
          firstName: m.pFirstName as string,
          lastName: m.pLastName as string,
          email: m.pEmail as string,
          phone: m.pPhone as string | null,
          gender: m.pGender as Gender | null,
          birthYear: m.pBirthYear as number | null,
          suburb: m.pSuburb as string | null,
          vnswNumber: m.pVnswNumber as string | null,
          guardianName: m.pGuardianName as string | null,
          guardianEmail: m.pGuardianEmail as string | null,
          guardianPhone: m.pGuardianPhone as string | null,
          emergencyContact: m.pEmergencyContact as string | null,
          retiredAt: m.pRetiredAt as string | null,
          createdAt: m.pCreatedAt as string,
          source: m.pSource as string | null,
        }
      : null
    return {
      id: m.id as string,
      role: m.role as RosterRole,
      sort: m.sort as number,
      details,
      player,
      diff: detailsDiff(details, player),
      createdHere: !!player && player.createdAt === interest.createdAt,
    }
  })
  return {
    interest,
    members: memberViews,
    programmes: progs.map(({ interestId: _interestId, ...p }) => p),
    answers: answerList(fields, interest.answers ?? {}),
    formName: formName ?? (interest.formId ? 'A deleted form' : 'Built-in default'),
    history: history.map((h) => ({ ...h, after: typeof h.after === 'string' ? safeJson(h.after) : h.after })),
    pool:
      memberViews.find((m) => m.player)?.player?.pool ??
      (progs.some((p) => poolOfKind(p.kind) === 'competition') ? 'competition' : 'training'),
  }
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s) as unknown
  } catch {
    return s
  }
}

/** Answers with labels, in the form's order; answers to questions the form no longer has keep their key. */
export function answerList(fields: readonly FormField[], answers: Record<string, unknown>) {
  const out: { key: string; label: string; text: string }[] = []
  const seen = new Set<string>()
  for (const f of fields) {
    if (isDisplayOnly(f.type) || !(f.key in answers)) continue
    seen.add(f.key)
    const text = answerText(f, answers[f.key])
    if (text) out.push({ key: f.key, label: f.label, text })
  }
  for (const [k, v] of Object.entries(answers)) {
    if (seen.has(k)) continue
    const text = answerText(undefined, v)
    if (text) out.push({ key: k, label: k, text })
  }
  return out
}

// ── Changes ───────────────────────────────────────────────────────────────────

export const interestActions = [
  'note',
  'mark_paid',
  'mark_unpaid',
  'status',
  'archive',
  'unarchive',
  'team_name',
  'add_programme',
  'remove_programme',
  'apply_details',
] as const
export type InterestAction = (typeof interestActions)[number]

export type InterestActionInput = {
  action?: unknown
  note?: unknown
  method?: unknown
  programmeId?: unknown
  status?: unknown
  seasonId?: unknown
  teamId?: unknown
  teamName?: unknown
  memberId?: unknown
  fields?: unknown
}

const parseStatus = (v: unknown): InterestStatus => {
  if (!(interestStatuses as readonly unknown[]).includes(v)) throw invalid('Status is new, contacted, placed, declined or withdrawn.')
  return v as InterestStatus
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,64}$/.test(v)

async function loadInterestRow(db: AppDb, id: string) {
  const row = await db.select().from(interests).where(eq(interests.id, id)).get()
  if (!row) throw notFound('expression of interest')
  return row
}

/**
 * Where an EOI was placed: a season of that programme and, optionally, a team. Checked against the database; null
 * ids clear them.
 */
async function placement(db: AppDb, programmeId: string, seasonId: unknown, teamId: unknown) {
  const sid = seasonId === undefined || seasonId === null || seasonId === '' ? null : seasonId
  const tid = teamId === undefined || teamId === null || teamId === '' ? null : teamId
  if (sid !== null && !isId(sid)) throw invalid('Pick the season from the list.')
  if (tid !== null && !isId(tid)) throw invalid('Pick the team from the list.')
  const [s, t] = await Promise.all([
    sid ? db.select({ id: seasons.id, leagueId: seasons.leagueId }).from(seasons).where(eq(seasons.id, sid)).get() : null,
    tid ? db.select({ id: teams.id }).from(teams).where(eq(teams.id, tid)).get() : null,
  ])
  if (sid && (!s || s.leagueId !== programmeId)) throw invalid('That season isn’t one of this programme’s.')
  if (tid && !t) throw invalid('That team no longer exists.')
  return { seasonId: sid as string | null, teamId: tid as string | null }
}

/** One change to an EOI (see interestActions). Audited as interest.update with what changed (no personal values). */
export async function interestAction(db: AppDb, actor: Editor, id: string, input: InterestActionInput, now = new Date()) {
  const at = now.toISOString()
  const action = input.action as InterestAction
  if (!(interestActions as readonly string[]).includes(action)) throw invalid('Unknown action.')
  const row = await loadInterestRow(db, id)
  const auditOf = (before: unknown, after: unknown) =>
    db.insert(auditLog).values(auditEntry(actor, 'interest.update', { type: 'interest', id }, before, after, at))
  const touch = { updatedAt: at, updatedBy: actor.id }

  switch (action) {
    case 'note': {
      if (input.note !== null && input.note !== undefined && typeof input.note !== 'string') throw invalid('The note must be text.')
      const note = ((input.note as string | null) ?? '').trim()
      if (note.length > 2000) throw invalid('The note is too long (at most 2000 characters).')
      await runBatch(db, [
        db
          .update(interests)
          .set({ note: note || null, ...touch })
          .where(eq(interests.id, id)),
        auditOf(null, { action, note: note ? 'changed' : 'cleared' }),
      ])
      break
    }
    case 'mark_paid': {
      const method = input.method as PaymentMethod
      if (typeof method !== 'string' || !(method in PAYMENT_METHODS)) throw invalid('Choose how they paid.')
      const note = optionalText(input.note, 'The note', 200)
      const paymentNote = `${PAYMENT_METHODS[method]}${note ? `: ${note}` : ''}`
      await runBatch(db, [
        db
          .update(interests)
          .set({ paidAt: at, paidMarkedBy: actor.id, paymentNote, ...touch })
          .where(eq(interests.id, id)),
        auditOf({ paidAt: row.paidAt, paymentNote: row.paymentNote }, { action, paidAt: at, paymentNote }),
      ])
      break
    }
    case 'mark_unpaid': {
      const note = optionalText(input.note, 'The note', 200)
      await runBatch(db, [
        db
          .update(interests)
          .set({ paidAt: null, paidMarkedBy: null, paymentNote: note, ...touch })
          .where(eq(interests.id, id)),
        auditOf({ paidAt: row.paidAt, paymentNote: row.paymentNote }, { action, paidAt: null, paymentNote: note }),
      ])
      break
    }
    case 'status': {
      if (!isId(input.programmeId)) throw invalid('Which programme?')
      const programmeId = input.programmeId
      const status = parseStatus(input.status)
      const current = await db
        .select()
        .from(interestProgrammes)
        .where(and(eq(interestProgrammes.interestId, id), eq(interestProgrammes.programmeId, programmeId)))
        .get()
      if (!current) throw notFound('programme on this expression of interest')
      const place = status === 'placed' ? await placement(db, programmeId, input.seasonId, input.teamId) : { seasonId: null, teamId: null }
      await runBatch(db, [
        db
          .update(interestProgrammes)
          .set({ status, ...place, ...touch })
          .where(and(eq(interestProgrammes.interestId, id), eq(interestProgrammes.programmeId, programmeId))),
        db.update(interests).set(touch).where(eq(interests.id, id)),
        auditOf(
          { programmeId, status: current.status, seasonId: current.seasonId, teamId: current.teamId },
          { action, programmeId, status, ...place },
        ),
      ])
      break
    }
    case 'archive':
    case 'unarchive': {
      const archivedAt = action === 'archive' ? at : null
      if (!!row.archivedAt === (action === 'archive')) break
      await runBatch(db, [
        db
          .update(interests)
          .set({ archivedAt, ...touch })
          .where(eq(interests.id, id)),
        auditOf({ archivedAt: row.archivedAt }, { action, archivedAt }),
      ])
      break
    }
    case 'team_name': {
      if (row.kind !== 'team') throw invalid('Only a team EOI has a team name.')
      const teamName = optionalText(input.teamName, 'The team name', 80)
      if (!teamName) throw invalid('Enter the team name.')
      await runBatch(db, [
        db
          .update(interests)
          .set({ teamName, ...touch })
          .where(eq(interests.id, id)),
        auditOf({ teamName: row.teamName }, { action, teamName }),
      ])
      break
    }
    case 'add_programme': {
      if (!isId(input.programmeId)) throw invalid('Which programme?')
      const programmeId = input.programmeId
      const p = await db.select({ id: programmes.id, kind: programmes.kind }).from(programmes).where(eq(programmes.id, programmeId)).get()
      if (!p) throw invalid('That programme no longer exists.')
      const status = input.status === undefined ? 'new' : parseStatus(input.status)
      try {
        await runBatch(db, [
          db.insert(interestProgrammes).values({ interestId: id, programmeId, status, createdAt: row.createdAt, ...touch }),
          db.update(interests).set(touch).where(eq(interests.id, id)),
          auditOf(null, { action, programmeId, status }),
        ])
      } catch (e) {
        if (isUniqueFailure(e)) throw conflict('That programme is already on it.')
        throw e
      }
      break
    }
    case 'remove_programme': {
      if (!isId(input.programmeId)) throw invalid('Which programme?')
      const programmeId = input.programmeId
      const all = await db
        .select({ programmeId: interestProgrammes.programmeId, status: interestProgrammes.status })
        .from(interestProgrammes)
        .where(eq(interestProgrammes.interestId, id))
      const it = all.find((p) => p.programmeId === programmeId)
      if (!it) throw notFound('programme on this expression of interest')
      if (all.length === 1) throw conflict('An EOI needs at least one programme. Archive or delete it instead.')
      await runBatch(db, [
        db.delete(interestProgrammes).where(and(eq(interestProgrammes.interestId, id), eq(interestProgrammes.programmeId, programmeId))),
        db.update(interests).set(touch).where(eq(interests.id, id)),
        auditOf({ programmeId, status: it.status }, { action, programmeId }),
      ])
      break
    }
    case 'apply_details':
      await applyDetails(db, actor, id, input, now)
      break
  }
  return getInterest(db, id)
}

/**
 * "Use these details": copies chosen fields of what a member was sent with onto their player record. Audited on
 * the player (player.update) with the field names and the EOI, never the values.
 */
async function applyDetails(db: AppDb, actor: Editor, interestId: string, input: InterestActionInput, now: Date) {
  if (!isId(input.memberId)) throw invalid('Which person?')
  const member = await db
    .select()
    .from(interestMembers)
    .where(and(eq(interestMembers.id, input.memberId), eq(interestMembers.interestId, interestId)))
    .get()
  if (!member) throw notFound('person on this expression of interest')
  if (!member.playerId) throw conflict('This person’s player record was deleted. Add them as a player first.')
  const fields = Array.isArray(input.fields) ? [...new Set(input.fields)] : []
  if (fields.length === 0 || !fields.every((f) => (DETAIL_FIELDS as readonly unknown[]).includes(f)))
    throw invalid('Choose which details to use.')
  const d = member.details
  const set: Record<string, unknown> = {}
  for (const f of fields as DetailField[]) {
    const v = d[f]
    if (v === null || v === undefined || v === '') continue
    if (f === 'gender' && !(genders as readonly unknown[]).includes(v)) continue
    set[f] = f === 'email' || f === 'guardianEmail' ? String(v).trim().toLowerCase() : v
  }
  const applied = Object.keys(set)
  if (applied.length === 0) throw invalid('Those details are blank on the form, so there’s nothing to use.')
  const at = now.toISOString()
  await runBatch(db, [
    db
      .update(players)
      .set({ ...set, updatedAt: at, updatedBy: actor.id })
      .where(eq(players.id, member.playerId)),
    audit(db, actor, 'player.update', { type: 'player', id: member.playerId }, null, { fields: applied, fromInterest: interestId }, at),
    db
      .insert(auditLog)
      .values(
        auditEntry(
          actor,
          'interest.update',
          { type: 'interest', id: interestId },
          null,
          { action: 'apply_details', memberId: member.id, fields: applied },
          at,
        ),
      ),
  ])
}

const parseIds = (v: unknown): string[] => {
  if (!Array.isArray(v) || v.length === 0) throw invalid('Choose some expressions of interest.')
  const ids = [...new Set(v.filter(isId))]
  if (ids.length === 0) throw invalid('Choose some expressions of interest.')
  if (ids.length > MAX_BULK) throw invalid(`At most ${MAX_BULK} at a time.`)
  return ids
}

/**
 * Bulk actions on several EOIs: `status` (every programme on them, or just `programmeId`; not `placed`, which needs
 * a season), `archive`, `unarchive`. One statement plus an audit row.
 */
export async function bulkInterestAction(
  db: AppDb,
  actor: Editor,
  input: { action?: unknown; ids?: unknown; status?: unknown; programmeId?: unknown },
  now = new Date(),
) {
  const ids = parseIds(input.ids)
  const at = now.toISOString()
  const touch = { updatedAt: at, updatedBy: actor.id }
  const auditRow = (after: Record<string, unknown>) =>
    db
      .insert(auditLog)
      .values(
        auditEntry(actor, 'interest.update', { type: 'interest', id: ids.length === 1 ? ids[0]! : 'bulk' }, null, { ...after, ids }, at),
      )
  if (input.action === 'status') {
    const status = parseStatus(input.status)
    if (status === 'placed') throw invalid('Place them one at a time, from each EOI’s page (it needs the season).')
    const programmeId = input.programmeId === undefined || input.programmeId === null || input.programmeId === '' ? null : input.programmeId
    if (programmeId !== null && !isId(programmeId)) throw invalid('Which programme?')
    const [changed] = (await runBatch(db, [
      db
        .update(interestProgrammes)
        .set({ status, seasonId: null, teamId: null, ...touch })
        .where(
          and(
            inArray(interestProgrammes.interestId, ids),
            programmeId ? eq(interestProgrammes.programmeId, programmeId) : undefined,
            ne(interestProgrammes.status, status),
          ),
        )
        .returning({ id: interestProgrammes.interestId }),
      db.update(interests).set(touch).where(inArray(interests.id, ids)),
      auditRow({ action: 'status', status, programmeId }),
    ])) as unknown as [{ id: string }[]]
    return { changed: new Set(changed.map((c) => c.id)).size }
  }
  if (input.action === 'archive' || input.action === 'unarchive') {
    const archive = input.action === 'archive'
    const [changed] = (await runBatch(db, [
      db
        .update(interests)
        .set({ archivedAt: archive ? at : null, ...touch })
        .where(and(inArray(interests.id, ids), archive ? isNull(interests.archivedAt) : isNotNull(interests.archivedAt)))
        .returning({ id: interests.id }),
      auditRow({ action: input.action }),
    ])) as unknown as [{ id: string }[]]
    return { changed: changed.length }
  }
  throw invalid('Unknown action.')
}

/**
 * Deletes EOIs for good, with an audit row that records the references and how many people, never who. By default
 * the player rows each EOI created are deleted too when nothing else uses them (a spam EOI leaves nothing behind);
 * players who were already on file, or who have since enrolled, played or sent another EOI, are kept.
 */
export async function deleteInterests(db: AppDb, actor: Editor, rawIds: unknown, opts: { keepPlayers?: boolean } = {}, now = new Date()) {
  const ids = parseIds(rawIds)
  const at = now.toISOString()
  const found = await db
    .select({ id: interests.id, reference: interests.reference, createdAt: interests.createdAt })
    .from(interests)
    .where(inArray(interests.id, ids))
  if (found.length === 0) return { deleted: 0, playersDeleted: 0 }
  const memberRows = await db
    .select({ playerId: interestMembers.playerId, interestId: interestMembers.interestId })
    .from(interestMembers)
    .where(inArray(interestMembers.interestId, ids))
  // The player rows these EOIs created (created with the EOI, from a form or by hand), as candidates; the delete
  // below keeps any that something else now uses.
  const createdAtOf = new Map(found.map((f) => [f.id, f.createdAt]))
  const memberPlayers = [...new Set(memberRows.map((m) => m.playerId).filter((p): p is string => !!p))].slice(0, 90)
  const playerRows =
    opts.keepPlayers || memberPlayers.length === 0
      ? []
      : await db
          .select({ id: players.id, createdAt: players.createdAt, source: players.source })
          .from(players)
          .where(inArray(players.id, memberPlayers))
  const candidates = playerRows
    .filter(
      (p) =>
        (p.source === 'interest' || p.source === 'admin') &&
        memberRows.some((m) => m.playerId === p.id && createdAtOf.get(m.interestId) === p.createdAt),
    )
    .map((p) => p.id)
  const statements = [
    db
      .insert(auditLog)
      .values(
        auditEntry(
          actor,
          'interest.delete',
          { type: 'interest', id: found.length === 1 ? found[0]!.id : 'bulk' },
          { references: found.map((f) => f.reference), people: memberRows.length },
          { playersDeleted: candidates.length },
          at,
        ),
      ),
    db.delete(interests).where(inArray(interests.id, ids)).returning({ id: interests.id }),
  ]
  if (candidates.length > 0) {
    statements.push(
      db
        .delete(players)
        .where(
          and(
            inArray(players.id, candidates),
            sql`not exists (select 1 from interest_members m where m.player_id = ${players.id})`,
            sql`not exists (select 1 from registrations r where r.player_id = ${players.id})`,
            sql`not exists (select 1 from season_team_players s where s.player_id = ${players.id})`,
            sql`not exists (select 1 from groups g where g.captain_player_id = ${players.id})`,
          ),
        )
        .returning({ id: players.id }) as never,
    )
  }
  const results = (await runBatch(db, statements)) as unknown as [unknown, { id: string }[], { id: string }[] | undefined]
  return { deleted: results[1].length, playersDeleted: results[2]?.length ?? 0 }
}

// ── Added by hand ─────────────────────────────────────────────────────────────

export type AdminInterestInput = {
  kind?: unknown
  teamName?: unknown
  programmeIds?: unknown
  /** The contact first, then team members: { firstName, lastName, email?, phone?, gender?, birthYear?, … }. */
  members?: unknown
  answers?: unknown
  note?: unknown
  /** Override the deposit worked out from the programmes (cents; null = none). */
  depositCents?: unknown
}

const optText = (v: unknown, label: string, max: number) => optionalText(v, label, max)

/** One person typed in by hand: names required; everything else optional and checked. */
export function parseMember(v: unknown, label: string): MemberDetails {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  const firstName = optText(o.firstName, `${label}: first name`, 80)
  const lastName = optText(o.lastName, `${label}: last name`, 80)
  if (!firstName || !lastName) throw invalid(`${label}: enter a first and last name.`)
  const email = o.email === undefined || o.email === null || o.email === '' ? null : normaliseEmail(o.email)
  if (email && !isEmail(email)) throw invalid(`${label}: that email address doesn’t look right.`)
  const phone = optText(o.phone, `${label}: phone`, 30)
  if (phone && !isPhone(phone)) throw invalid(`${label}: that phone number doesn’t look right.`)
  const gender = o.gender === undefined || o.gender === null || o.gender === '' ? null : o.gender
  if (gender !== null && !(genders as readonly unknown[]).includes(gender)) throw invalid(`${label}: pick a gender from the list.`)
  const year = new Date().getUTCFullYear()
  const birthYear = o.birthYear === undefined || o.birthYear === null || o.birthYear === '' ? null : Number(o.birthYear)
  if (birthYear !== null && (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > year))
    throw invalid(`${label}: year of birth should be like 1995.`)
  const vnswNumber = optText(o.vnswNumber, `${label}: VNSW number`, 30)
  const guardianEmail = o.guardianEmail ? normaliseEmail(o.guardianEmail) : null
  if (guardianEmail && !isEmail(guardianEmail)) throw invalid(`${label}: the guardian’s email doesn’t look right.`)
  return {
    ...emptyDetails(firstName, lastName, email),
    phone,
    gender: gender as Gender | null,
    birthYear,
    suburb: optText(o.suburb, `${label}: suburb`, 80),
    vnswNumber,
    guardianName: optText(o.guardianName, `${label}: guardian name`, 120),
    guardianEmail,
    guardianPhone: optText(o.guardianPhone, `${label}: guardian phone`, 30),
    emergencyContact: optText(o.emergencyContact, `${label}: emergency contact`, 200),
  }
}

/** The EOI form's questions now: Settings → Interest's form, else the built-in default. */
export async function interestFormNow(db: AppDb, formId: string) {
  if (formId) {
    const f = await db.select().from(enrolmentForms).where(eq(enrolmentForms.id, formId)).get()
    if (f) return { id: f.id, version: f.version, name: f.name, fields: activeFields(f.fields) }
  }
  return { id: null, version: null, name: 'Built-in default', fields: activeFields(defaultInterestFields()) }
}

export type InterestOptions = {
  programmes: InterestProgrammeOption[]
  form: { id: string | null; name: string; fields: FormField[] }
  maxMembers: number
}

/** What the "Add EOI" dialog needs: programmes, the form's questions, and the member limit. */
export async function interestOptions(db: AppDb, now = new Date()): Promise<InterestOptions> {
  const settings = await getSettings(db)
  const [progs, form] = await Promise.all([interestProgrammeOptions(db, now), interestFormNow(db, settings.interest.formId)])
  return {
    programmes: progs,
    form: { id: form.id, name: form.name, fields: form.fields.filter((f) => !isMapped(f.type) && !isDisplayOnly(f.type)) },
    maxMembers: Math.max(settings.interest.maxMembers, ADMIN_MAX_MEMBERS),
  }
}

/**
 * An EOI typed in by the admin (a phone call): through createInterest with source admin and the actor (audited
 * interest.create). No Turnstile, no emails. Names are required; email and phone are optional (a phone call may
 * give only one), but the contact needs at least one of them. Existing players are matched and never overwritten.
 */
export async function addInterestByHand(db: AppDb, actor: Editor, input: AdminInterestInput, now = new Date()) {
  const kind = input.kind
  if (!(interestKinds as readonly unknown[]).includes(kind)) throw invalid('Is it a player or a team?')
  const teamName = kind === 'team' ? optText(input.teamName, 'The team name', 80) : null
  if (kind === 'team' && !teamName) throw invalid('Enter the team name.')
  if (!Array.isArray(input.members) || input.members.length === 0) throw invalid('Enter the contact’s name.')
  if (input.members.length > ADMIN_MAX_MEMBERS) throw invalid(`At most ${ADMIN_MAX_MEMBERS} people.`)
  if (kind === 'player' && input.members.length > 1) throw invalid('A player EOI is one person. Use a team EOI for several.')
  const members = input.members.map((m, i) =>
    parseMember(m, i === 0 ? (kind === 'team' ? 'The captain' : 'The player') : `Member ${i + 1}`),
  )
  if (!members[0]!.email && !members[0]!.phone) throw invalid('Enter the contact’s email or phone, so you can reach them.')
  if (!Array.isArray(input.programmeIds) || input.programmeIds.length === 0) throw invalid('Pick at least one programme.')
  const ids = [...new Set(input.programmeIds.filter(isId))].slice(0, 20)
  const progs = ids.length
    ? await db
        .select({ id: programmes.id, kind: programmes.kind, dp: programmes.depositPlayerCents, dt: programmes.depositTeamCents })
        .from(programmes)
        .where(inArray(programmes.id, ids))
    : []
  if (progs.length !== ids.length || ids.length === 0) throw invalid('One of those programmes no longer exists.')
  const settings = await getSettings(db)
  const form = await interestFormNow(db, settings.interest.formId)
  // The form's own questions, checked like the public form but with nothing required (an admin may not have every
  // answer); person fields are checked above.
  const checked = validateEnrolment(
    form.fields.filter((f) => !isMapped(f.type)),
    kind === 'team' ? 'team' : 'free_agent',
    { firstName: members[0]!.firstName, lastName: members[0]!.lastName, email: members[0]!.email ?? 'nobody@example.com', phone: '' },
    input.answers ?? {},
    { currentYear: now.getUTCFullYear(), relaxRequired: true },
  )
  if (!checked.ok) {
    const first = Object.entries(checked.errors)[0]
    const field = form.fields.find((f) => f.key === first?.[0])
    throw invalid(`${field?.label ?? 'An answer'}: ${first?.[1] ?? 'check it'}`)
  }
  const deposits = progs.map((p) => (kind === 'team' ? p.dt : p.dp)).filter((c): c is number => c !== null)
  let depositCents: number | null = deposits.length ? Math.max(...deposits) : null
  if (input.depositCents !== undefined) {
    if (input.depositCents === null || input.depositCents === '') depositCents = null
    else {
      const n = Number(input.depositCents)
      if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw invalid('The deposit should be an amount in dollars, like 50.')
      depositCents = n
    }
  }
  const note = optionalText(input.note, 'The note', 2000)
  const pool: PlayerPool = progs.some((p) => poolOfKind(p.kind) === 'competition') ? 'competition' : 'training'
  return createInterest(db, {
    kind: kind as InterestKind,
    pool,
    teamName,
    members,
    programmeIds: ids,
    // Unanswered questions aren't kept: an unticked consent typed in by an admin isn't a "No" from the person.
    answers: Object.fromEntries(
      Object.entries(checked.answers).filter(([, v]) => v !== false && v !== '' && v !== null && !(Array.isArray(v) && v.length === 0)),
    ),
    formId: form.id,
    formVersion: form.version,
    depositCents,
    source: 'admin',
    note,
    actor,
    now,
  })
}

// ── CSV ───────────────────────────────────────────────────────────────────────

/**
 * The EOIs matching a filter as CSV, one row per person (the contact first, then team members), with the EOI's
 * columns on every row and its answers on the contact's row. Spreadsheet-safe like the enrolment CSV (csvCell).
 * Audited as interest.export with the filter and row count.
 */
export async function exportInterests(db: AppDb, actor: Editor, filter: InterestFilter, now = new Date()) {
  const options = await interestProgrammeOptions(db, now)
  const rows = await db
    .select({
      id: interests.id,
      kind: interests.kind,
      reference: interests.reference,
      teamName: interests.teamName,
      answers: interests.answers,
      formId: interests.formId,
      depositCents: interests.depositCents,
      paidAt: interests.paidAt,
      paymentNote: interests.paymentNote,
      note: interests.note,
      source: interests.source,
      archivedAt: interests.archivedAt,
      createdAt: interests.createdAt,
    })
    .from(interests)
    .where(filterWhere(db, filter, options))
    .orderBy(desc(interests.createdAt), desc(interests.id))
    .limit(EXPORT_LIMIT)
  // Members and programmes in chunks of 90 ids (D1's 100 parameters), forms by id.
  const memberRows: { interestId: string; sort: number; role: RosterRole; details: MemberDetails }[] = []
  const progRows: (InterestProgrammeRow & { interestId: string })[] = []
  const formIds = [...new Set(rows.map((r) => r.formId).filter((f): f is string => !!f))]
  const chunks: string[][] = []
  for (let i = 0; i < rows.length; i += 90) chunks.push(rows.slice(i, i + 90).map((r) => r.id))
  const statements = [
    ...chunks.flatMap((ids) => [
      db
        .select({
          interestId: interestMembers.interestId,
          sort: interestMembers.sort,
          role: interestMembers.role,
          details: interestMembers.details,
        })
        .from(interestMembers)
        .where(inArray(interestMembers.interestId, ids)),
      programmeRowsQuery(db, inArray(interestProgrammes.interestId, ids)),
    ]),
    ...(formIds.length
      ? [
          db
            .select({ id: enrolmentForms.id, fields: enrolmentForms.fields })
            .from(enrolmentForms)
            .where(inArray(enrolmentForms.id, formIds.slice(0, 90))),
        ]
      : []),
  ]
  const results = statements.length ? ((await runBatch(db, statements as never)) as unknown as unknown[][]) : []
  chunks.forEach((_, i) => {
    memberRows.push(...(results[i * 2] as typeof memberRows))
    progRows.push(...(results[i * 2 + 1] as typeof progRows))
  })
  const forms = formIds.length ? (results.at(-1) as { id: string; fields: FormField[] }[]) : []
  const csv = interestsCsv(
    rows.map((r) => ({
      ...r,
      members: memberRows.filter((m) => m.interestId === r.id).sort((a, b) => a.sort - b.sort),
      programmes: progRows.filter((p) => p.interestId === r.id),
    })),
    [
      ...forms.flatMap((f) => (typeof f.fields === 'string' ? (JSON.parse(f.fields) as FormField[]) : f.fields)),
      ...defaultInterestFields(),
    ],
  )
  const people = memberRows.length
  await audit(
    db,
    actor,
    'interest.export',
    { type: 'interest', id: filter.programmeId ?? 'all' },
    null,
    { filter, rows: people, interests: rows.length },
    now.toISOString(),
  )
  return {
    csv,
    filename:
      `interest-${filter.programmeId ? (options.find((o) => o.id === filter.programmeId)?.code ?? 'programme') : 'all'}-${now.toISOString().slice(0, 10)}.csv`.toLowerCase(),
  }
}

const STATUS_LABEL: Record<InterestStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  placed: 'Placed',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}

export type CsvInterest = {
  kind: InterestKind
  reference: string
  teamName: string | null
  answers: Record<string, unknown>
  depositCents: number | null
  paidAt: string | null
  paymentNote: string | null
  note: string | null
  source: string
  archivedAt: string | null
  createdAt: string
  members: { role: RosterRole; details: MemberDetails }[]
  programmes: Pick<InterestProgrammeRow, 'code' | 'status' | 'seasonName' | 'teamName'>[]
}

/** Pure, so it's tested without a database. `fields` label the answer columns (first label for a key wins). */
export function interestsCsv(rows: readonly CsvInterest[], fields: readonly FormField[]): string {
  const labels = new Map<string, FormField>()
  for (const f of fields) if (!labels.has(f.key) && !isDisplayOnly(f.type) && !isMapped(f.type)) labels.set(f.key, f)
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r.answers ?? {})))].sort(
    (a, b) => [...labels.keys()].indexOf(a) - [...labels.keys()].indexOf(b) || a.localeCompare(b),
  )
  const header = [
    'Reference',
    'Sent (UTC)',
    'Entry',
    'Team',
    'Role',
    'First name',
    'Last name',
    'Email',
    'Phone',
    'Gender',
    'Year of birth',
    'Suburb',
    'VNSW number',
    'Guardian name',
    'Guardian email',
    'Guardian phone',
    'Emergency contact',
    'Programmes',
    'Deposit (AUD)',
    'Paid',
    'Payment note',
    'Note',
    'Source',
    'Archived',
    ...keys.map((k) => labels.get(k)?.label ?? k),
  ]
  const out: unknown[][] = [header]
  for (const r of rows) {
    const progs = r.programmes
      .map((p) => `${p.code}: ${STATUS_LABEL[p.status]}${p.seasonName ? ` (${p.seasonName}${p.teamName ? `, ${p.teamName}` : ''})` : ''}`)
      .join('; ')
    const people = r.members.length ? r.members : [{ role: 'player' as RosterRole, details: emptyDetails('', '') }]
    people.forEach((m, i) => {
      const d = m.details
      out.push([
        r.reference,
        r.createdAt,
        r.kind === 'team' ? 'Team' : 'Player',
        r.teamName ?? '',
        r.kind === 'team' ? (m.role === 'captain' ? 'Captain' : 'Member') : 'Player',
        d.firstName,
        d.lastName,
        d.email ?? '',
        d.phone ?? '',
        d.gender ?? '',
        d.birthYear ?? '',
        d.suburb ?? '',
        d.vnswNumber ?? '',
        d.guardianName ?? '',
        d.guardianEmail ?? '',
        d.guardianPhone ?? '',
        d.emergencyContact ?? '',
        progs,
        r.depositCents === null ? '' : (r.depositCents / 100).toFixed(2),
        r.paidAt ? r.paidAt.slice(0, 10) : '',
        r.paymentNote ?? '',
        r.note ?? '',
        r.source,
        r.archivedAt ? r.archivedAt.slice(0, 10) : '',
        ...keys.map((k) => (i === 0 ? answerText(labels.get(k), r.answers?.[k]) : '')),
      ])
    })
  }
  return toCsv(out)
}

// ── Retention ─────────────────────────────────────────────────────────────────

/** Archived EOIs the cron deletes per run (each delete cascades to its members and programmes). */
export const PRUNE_LIMIT = 200

/**
 * Cron: deletes EOIs archived longer ago than Settings → Interest's retention (0 = keep: no statement), at most
 * PRUNE_LIMIT a run. One bounded statement for the housekeeping batch; the player rows stay (they're the directory).
 */
export const pruneInterestsStatement = (db: AppDb, retentionDays: number, now = new Date()) =>
  retentionDays > 0
    ? db
        .delete(interests)
        .where(
          inArray(
            interests.id,
            db
              .select({ id: interests.id })
              .from(interests)
              .where(
                and(
                  isNotNull(interests.archivedAt),
                  lt(interests.archivedAt, new Date(now.getTime() - retentionDays * 24 * HOUR).toISOString()),
                ),
              )
              .limit(PRUNE_LIMIT),
          ),
        )
        .returning({ id: interests.id })
    : null
