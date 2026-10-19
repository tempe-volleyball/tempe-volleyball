import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { toCsv } from '../../lib/enrolment/csv'
import { isEmail, isPhone, normaliseEmail } from '../../lib/enrolment/validate'
import { PLAYER_GROUP_LABELS, playerGroups, type PlayerGroup } from '../../lib/players/groups'
import { sydneyDate } from '../../lib/time'
import { runBatch, type AppDb } from '../db'
import {
  auditLog,
  closedRegistrationStatuses,
  genders,
  groups,
  interestMembers,
  interestProgrammes,
  interests,
  playerPools,
  players,
  products,
  programmes,
  registrations,
  seasons,
  seasonTeamPlayers,
  teams,
  user,
  type Gender,
  type InterestKind,
  type InterestStatus,
  type Player,
  type PlayerPool,
  type ProgrammeKind,
  type RosterRole,
} from '../db/schema'
import { audit, conflict, invalid, isUniqueFailure, likeEscaped, likePattern, notFound, optionalText, type Editor } from '../content/common'
import { HttpError } from '../http'
import { joinTargetRows, labelOfRow, refOfProduct, targetLabelColumns } from '../enrolment/core'
import type { TargetRef } from '../../lib/enrolment/targets'
import { groupContext, latestSpots, newestInterestBy, openInterestRows, type DirectoryPlayer, type RosterSpot } from './directory'

// Admin → Players (docs/interest.md "Players", docs/admin.md §3.16, docs/api/players.md): competition and training
// players kept apart (players.pool), each a searchable, filterable list; a player's page with every EOI, enrolment
// and roster spot; add by hand, edit, retire, merge two duplicates, delete (only with no history), CSV export.
// Admins and owners only (personal data).
//
// Both pools are SQL pages (search, filters, sort and counts in SQL). Competition groups come from the directory's
// groupContext() SQL, so they match the season builder's picker exactly; reads grow with the number of players, not
// with seasons of history.

export const PAGE_SIZE = 50
/** Request bodies of the players routes: a handful of fields. */
export const PLAYER_BODY_LIMIT = 32 * 1024
/** The most players one CSV export writes. */
export const EXPORT_LIMIT = 5000

export const LIMITS = { name: 80, email: 254, phone: 30, suburb: 80, vnsw: 30, guardianName: 120, emergency: 200, notes: 2000 } as const

export const playerSorts = ['name', 'newest', 'updated'] as const
export type PlayerSort = (typeof playerSorts)[number]
/** Hide retired players (the default), only retired, or everyone. */
export const retiredFilters = ['hide', 'only', 'any'] as const
export type RetiredFilter = (typeof retiredFilters)[number]

/** A competition group, or `all` (everyone, retired included). */
export type GroupFilter = PlayerGroup | 'all'

export type PlayerQuery = {
  pool: PlayerPool
  q: string | null
  /** Competition: the group (for `leagueId`, else across all leagues). */
  group: GroupFilter
  leagueId: string | null
  /** Training: players with an enrolment in this programme. */
  programmeId: string | null
  retired: RetiredFilter
  sort: PlayerSort
  page: number
}

const pickOf = <T extends string>(list: readonly T[], v: string | null | undefined, fallback: T): T =>
  (list as readonly string[]).includes(v ?? '') ? (v as T) : fallback
const idParam = (v: string | null) => (v && /^[\w-]{1,64}$/.test(v) ? v : null)

export function parsePlayerQuery(p: URLSearchParams): PlayerQuery {
  return {
    pool: pickOf(playerPools, p.get('pool'), 'competition'),
    q: p.get('q')?.trim().slice(0, 100) || null,
    group: pickOf<GroupFilter>([...playerGroups, 'all'], p.get('group'), 'all'),
    leagueId: idParam(p.get('league')),
    programmeId: idParam(p.get('programme')),
    retired: pickOf(retiredFilters, p.get('retired'), 'hide'),
    sort: pickOf(playerSorts, p.get('sort'), 'name'),
    page: Math.max(1, Math.min(10_000, Number.parseInt(p.get('page') ?? '1', 10) || 1)),
  }
}

export type PlayerListItem = {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  gender: Gender | null
  retiredAt: string | null
  createdAt: string
  /** Competition: their group for the league (or across leagues). */
  group: PlayerGroup | null
  /** Competition: their latest roster spot. */
  lastSpot: RosterSpot | null
  /** Competition: their newest open EOI. */
  interest: DirectoryPlayer['interest']
  /** Training: how many enrolments, and the latest one's target. */
  enrolments: number | null
  lastEnrolment: { label: string; programmeName: string; createdAt: string } | null
}

export type PlayerList = {
  pool: PlayerPool
  rows: PlayerListItem[]
  total: number
  page: number
  pages: number
  /** Competition: players per group (search and the retired filter applied, not the group). */
  groupCounts: Record<GroupFilter, number> | null
  /** The league the groups are for, and its window. */
  league: { id: string; code: string; name: string } | null
  lastSeason: { id: string; name: string; startDate: string } | null
  interestSince: string | null
  /** For the filters: leagues and events (competition) or training and development programmes (training). */
  programmes: { id: string; code: string; name: string; kind: ProgrammeKind }[]
  /** Always false now (both pools page in SQL); kept for older admin bundles. */
  truncated: boolean
  /** The most rows the CSV export writes (the screen says so when the list is longer). */
  exportLimit: number
}

const listProgrammes = (db: AppDb, pool: PlayerPool) =>
  db
    .select({ id: programmes.id, code: programmes.code, name: programmes.name, kind: programmes.kind })
    .from(programmes)
    .where(pool === 'competition' ? inArray(programmes.kind, ['league', 'event']) : inArray(programmes.kind, ['training', 'development']))
    .orderBy(programmes.kind, programmes.sort, programmes.name)

/** A page of a pool's players, with group counts for competition players. */
export async function listPlayers(db: AppDb, q: PlayerQuery, now = new Date()): Promise<PlayerList> {
  return q.pool === 'competition' ? listCompetition(db, q, now) : listTraining(db, q)
}

/** The competition list's WHERE: search, then the group (or, for Everyone, the retired filter). */
const competitionWhere = (q: PlayerQuery, groupSql: SQL<PlayerGroup>, withGroup: boolean) =>
  and(
    eq(players.pool, 'competition'),
    searchWhere(q.q),
    withGroup ? (q.group === 'all' ? retiredWhere(q.retired) : sql`${groupSql} = ${q.group}`) : undefined,
  )

const spotOnly = (s: RosterSpot): RosterSpot => ({
  seasonId: s.seasonId,
  seasonName: s.seasonName,
  startDate: s.startDate,
  leagueId: s.leagueId,
  leagueCode: s.leagueCode,
  teamId: s.teamId,
  teamName: s.teamName,
})

/**
 * Competition players: paged, counted and searched in SQL, with each player's group from groupContext() (the
 * same SQL as the season builder's picker, so the two agree). Reads: the window (two), then one batch (the group
 * counts, the page, the programmes), then the page's latest spots and open EOIs (50 players).
 */
async function listCompetition(db: AppDb, q: PlayerQuery, now: Date): Promise<PlayerList> {
  const ctx = await groupContext(db, { leagueId: q.leagueId, today: sydneyDate(now) })
  const [countRows, rows, progs] = (await runBatch(db, [
    db
      .select({ group: sql<PlayerGroup>`${ctx.groupSql}`.as('grp'), n: sql<number>`count(*)`.as('n') })
      .from(players)
      .where(competitionWhere(q, ctx.groupSql, false))
      .groupBy(sql`grp`),
    db
      .select({
        id: players.id,
        firstName: players.firstName,
        lastName: players.lastName,
        email: players.email,
        phone: players.phone,
        gender: players.gender,
        retiredAt: players.retiredAt,
        createdAt: players.createdAt,
        group: sql<PlayerGroup>`${ctx.groupSql}`.as('grp'),
      })
      .from(players)
      .where(competitionWhere(q, ctx.groupSql, true))
      .orderBy(...orderOf(q.sort))
      .limit(PAGE_SIZE)
      .offset((q.page - 1) * PAGE_SIZE),
    listProgrammes(db, 'competition'),
  ])) as unknown as [
    { group: PlayerGroup; n: number }[],
    (Pick<PlayerListItem, 'id' | 'firstName' | 'lastName' | 'email' | 'phone' | 'gender' | 'retiredAt' | 'createdAt'> & {
      group: PlayerGroup
    })[],
    PlayerList['programmes'],
  ]
  // The retired filter: Retired is its own group, so "hide" only applies to Everyone.
  const counts = Object.fromEntries([...playerGroups, 'all'].map((g) => [g, 0])) as Record<GroupFilter, number>
  for (const c of countRows) {
    counts[c.group] = Number(c.n)
    if (q.retired === 'only' ? c.group === 'retired' : q.retired === 'any' || c.group !== 'retired') counts.all += Number(c.n)
  }
  const total = counts[q.group]
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  // Past the end (the list shrank since the link was made): the last page instead.
  if (rows.length === 0 && q.page > pages && total > 0) return listCompetition(db, { ...q, page: pages }, now)
  const ids = rows.map((r) => r.id)
  const [spots, open] = await Promise.all([
    latestSpots(db, { preferLeagueId: q.leagueId, playerIds: ids }),
    ids.length ? openInterestRows(db, { leagueId: q.leagueId, playerIds: ids }) : Promise.resolve([]),
  ])
  const spotBy = new Map(spots.map((s) => [s.playerId, s]))
  const eoi = newestInterestBy(open)
  return {
    pool: 'competition',
    rows: rows.map((p) => {
      const s = spotBy.get(p.id)
      return { ...p, lastSpot: s ? spotOnly(s) : null, interest: eoi.get(p.id) ?? null, enrolments: null, lastEnrolment: null }
    }),
    total,
    page: Math.min(q.page, pages),
    pages,
    groupCounts: counts,
    league: ctx.league,
    lastSeason: ctx.lastSeason,
    interestSince: ctx.interestSince,
    programmes: progs,
    truncated: false,
    exportLimit: EXPORT_LIMIT,
  }
}

/** Every word must match the name, email or phone (spaces in phone numbers ignored). */
function searchWhere(q: string | null): SQL | undefined {
  const words = (q ?? '').split(/\s+/).filter(Boolean).slice(0, 5)
  if (words.length === 0) return undefined
  const hay = sql`(${players.firstName} || ' ' || ${players.lastName} || ' ' || ${players.email} || ' ' || replace(coalesce(${players.phone}, ''), ' ', ''))`
  return and(...words.map((w) => likeEscaped(hay, likePattern(w))))
}

const retiredWhere = (r: RetiredFilter) =>
  r === 'hide' ? isNull(players.retiredAt) : r === 'only' ? isNotNull(players.retiredAt) : undefined

const trainingWhere = (q: PlayerQuery) =>
  and(
    eq(players.pool, 'training'),
    retiredWhere(q.retired),
    searchWhere(q.q),
    q.programmeId
      ? sql`exists (select 1 from registrations r join products pr on pr.id = r.product_id where r.player_id = ${players.id} and pr.programme_id = ${q.programmeId})`
      : undefined,
  )

const orderOf = (sort: PlayerSort) =>
  sort === 'newest'
    ? [desc(players.createdAt), desc(players.id)]
    : sort === 'updated'
      ? [desc(players.updatedAt), desc(players.id)]
      : [asc(sql`lower(${players.lastName})`), asc(sql`lower(${players.firstName})`), asc(players.id)]

async function listTraining(db: AppDb, q: PlayerQuery): Promise<PlayerList> {
  const where = trainingWhere(q)
  const [[{ n }], progs] = (await runBatch(db, [
    db
      .select({ n: sql<number>`count(*)` })
      .from(players)
      .where(where),
    listProgrammes(db, 'training'),
  ])) as unknown as [[{ n: number }], PlayerList['programmes']]
  const total = Number(n)
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const page = Math.min(q.page, pages)
  const rows = await db
    .select({
      id: players.id,
      firstName: players.firstName,
      lastName: players.lastName,
      email: players.email,
      phone: players.phone,
      gender: players.gender,
      retiredAt: players.retiredAt,
      createdAt: players.createdAt,
    })
    .from(players)
    .where(where)
    .orderBy(...orderOf(q.sort))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)
  const ids = rows.map((r) => r.id)
  const regs = ids.length
    ? await joinTargetRows(
        db
          .select({
            playerId: registrations.playerId,
            createdAt: registrations.createdAt,
            programmeName: sql<string>`${programmes.name}`.as('programme_name'),
            ...targetLabelColumns,
          })
          .from(registrations)
          .innerJoin(products, eq(products.id, registrations.productId))
          .leftJoin(programmes, eq(programmes.id, products.programmeId))
          .$dynamic(),
      )
        .where(inArray(registrations.playerId, ids))
        .orderBy(desc(registrations.createdAt))
    : []
  return {
    pool: 'training',
    rows: rows.map((r) => {
      const mine = regs.filter((g) => g.playerId === r.id)
      const latest = mine[0]
      return {
        ...r,
        group: null,
        lastSpot: null,
        interest: null,
        enrolments: mine.length,
        lastEnrolment: latest
          ? { label: labelOfRow(latest), programmeName: latest.programmeName ?? '', createdAt: latest.createdAt }
          : null,
      }
    }),
    total,
    page,
    pages,
    groupCounts: null,
    league: null,
    lastSeason: null,
    interestSince: null,
    programmes: progs,
    truncated: false,
    exportLimit: EXPORT_LIMIT,
  }
}

// ── One player ────────────────────────────────────────────────────────────────

export type PlayerDetail = {
  player: Player & { updatedByName: string | null }
  interests: {
    interestId: string
    reference: string
    kind: InterestKind
    teamName: string | null
    role: RosterRole
    createdAt: string
    archivedAt: string | null
    programmes: { programmeId: string; code: string; status: InterestStatus }[]
  }[]
  enrolments: {
    id: string
    reference: string
    status: string
    programmeId: string | null
    programmeName: string | null
    label: string
    teamName: string | null
    freeAgent: boolean
    amountCents: number | null
    paidAt: string | null
    createdAt: string
    /** Its season, session, term or event (Admin → Enrolments → /enrolments/<kind>/<id>). */
    target: TargetRef | null
  }[]
  rosters: (RosterSpot & { role: RosterRole; leagueName: string })[]
  captainOf: { groupId: string; name: string }[]
  history: { at: string; action: string; actorEmail: string | null; after: unknown }[]
  /** What stops a delete (counts). */
  references: { registrations: number; interests: number; rosters: number; captainOf: number }
}

const updatedByUser = alias(user, 'player_updated_by')
const auditActor = alias(user, 'player_audit_actor')

/** A player with every EOI, enrolment and roster spot: one batch of eight reads. */
export async function getPlayer(db: AppDb, id: string): Promise<PlayerDetail> {
  const [rows, eois, progs, regs, spots, captains, regCount, history] = (await runBatch(db, [
    db
      .select({ p: players, updatedByName: sql<string | null>`${updatedByUser.name}`.as('updated_by_name') })
      .from(players)
      .leftJoin(updatedByUser, eq(updatedByUser.id, players.updatedBy))
      .where(eq(players.id, id)),
    db
      .select({
        interestId: interests.id,
        reference: interests.reference,
        kind: interests.kind,
        teamName: interests.teamName,
        role: interestMembers.role,
        createdAt: interests.createdAt,
        archivedAt: interests.archivedAt,
      })
      .from(interestMembers)
      .innerJoin(interests, eq(interests.id, interestMembers.interestId))
      .where(eq(interestMembers.playerId, id))
      .orderBy(desc(interests.createdAt))
      .limit(100),
    db
      .select({
        interestId: interestProgrammes.interestId,
        programmeId: interestProgrammes.programmeId,
        code: programmes.code,
        status: interestProgrammes.status,
      })
      .from(interestProgrammes)
      .innerJoin(programmes, eq(programmes.id, interestProgrammes.programmeId))
      .innerJoin(interestMembers, eq(interestMembers.interestId, interestProgrammes.interestId))
      .where(eq(interestMembers.playerId, id)),
    joinTargetRows(
      db
        .select({
          id: registrations.id,
          reference: registrations.reference,
          status: registrations.status,
          programmeId: products.programmeId,
          programmeName: sql<string | null>`${programmes.name}`.as('programme_name'),
          teamName: sql<string | null>`${groups.name}`.as('group_name'),
          freeAgent: registrations.freeAgent,
          amountCents: registrations.amountCents,
          paidAt: registrations.paidAt,
          createdAt: registrations.createdAt,
          // Aliased: D1 batch rows are keyed by column name.
          seasonId: sql<string | null>`${products.seasonId}`.as('t_season_id'),
          sessionId: sql<string | null>`${products.sessionId}`.as('t_session_id'),
          termId: sql<string | null>`${products.termId}`.as('t_term_id'),
          eventId: sql<string | null>`${products.eventId}`.as('t_event_id'),
          ...targetLabelColumns,
        })
        .from(registrations)
        .innerJoin(products, eq(products.id, registrations.productId))
        .leftJoin(programmes, eq(programmes.id, products.programmeId))
        .leftJoin(groups, eq(groups.id, registrations.groupId))
        .$dynamic(),
    )
      .where(eq(registrations.playerId, id))
      .orderBy(desc(registrations.createdAt))
      .limit(200),
    db
      .select({
        // Aliased: D1 batch rows are keyed by column name (seasons.id and teams.id would collide).
        seasonId: sql<string>`${seasons.id}`.as('spot_season_id'),
        seasonName: sql<string>`${seasons.name}`.as('spot_season_name'),
        startDate: sql<string>`${seasons.startDate}`.as('spot_start_date'),
        leagueId: sql<string>`${seasons.leagueId}`.as('spot_league_id'),
        leagueCode: sql<string>`${programmes.code}`.as('spot_league_code'),
        leagueName: sql<string>`${programmes.name}`.as('spot_league_name'),
        teamId: sql<string>`${teams.id}`.as('spot_team_id'),
        teamName: sql<string>`${teams.name}`.as('spot_team_name'),
        role: sql<RosterRole>`${seasonTeamPlayers.role}`.as('spot_role'),
      })
      .from(seasonTeamPlayers)
      .innerJoin(seasons, eq(seasons.id, seasonTeamPlayers.seasonId))
      .innerJoin(programmes, eq(programmes.id, seasons.leagueId))
      .innerJoin(teams, eq(teams.id, seasonTeamPlayers.teamId))
      .where(eq(seasonTeamPlayers.playerId, id))
      .orderBy(desc(seasons.startDate)),
    db.select({ groupId: groups.id, name: groups.name }).from(groups).where(eq(groups.captainPlayerId, id)).limit(100),
    db
      .select({ n: sql<number>`count(*)` })
      .from(registrations)
      .where(eq(registrations.playerId, id)),
    db
      .select({
        at: auditLog.at,
        action: auditLog.action,
        actorEmail: sql<string | null>`${auditActor.email}`.as('actor_email'),
        after: auditLog.after,
      })
      .from(auditLog)
      .leftJoin(auditActor, eq(auditActor.id, auditLog.actorUserId))
      .where(and(eq(auditLog.targetType, 'player'), eq(auditLog.targetId, id)))
      .orderBy(desc(auditLog.at))
      .limit(20),
  ])) as unknown as [
    { p: Player; updatedByName: string | null }[],
    Omit<PlayerDetail['interests'][number], 'programmes'>[],
    { interestId: string; programmeId: string; code: string; status: InterestStatus }[],
    (Omit<PlayerDetail['enrolments'][number], 'label' | 'target'> &
      Parameters<typeof labelOfRow>[0] & {
        seasonId: string | null
        sessionId: string | null
        termId: string | null
        eventId: string | null
      })[],
    PlayerDetail['rosters'],
    PlayerDetail['captainOf'],
    { n: number }[],
    PlayerDetail['history'],
  ]
  const row = rows[0]
  if (!row) throw notFound('player')
  return {
    player: { ...row.p, updatedByName: row.updatedByName },
    interests: eois.map((e) => ({
      ...e,
      programmes: progs.filter((p) => p.interestId === e.interestId).map(({ interestId: _interestId, ...p }) => p),
    })),
    enrolments: regs.map((r) => ({
      id: r.id,
      reference: r.reference,
      status: r.status,
      programmeId: r.programmeId,
      programmeName: r.programmeName,
      label: labelOfRow(r),
      teamName: r.teamName,
      freeAgent: !!r.freeAgent,
      amountCents: r.amountCents,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
      target: refOfProduct(r),
    })),
    rosters: spots,
    captainOf: captains,
    history,
    references: {
      registrations: Number(regCount[0]?.n ?? regs.length),
      interests: eois.length,
      rosters: spots.length,
      captainOf: captains.length,
    },
  }
}

// ── Create and edit ───────────────────────────────────────────────────────────

export type PlayerInput = Record<string, unknown>

/** The editable columns. */
export const PLAYER_FIELDS = [
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
  'notes',
] as const
type PlayerField = (typeof PLAYER_FIELDS)[number]
type PlayerPatch = Partial<Pick<Player, PlayerField>>

const has = (o: PlayerInput, k: string) => o[k] !== undefined

/**
 * Checks the fields sent. Names ≤ 80 and required; email lower-cased and checked — optional for competition players
 * (team members may not have one; stored as '' because players.email is NOT NULL), required for training players
 * (enrolment matches them by it).
 */
export function parsePlayerFields(input: PlayerInput, pool: PlayerPool, creating: boolean, now = new Date()): PlayerPatch {
  const out: PlayerPatch = {}
  const text = (k: PlayerField, label: string, max: number) => {
    if (has(input, k)) (out as Record<string, unknown>)[k] = optionalText(input[k], label, max)
  }
  for (const [k, label] of [
    ['firstName', 'First name'],
    ['lastName', 'Last name'],
  ] as const) {
    if (creating || has(input, k)) {
      const v = optionalText(input[k], label, LIMITS.name)
      if (!v) throw invalid(`${label} is required.`)
      out[k] = v
    }
  }
  if (creating || has(input, 'email')) {
    const email = input.email === null || input.email === undefined ? '' : normaliseEmail(input.email)
    if (email && !isEmail(email)) throw invalid('That email address doesn’t look right.')
    if (!email && pool === 'training') throw invalid('Training players need an email address (enrolment matches them by it).')
    out.email = email
  }
  if (has(input, 'phone')) {
    const phone = optionalText(input.phone, 'Phone', LIMITS.phone)
    if (phone && !isPhone(phone)) throw invalid('That phone number doesn’t look right.')
    out.phone = phone
  }
  if (has(input, 'gender')) {
    const g = input.gender === '' || input.gender === null ? null : input.gender
    if (g !== null && !(genders as readonly unknown[]).includes(g)) throw invalid('Pick a gender from the list.')
    out.gender = g as Gender | null
  }
  if (has(input, 'birthYear')) {
    const v = input.birthYear === '' || input.birthYear === null ? null : Number(input.birthYear)
    if (v !== null && (!Number.isInteger(v) || v < 1900 || v > now.getUTCFullYear())) throw invalid('Year of birth should be like 1995.')
    out.birthYear = v
  }
  text('suburb', 'Suburb', LIMITS.suburb)
  if (has(input, 'vnswNumber')) {
    const v = optionalText(input.vnswNumber, 'VNSW number', LIMITS.vnsw)
    if (v && !/^[A-Za-z0-9 -]+$/.test(v)) throw invalid('The VNSW number should be letters and digits.')
    out.vnswNumber = v
  }
  text('guardianName', 'Guardian name', LIMITS.guardianName)
  if (has(input, 'guardianEmail')) {
    const v = input.guardianEmail === null || input.guardianEmail === '' ? null : normaliseEmail(input.guardianEmail)
    if (v && !isEmail(v)) throw invalid('The guardian’s email doesn’t look right.')
    out.guardianEmail = v
  }
  if (has(input, 'guardianPhone')) {
    const v = optionalText(input.guardianPhone, 'Guardian phone', LIMITS.phone)
    if (v && !isPhone(v)) throw invalid('The guardian’s phone number doesn’t look right.')
    out.guardianPhone = v
  }
  text('emergencyContact', 'Emergency contact', LIMITS.emergency)
  if (has(input, 'notes')) {
    if (input.notes !== null && typeof input.notes !== 'string') throw invalid('Notes must be text.')
    const v = ((input.notes as string | null) ?? '').trim()
    if (v.length > LIMITS.notes) throw invalid(`Notes are too long (at most ${LIMITS.notes} characters).`)
    out.notes = v || null
  }
  return out
}

/** Possible duplicates of a new player: the same pool and name, and the same email when one is given. */
async function sameNamed(db: AppDb, pool: PlayerPool, p: { firstName: string; lastName: string; email: string }, exceptId?: string) {
  return db
    .select({ id: players.id, firstName: players.firstName, lastName: players.lastName, email: players.email })
    .from(players)
    .where(
      and(
        eq(players.pool, pool),
        sql`lower(${players.firstName}) = ${p.firstName.toLowerCase()}`,
        sql`lower(${players.lastName}) = ${p.lastName.toLowerCase()}`,
        p.email ? or(eq(players.email, p.email), eq(players.email, '')) : undefined,
        exceptId ? ne(players.id, exceptId) : undefined,
      ),
    )
    .limit(5)
}

/**
 * A player added by hand (source admin), in the pool chosen. A player with the same name (and email, when one is
 * given) already in the pool is refused with 409 `duplicate` and their ids, unless `force` says it's someone else.
 */
export async function createPlayer(db: AppDb, actor: Editor, input: PlayerInput & { pool?: unknown; force?: unknown }, now = new Date()) {
  if (!(playerPools as readonly unknown[]).includes(input.pool)) throw invalid('Competition or training player?')
  const pool = input.pool as PlayerPool
  const patch = parsePlayerFields(input, pool, true, now)
  if (input.force !== true) {
    const dupes = await sameNamed(db, pool, { firstName: patch.firstName!, lastName: patch.lastName!, email: patch.email ?? '' })
    if (dupes.length > 0)
      throw new HttpError(
        409,
        'duplicate',
        'There’s already a player with that name. Open them, or add this one anyway if it’s someone else.',
        {
          duplicates: dupes,
        },
      )
  }
  const id = crypto.randomUUID()
  const at = now.toISOString()
  await runBatch(db, [
    db.insert(players).values({
      id,
      pool,
      firstName: patch.firstName!,
      lastName: patch.lastName!,
      email: patch.email ?? '',
      ...patch,
      source: 'admin',
      createdAt: at,
      updatedAt: at,
      updatedBy: actor.id,
    }),
    audit(db, actor, 'player.create', { type: 'player', id }, null, { pool, fields: Object.keys(patch) }, at),
  ])
  return getPlayer(db, id)
}

/**
 * Saves edits. With `baseUpdatedAt`, refuses (409) if someone saved since. Audited as player.update with the
 * names of the fields that changed, never their values.
 */
export async function updatePlayer(
  db: AppDb,
  actor: Editor,
  id: string,
  input: PlayerInput & { baseUpdatedAt?: unknown },
  now = new Date(),
) {
  const current = await db.select().from(players).where(eq(players.id, id)).get()
  if (!current) throw notFound('player')
  if (typeof input.baseUpdatedAt === 'string' && input.baseUpdatedAt !== current.updatedAt)
    throw conflict('Someone else changed this player just now. Reload to see their changes.')
  const patch = parsePlayerFields(input, current.pool, false, now)
  const changed = (Object.keys(patch) as PlayerField[]).filter((k) => (patch[k] ?? null) !== (current[k] ?? null))
  if (changed.length === 0) return getPlayer(db, id)
  const at = now.toISOString()
  await runBatch(db, [
    db
      .update(players)
      .set({ ...patch, updatedAt: at, updatedBy: actor.id })
      .where(eq(players.id, id)),
    audit(db, actor, 'player.update', { type: 'player', id }, null, { fields: changed }, at),
  ])
  return getPlayer(db, id)
}

/** Retire (hidden from pickers, shown only in the Retired group) or un-retire. Audited. */
export async function setRetired(db: AppDb, actor: Editor, id: string, retired: boolean, now = new Date()) {
  const current = await db.select({ retiredAt: players.retiredAt }).from(players).where(eq(players.id, id)).get()
  if (!current) throw notFound('player')
  if (!!current.retiredAt === retired) return getPlayer(db, id)
  const at = now.toISOString()
  await runBatch(db, [
    db
      .update(players)
      .set({ retiredAt: retired ? at : null, updatedAt: at, updatedBy: actor.id })
      .where(eq(players.id, id)),
    audit(db, actor, 'player.update', { type: 'player', id }, { retiredAt: current.retiredAt }, { retiredAt: retired ? at : null }, at),
  ])
  return getPlayer(db, id)
}

// ── Merge ─────────────────────────────────────────────────────────────────────

const twoTeams = (clashes: { seasonId: string; seasonName: string; keepTeam: string; mergeTeam: string }[]) =>
  new HttpError(
    409,
    'two_teams',
    `They’re in different teams in ${clashes.map((c) => `${c.seasonName} (${c.keepTeam} and ${c.mergeTeam})`).join(', ')}. A player is in one team a season, so take one of them out of their team first, then merge.`,
    { seasons: clashes },
  )

/** Why a duplicate's live enrolment was cancelled in a merge (the kept player already has one for that target). */
export const MERGE_CANCEL_REASON = 'Duplicate player merged: the kept player already has this enrolment'

const CLOSED = [...closedRegistrationStatuses]

/**
 * Merges `mergeId` into `keepId` (two rows for one person, in the same pool), in one batch:
 * - the duplicate's live enrolments for a target the kept player already has a live enrolment for are cancelled
 *   (MERGE_CANCEL_REASON), not deleted, so payments keep their registration (the live unique index allows one);
 * - every registration, EOI membership and team captaincy moves to the kept player;
 * - roster spots: where both are in the same season and team, the duplicate's row goes (the kept one becomes
 *   captain if the duplicate was); the rest move. Both in one season but in different teams is refused (409
 *   `two_teams`, naming the season and teams): one player plays for one team a season, so take one of them out first;
 * - with `fillBlanks` (default on), the kept player's empty details are filled from the duplicate's, and notes are
 *   joined;
 * - the duplicate is deleted, and the merge audited (in the same batch) on the kept player with the duplicate's id,
 *   initials, source and created date, the names of the fields filled and how many rows moved.
 */
export async function mergePlayers(
  db: AppDb,
  actor: Editor,
  keepId: string,
  input: { mergeId?: unknown; fillBlanks?: unknown },
  now = new Date(),
) {
  const mergeId = input.mergeId
  if (typeof mergeId !== 'string' || !/^[\w-]{1,64}$/.test(mergeId)) throw invalid('Pick the duplicate to merge in.')
  if (mergeId === keepId) throw invalid('Pick a different player: that’s the same one.')
  const both = await db
    .select()
    .from(players)
    .where(inArray(players.id, [keepId, mergeId]))
  const keep = both.find((p) => p.id === keepId)
  const dupe = both.find((p) => p.id === mergeId)
  if (!keep) throw notFound('player')
  if (!dupe) throw notFound('player to merge in')
  if (keep.pool !== dupe.pool) throw invalid('Competition and training players are kept apart, so they can’t be merged.')
  // One team per season: both in one season but different teams can't become one player.
  const spots = await db
    .select({
      playerId: seasonTeamPlayers.playerId,
      seasonId: seasonTeamPlayers.seasonId,
      teamId: seasonTeamPlayers.teamId,
      seasonName: seasons.name,
      teamName: teams.name,
    })
    .from(seasonTeamPlayers)
    .innerJoin(seasons, eq(seasons.id, seasonTeamPlayers.seasonId))
    .innerJoin(teams, eq(teams.id, seasonTeamPlayers.teamId))
    .where(inArray(seasonTeamPlayers.playerId, [keepId, mergeId]))
    .all()
  const clashes = spots.flatMap((k) =>
    k.playerId !== keepId
      ? []
      : spots
          .filter((d) => d.playerId === mergeId && d.seasonId === k.seasonId && d.teamId !== k.teamId)
          .map((d) => ({ seasonId: k.seasonId, seasonName: k.seasonName, keepTeam: k.teamName, mergeTeam: d.teamName })),
  )
  if (clashes.length) throw twoTeams(clashes)
  const at = now.toISOString()
  const touch = { updatedAt: at, updatedBy: actor.id }

  const fill: Partial<Player> = {}
  if (input.fillBlanks !== false) {
    for (const k of PLAYER_FIELDS) {
      if (k === 'notes' || k === 'firstName' || k === 'lastName') continue
      const kv = keep[k]
      const dv = dupe[k]
      if ((kv === null || kv === '') && dv !== null && dv !== '') (fill as Record<string, unknown>)[k] = dv
    }
    if (dupe.notes && dupe.notes !== keep.notes)
      fill.notes = keep.notes ? `${keep.notes}\n\n${dupe.notes}`.slice(0, LIMITS.notes) : dupe.notes
  }

  const liveDupe = and(eq(registrations.playerId, mergeId), notInArray(registrations.status, CLOSED))
  const liveClash = sql`exists (select 1 from registrations kr where kr.player_id = ${keepId} and kr.product_id = ${registrations.productId} and kr.status not in ('cancelled', 'expired', 'refunded'))`
  const sameTeam = (other: string) =>
    sql`exists (select 1 from season_team_players ks where ks.player_id = ${other} and ks.season_id = ${seasonTeamPlayers.seasonId} and ks.team_id = ${seasonTeamPlayers.teamId})`
  // The audit row goes first in the batch, so its counts are what the statements below then move (same
  // transaction). Privacy (docs/admin.md §3.16): the duplicate's id, initials, source and created date, no name.
  const initials = `${dupe.firstName.slice(0, 1)}. ${dupe.lastName.slice(0, 1)}.`.toUpperCase()
  const before = { merged: { id: dupe.id, initials, source: dupe.source, createdAt: dupe.createdAt } }
  const counted = sql`json_object(
      'registrationsMoved', (select count(*) from registrations where player_id = ${mergeId}),
      'registrationsCancelled', (select count(*) from registrations where player_id = ${mergeId} and status not in ('cancelled', 'expired', 'refunded')
        and exists (select 1 from registrations kr where kr.player_id = ${keepId} and kr.product_id = registrations.product_id and kr.status not in ('cancelled', 'expired', 'refunded'))),
      'interestsMoved', (select count(*) from interest_members where player_id = ${mergeId}),
      'captaincies', (select count(*) from groups where captain_player_id = ${mergeId}),
      'rosterDuplicatesDropped', (select count(*) from season_team_players d where d.player_id = ${mergeId}
        and exists (select 1 from season_team_players ks where ks.player_id = ${keepId} and ks.season_id = d.season_id and ks.team_id = d.team_id)),
      'rostersMoved', (select count(*) from season_team_players d where d.player_id = ${mergeId}
        and not exists (select 1 from season_team_players ks where ks.player_id = ${keepId} and ks.season_id = d.season_id and ks.team_id = d.team_id)),
      'filled', json(${JSON.stringify(Object.keys(fill))}))`
  const auditRow = db
    .insert(auditLog)
    .select(
      sql`select ${crypto.randomUUID()}, ${at}, ${actor.id}, 'player.merge', 'player', ${keepId}, ${JSON.stringify(before)}, ${counted}, ${actor.ip ?? null} where true`,
    )
  let results: unknown[][]
  try {
    results = (await runBatch(db, [
      auditRow,
      // 1. Collisions on the live unique index: cancel the duplicate's.
      db
        .update(registrations)
        .set({
          status: 'cancelled',
          cancelledAt: at,
          cancelReason: MERGE_CANCEL_REASON,
          waitlistPosition: null,
          offerExpiresAt: null,
          updatedAt: at,
          updatedBy: actor.id,
        })
        .where(and(liveDupe, liveClash))
        .returning({ id: registrations.id }),
      db
        .update(registrations)
        .set({ playerId: keepId, updatedAt: at })
        .where(eq(registrations.playerId, mergeId))
        .returning({ id: registrations.id }),
      db
        .update(interestMembers)
        .set({ playerId: keepId, updatedAt: at })
        .where(eq(interestMembers.playerId, mergeId))
        .returning({ id: interestMembers.id }),
      db
        .update(groups)
        .set({ captainPlayerId: keepId, updatedAt: at })
        .where(eq(groups.captainPlayerId, mergeId))
        .returning({ id: groups.id }),
      // 2. Rosters: same season and team → the kept row stays (captain if either was), the duplicate's goes.
      db
        .update(seasonTeamPlayers)
        .set({ role: 'captain', ...touch })
        .where(
          and(
            eq(seasonTeamPlayers.playerId, keepId),
            sql`exists (select 1 from season_team_players ks where ks.player_id = ${mergeId} and ks.season_id = ${seasonTeamPlayers.seasonId} and ks.team_id = ${seasonTeamPlayers.teamId} and ks.role = 'captain')`,
          ),
        ),
      db
        .delete(seasonTeamPlayers)
        .where(and(eq(seasonTeamPlayers.playerId, mergeId), sameTeam(keepId)))
        .returning({ seasonId: seasonTeamPlayers.seasonId }),
      db
        .update(seasonTeamPlayers)
        .set({ playerId: keepId, ...touch })
        .where(eq(seasonTeamPlayers.playerId, mergeId))
        .returning({ seasonId: seasonTeamPlayers.seasonId }),
      // 3. The kept player's details, then the duplicate goes.
      db
        .update(players)
        .set({ ...fill, ...touch })
        .where(eq(players.id, keepId)),
      db.delete(players).where(eq(players.id, mergeId)),
    ])) as unknown as unknown[][]
  } catch (e) {
    // Someone put one of them in another team of a shared season meanwhile (the one-team-per-season index).
    if (isUniqueFailure(e, 'season_team_players')) throw conflict('Their rosters changed while merging. Reload and try again.')
    throw e
  }
  const n = (i: number) => (results[i + 1] as unknown[]).length
  const summary = {
    registrationsMoved: n(1),
    registrationsCancelled: n(0),
    interestsMoved: n(2),
    captaincies: n(3),
    rostersMoved: n(6),
    rosterDuplicatesDropped: n(5),
    filled: Object.keys(fill),
  }
  return { ...(await getPlayer(db, keepId)), merge: summary }
}

// ── Delete ────────────────────────────────────────────────────────────────────

/** Deletes a player with no history; otherwise 409 `in_use` with what references them (merge or retire instead). */
export async function deletePlayer(db: AppDb, actor: Editor, id: string, now = new Date()) {
  const [rows, refs] = (await runBatch(db, [
    db.select({ id: players.id, pool: players.pool, source: players.source }).from(players).where(eq(players.id, id)),
    db
      .select({
        registrations: sql<number>`(select count(*) from registrations where player_id = ${id})`.as('n_regs'),
        interests: sql<number>`(select count(*) from interest_members where player_id = ${id})`.as('n_eois'),
        rosters: sql<number>`(select count(*) from season_team_players where player_id = ${id})`.as('n_rosters'),
        captainOf: sql<number>`(select count(*) from groups where captain_player_id = ${id})`.as('n_captain'),
      })
      .from(sql`(select 1)`),
  ])) as unknown as [
    { id: string; pool: PlayerPool; source: string | null }[],
    { registrations: number; interests: number; rosters: number; captainOf: number }[],
  ]
  const p = rows[0]
  if (!p) throw notFound('player')
  const r = refs[0]!
  const used = {
    registrations: Number(r.registrations),
    interests: Number(r.interests),
    rosters: Number(r.rosters),
    captainOf: Number(r.captainOf),
  }
  if (used.registrations + used.interests + used.rosters + used.captainOf > 0) {
    const parts = [
      used.registrations && `${used.registrations} enrolment${used.registrations === 1 ? '' : 's'}`,
      used.interests && `${used.interests} expression${used.interests === 1 ? '' : 's'} of interest`,
      used.rosters && `${used.rosters} season roster${used.rosters === 1 ? '' : 's'}`,
      used.captainOf && `captain of ${used.captainOf} team entr${used.captainOf === 1 ? 'y' : 'ies'}`,
    ].filter(Boolean)
    throw new HttpError(
      409,
      'in_use',
      `This player has history (${parts.join(', ')}), so they can’t be deleted. Retire them, or merge them into another record.`,
      {
        references: used,
      },
    )
  }
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(players).where(eq(players.id, id)),
    audit(db, actor, 'player.delete', { type: 'player', id }, { pool: p.pool, source: p.source }, null, at),
  ])
  return { deleted: true }
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export type CsvPlayer = Pick<
  Player,
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'phone'
  | 'gender'
  | 'birthYear'
  | 'suburb'
  | 'vnswNumber'
  | 'guardianName'
  | 'guardianEmail'
  | 'guardianPhone'
  | 'emergencyContact'
  | 'notes'
  | 'source'
  | 'retiredAt'
  | 'createdAt'
> & { group?: PlayerGroup | null; lastSpot?: RosterSpot | null }

/** Pure (tested without a database). Competition rows add the group and last team. Spreadsheet-safe (csvCell). */
export function playersCsv(pool: PlayerPool, rows: readonly CsvPlayer[]): string {
  const comp = pool === 'competition'
  const header = [
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
    ...(comp ? ['Group', 'Last team', 'Last season'] : []),
    'Notes',
    'Source',
    'Retired',
    'Added (UTC)',
  ]
  return toCsv([
    header,
    ...rows.map((p) => [
      p.firstName,
      p.lastName,
      p.email,
      p.phone ?? '',
      p.gender ?? '',
      p.birthYear ?? '',
      p.suburb ?? '',
      p.vnswNumber ?? '',
      p.guardianName ?? '',
      p.guardianEmail ?? '',
      p.guardianPhone ?? '',
      p.emergencyContact ?? '',
      ...(comp ? [p.group ? PLAYER_GROUP_LABELS[p.group] : '', p.lastSpot?.teamName ?? '', p.lastSpot?.seasonName ?? ''] : []),
      p.notes ?? '',
      p.source ?? '',
      p.retiredAt ? p.retiredAt.slice(0, 10) : '',
      p.createdAt,
    ]),
  ])
}

/**
 * A pool's players matching the list's filters (every page, at most EXPORT_LIMIT, in name order unless sorted
 * otherwise), as CSV. Competition rows add the group and last team (two queries: the players with their group, and
 * each one's latest spot). `truncated` says the list was longer; the filename says so too. Audited as player.export.
 */
export async function exportPlayers(db: AppDb, actor: Editor, q: PlayerQuery, now = new Date()) {
  let rows: CsvPlayer[]
  let more: boolean
  if (q.pool === 'competition') {
    const ctx = await groupContext(db, { leagueId: q.leagueId, today: sydneyDate(now) })
    const found = await db
      .select({ p: players, group: sql<PlayerGroup>`${ctx.groupSql}`.as('grp') })
      .from(players)
      .where(competitionWhere(q, ctx.groupSql, true))
      .orderBy(...orderOf(q.sort))
      .limit(EXPORT_LIMIT + 1)
      .all()
    more = found.length > EXPORT_LIMIT
    const list = found.slice(0, EXPORT_LIMIT)
    // Every latest spot (one window over the rosters); only these players' are kept.
    const spots = list.length ? await latestSpots(db, { preferLeagueId: q.leagueId }) : []
    const spotBy = new Map(spots.map((s) => [s.playerId, s]))
    rows = list.map(({ p, group }) => {
      const s = spotBy.get(p.id)
      return { ...p, group, lastSpot: s ? spotOnly(s) : null }
    })
  } else {
    const found = await db
      .select()
      .from(players)
      .where(trainingWhere(q))
      .orderBy(...orderOf(q.sort))
      .limit(EXPORT_LIMIT + 1)
    more = found.length > EXPORT_LIMIT
    rows = found.slice(0, EXPORT_LIMIT)
  }
  await audit(
    db,
    actor,
    'player.export',
    { type: 'player', id: q.pool },
    null,
    { pool: q.pool, group: q.group, leagueId: q.leagueId, programmeId: q.programmeId, rows: rows.length, truncated: more },
    now.toISOString(),
  )
  const day = now.toISOString().slice(0, 10)
  return {
    csv: playersCsv(q.pool, rows),
    filename: `players-${q.pool}-${day}${more ? `-first-${EXPORT_LIMIT}` : ''}.csv`,
    truncated: more,
  }
}
