import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { toCsv } from '../../lib/enrolment/csv'
import { isEmail } from '../../lib/enrolment/validate'
import { leagueWindow } from '../../lib/players/groups'
import { runBatch, type AppDb } from '../db'
import {
  genders,
  interestMembers,
  interestProgrammes,
  interests,
  leagues,
  openInterestStatuses,
  players,
  seasons,
  seasonTeamPlayers,
  seasonTeams,
  teams,
  type Gender,
  type MemberDetails,
  type NewPlayer,
  type RosterRole,
  type SeasonStatus,
} from '../db/schema'
import { audit, notFound, type Editor } from '../content/common'
import { HttpError } from '../http'
import { chunk, emptyDetails, matchPeople, newPlayerRow, rowsPerInsert } from '../players/core'
import { competitionDirectory, type Directory } from '../players/directory'
import { id as idOf, invalid, isId, text } from './input'

// Season rosters (docs/interest.md "Season rosters", docs/api/rosters.md): who plays in each team each season.
// Admin-only (personal data). Roster changes save straight away and never touch seasons.updated_at, so they don't
// clash with the season's working copy and Save; they work on draft, published and archived seasons (they don't
// change the draw or the public site). Team list changes (and the rosters they bring or take away) go through the
// season's Save: rosterCopyStatements() below, called from setSeasonTeams().
//
// Rules:
//  - A player is in at most one team per season. Adding someone who's in another team is a 409 already_in_team
//    unless the request says `move: true`.
//  - At most one captain per team.
//  - Placing a player from an individual EOI marks that EOI's programme row for this league `placed` (with the
//    season and team) in the same batch; taking them off reverts it to `contacted`.
//  - Every change is one batch, audited as roster.update, within D1's 50 queries and 100 parameters (rows go in as
//    one JSON parameter through INSERT … SELECT FROM json_each).

// ── Types ─────────────────────────────────────────────────────────────────────

export type RosterPlayer = {
  playerId: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  gender: Gender | null
  retired: boolean
  role: RosterRole
  sort: number
  /** Where they came from: an EOI, or the season they were copied from. */
  interest: { id: string; reference: string } | null
  fromSeason: { id: string; name: string } | null
  /** From their EOI's answers, when the form asked. */
  level: string | null
  position: string | null
}

export type TeamRoster = { teamId: string; teamName: string; withdrawn: boolean; players: RosterPlayer[] }

export type RosterView = {
  seasonId: string
  leagueId: string
  status: SeasonStatus
  rosters: TeamRoster[]
  /** Players on a roster this season. */
  placed: number
  /** Open individual EOIs for this league whose player isn't in a team this season yet. */
  openInterest: number
}

/** A player on a roster that would be copied (a returning team's last roster, or a team EOI's members). */
export type PreviewPlayer = { playerId: string; name: string; role: RosterRole; retired: boolean }

export type SourceTeam = {
  teamId: string
  teamName: string
  /** last: in last season; league: an earlier season of this league; other: only other leagues. */
  group: 'last' | 'league' | 'other'
  /** The season its roster would be copied from (its latest in this league, else anywhere). */
  from: { seasonId: string; seasonName: string; startDate: string; leagueCode: string; withdrawn: boolean }
  /** Seasons it has played (any league), for "played 6 seasons". */
  seasons: number
  players: PreviewPlayer[]
}

export type TeamInterest = {
  interestId: string
  reference: string
  teamName: string
  createdAt: string
  status: string
  captain: { playerId: string | null; name: string; email: string | null; phone: string | null } | null
  members: PreviewPlayer[]
  /** An existing team with the same name (case-insensitive). */
  matchedTeam: { id: string; name: string } | null
  level: string | null
}

export type RosterSources = {
  lastSeason: { id: string; name: string } | null
  teams: SourceTeam[]
  interests: TeamInterest[]
}

export type RosterFrom = { seasonId: string } | { interestId: string }

export const MAX_ADD = 40
export const MAX_NEW_PLAYERS = 20

// ── Small helpers ─────────────────────────────────────────────────────────────

const inJson = (column: AnySQLiteColumn | SQL, values: readonly string[]) =>
  sql`${column} in (select value from json_each(${JSON.stringify(values)}))`

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const levelOf = (answers: unknown) => {
  const a = (answers ?? {}) as Record<string, unknown>
  return str(a.playing_level) ?? str(a.skill_level)
}
const positionOf = (answers: unknown) => str(((answers ?? {}) as Record<string, unknown>).position)
const nameOf = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim()
const newestFirst = (a: { startDate: string }, b: { startDate: string }) =>
  a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0

type SeasonRow = { id: string; leagueId: string; status: SeasonStatus; startDate: string; name: string; slug: string }

async function seasonRow(db: AppDb, seasonId: string): Promise<SeasonRow> {
  idOf(seasonId, 'Season')
  const s = await db
    .select({
      id: seasons.id,
      leagueId: seasons.leagueId,
      status: seasons.status,
      startDate: seasons.startDate,
      name: seasons.name,
      slug: seasons.slug,
    })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .get()
  if (!s) throw notFound('season')
  return s
}

/**
 * Rows go into season_team_players as one JSON parameter: INSERT … SELECT FROM json_each, through the insert
 * builder (drizzle's D1 batch can't bind a raw statement). The select lists every column in schema order.
 */
type RosterInsert = {
  teamId: string
  playerId: string
  role: RosterRole
  sort: number
  interestId: string | null
  fromSeasonId: string | null
}
/** Rows per statement: keeps each statement's SQL text well under D1's 100 KB. */
const ROWS_PER_JSON_INSERT = 150

export function rosterInsertStatements(db: AppDb, seasonId: string, rows: readonly RosterInsert[], at: string, actorId: string) {
  return chunk(rows, ROWS_PER_JSON_INSERT).map((part) =>
    db.insert(seasonTeamPlayers).select(
      sql`select ${seasonId}, json_extract(j.value, '$.t'), json_extract(j.value, '$.p'), json_extract(j.value, '$.r'),
          json_extract(j.value, '$.s'), json_extract(j.value, '$.i'), json_extract(j.value, '$.f'), ${at}, ${at}, ${actorId}
          from json_each(${JSON.stringify(part.map((r) => ({ t: r.teamId, p: r.playerId, r: r.role, s: r.sort, i: r.interestId, f: r.fromSeasonId })))}) as j
          where true`,
    ),
  )
}

/**
 * Marks individual EOIs placed: for each { playerId, teamId }, the player's open EOIs for this league (or ones
 * already placed in this season, when they move team) become placed in that team. One statement.
 */
export function placeStatement(
  db: AppDb,
  ctx: { seasonId: string; leagueId: string; at: string; actorId: string },
  placements: readonly { playerId: string; teamId: string }[],
) {
  const map = JSON.stringify(placements.map((p) => ({ p: p.playerId, t: p.teamId })))
  const teamOf = sql`(select json_extract(j.value, '$.t') from json_each(${map}) as j
    join ${interestMembers} as m on m.player_id = json_extract(j.value, '$.p')
    where m.interest_id = ${interestProgrammes.interestId} limit 1)`
  return db
    .update(interestProgrammes)
    .set({ status: 'placed', seasonId: ctx.seasonId, teamId: sql`${teamOf}`, updatedAt: ctx.at, updatedBy: ctx.actorId })
    .where(
      and(
        eq(interestProgrammes.programmeId, ctx.leagueId),
        sql`(${inArray(interestProgrammes.status, [...openInterestStatuses])} or (${interestProgrammes.status} = 'placed' and ${interestProgrammes.seasonId} = ${ctx.seasonId}))`,
        sql`${interestProgrammes.interestId} in (select ${interests.id} from ${interests} where ${interests.kind} = 'player')`,
        sql`${teamOf} is not null`,
      ),
    )
}

/** Puts individual EOIs placed in this season (in `teamIds`, or any team) for these players back to contacted. */
export function unplaceStatement(
  db: AppDb,
  ctx: { seasonId: string; leagueId: string; at: string; actorId: string },
  where: { playerIds?: readonly string[]; teamIds?: readonly string[]; kinds?: 'player' | 'any' },
) {
  return db
    .update(interestProgrammes)
    .set({ status: 'contacted', seasonId: null, teamId: null, updatedAt: ctx.at, updatedBy: ctx.actorId })
    .where(
      and(
        eq(interestProgrammes.programmeId, ctx.leagueId),
        eq(interestProgrammes.status, 'placed'),
        eq(interestProgrammes.seasonId, ctx.seasonId),
        ...(where.teamIds ? [inJson(interestProgrammes.teamId, where.teamIds)] : []),
        ...(where.kinds === 'any'
          ? []
          : [sql`${interestProgrammes.interestId} in (select ${interests.id} from ${interests} where ${interests.kind} = 'player')`]),
        ...(where.playerIds
          ? [
              sql`${interestProgrammes.interestId} in (select ${interestMembers.interestId} from ${interestMembers} where ${inJson(interestMembers.playerId, where.playerIds)})`,
            ]
          : []),
      ),
    )
}

/** Each player's newest open individual EOI for the league (the roster row's interest_id). One query. */
async function openPlayerInterests(db: AppDb, leagueId: string, playerIds: readonly string[]): Promise<Map<string, string>> {
  if (playerIds.length === 0) return new Map()
  const rows = await db
    .select({ playerId: interestMembers.playerId, interestId: interests.id, createdAt: interestProgrammes.createdAt })
    .from(interestProgrammes)
    .innerJoin(interests, eq(interests.id, interestProgrammes.interestId))
    .innerJoin(interestMembers, eq(interestMembers.interestId, interests.id))
    .where(
      and(
        eq(interestProgrammes.programmeId, leagueId),
        inArray(interestProgrammes.status, [...openInterestStatuses]),
        eq(interests.kind, 'player'),
        isNull(interests.archivedAt),
        inJson(interestMembers.playerId, playerIds),
      ),
    )
    .orderBy(asc(interestProgrammes.createdAt))
    .all()
  const out = new Map<string, string>()
  for (const r of rows) if (r.playerId) out.set(r.playerId, r.interestId) // newest wins
  return out
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** The season's rosters, team by team in the season's order, and its counts. One batch of three queries. */
export async function getRosters(db: AppDb, seasonId: string): Promise<RosterView> {
  const s = await seasonRow(db, seasonId)
  return readRosters(db, s)
}

async function readRosters(db: AppDb, s: Pick<SeasonRow, 'id' | 'leagueId' | 'status'>): Promise<RosterView> {
  const inSeason = db.select({ id: seasonTeamPlayers.playerId }).from(seasonTeamPlayers).where(eq(seasonTeamPlayers.seasonId, s.id))
  const [teamRows, rows, open] = (await runBatch(db, [
    db
      .select({ teamId: seasonTeams.teamId, teamName: teams.name, withdrawnAt: seasonTeams.withdrawnAt })
      .from(seasonTeams)
      .innerJoin(teams, eq(teams.id, seasonTeams.teamId))
      .where(eq(seasonTeams.seasonId, s.id))
      .orderBy(asc(seasonTeams.sort), asc(teams.name)),
    // Joined columns are named apart (D1's batch keys rows by column name).
    db
      .select({
        teamId: seasonTeamPlayers.teamId,
        playerId: seasonTeamPlayers.playerId,
        role: seasonTeamPlayers.role,
        sort: seasonTeamPlayers.sort,
        interestId: seasonTeamPlayers.interestId,
        fromSeasonId: seasonTeamPlayers.fromSeasonId,
        firstName: players.firstName,
        lastName: players.lastName,
        email: players.email,
        phone: players.phone,
        gender: players.gender,
        retiredAt: players.retiredAt,
        reference: interests.reference,
        answers: interests.answers,
        fromSeasonName: sql<string | null>`(select s2.name from ${seasons} as s2 where s2.id = ${seasonTeamPlayers.fromSeasonId})`.as(
          'from_season_name',
        ),
      })
      .from(seasonTeamPlayers)
      .innerJoin(players, eq(players.id, seasonTeamPlayers.playerId))
      .leftJoin(interests, eq(interests.id, seasonTeamPlayers.interestId))
      .where(eq(seasonTeamPlayers.seasonId, s.id))
      .orderBy(asc(seasonTeamPlayers.sort), asc(players.firstName), asc(players.lastName)),
    db
      .select({ n: sql<number>`count(distinct ${interests.id})`.as('n') })
      .from(interestProgrammes)
      .innerJoin(interests, eq(interests.id, interestProgrammes.interestId))
      .innerJoin(interestMembers, eq(interestMembers.interestId, interests.id))
      .where(
        and(
          eq(interestProgrammes.programmeId, s.leagueId),
          inArray(interestProgrammes.status, [...openInterestStatuses]),
          eq(interests.kind, 'player'),
          isNull(interests.archivedAt),
          sql`${interestMembers.playerId} not in ${inSeason}`,
        ),
      ),
  ])) as unknown as [
    { teamId: string; teamName: string; withdrawnAt: string | null }[],
    {
      teamId: string
      playerId: string
      role: RosterRole
      sort: number
      interestId: string | null
      fromSeasonId: string | null
      firstName: string
      lastName: string
      email: string
      phone: string | null
      gender: Gender | null
      retiredAt: string | null
      reference: string | null
      answers: unknown
      fromSeasonName: string | null
    }[],
    { n: number }[],
  ]
  const byTeam = new Map<string, RosterPlayer[]>()
  for (const r of rows) {
    const list = byTeam.get(r.teamId) ?? []
    // The batch hands JSON columns back as text when they come through a join.
    const answers = typeof r.answers === 'string' ? safeJson(r.answers) : r.answers
    list.push({
      playerId: r.playerId,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      phone: r.phone,
      gender: r.gender,
      retired: !!r.retiredAt,
      role: r.role,
      sort: r.sort,
      interest: r.interestId && r.reference ? { id: r.interestId, reference: r.reference } : null,
      fromSeason: r.fromSeasonId && r.fromSeasonName ? { id: r.fromSeasonId, name: r.fromSeasonName } : null,
      level: levelOf(answers),
      position: positionOf(answers),
    })
    byTeam.set(r.teamId, list)
  }
  return {
    seasonId: s.id,
    leagueId: s.leagueId,
    status: s.status,
    rosters: teamRows.map((t) => ({
      teamId: t.teamId,
      teamName: t.teamName,
      withdrawn: !!t.withdrawnAt,
      players: byTeam.get(t.teamId) ?? [],
    })),
    placed: rows.length,
    openInterest: Number(open[0]?.n ?? 0),
  }
}

/** The player picker's list: the competition directory for this season's league, as it stands for this season. */
export async function seasonPlayerDirectory(db: AppDb, seasonId: string, today: string): Promise<Directory> {
  const s = await seasonRow(db, seasonId)
  return competitionDirectory(db, { leagueId: s.leagueId, seasonId: s.id, today })
}

const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * Where the season's teams can come from (the season builder's "Add teams"): every team that has played, grouped as
 * last season's, this league's earlier ones and other leagues' (newest first, each with the roster that would be
 * copied), and the open team EOIs for this league. Two round trips (six queries).
 */
export async function rosterSources(db: AppDb, seasonId: string): Promise<RosterSources> {
  const s = await seasonRow(db, seasonId)
  const [seasonRows, memberRows, eoiRows, memberDetails, teamRows] = (await runBatch(db, [
    db
      .select({ id: seasons.id, name: seasons.name, startDate: seasons.startDate, leagueId: seasons.leagueId, leagueCode: leagues.code })
      .from(seasons)
      .innerJoin(leagues, eq(leagues.id, seasons.leagueId)),
    db
      .select({ teamId: seasonTeams.teamId, seasonId: seasonTeams.seasonId, withdrawnAt: seasonTeams.withdrawnAt, teamName: teams.name })
      .from(seasonTeams)
      .innerJoin(teams, eq(teams.id, seasonTeams.teamId)),
    db
      .select({
        interestId: interests.id,
        reference: interests.reference,
        teamName: interests.teamName,
        answers: interests.answers,
        status: interestProgrammes.status,
        createdAt: interestProgrammes.createdAt,
      })
      .from(interestProgrammes)
      .innerJoin(interests, eq(interests.id, interestProgrammes.interestId))
      .where(
        and(
          eq(interestProgrammes.programmeId, s.leagueId),
          inArray(interestProgrammes.status, [...openInterestStatuses]),
          eq(interests.kind, 'team'),
          isNull(interests.archivedAt),
        ),
      )
      .orderBy(sql`${interestProgrammes.createdAt} desc`),
    db
      .select({
        interestId: interestMembers.interestId,
        playerId: interestMembers.playerId,
        role: interestMembers.role,
        sort: interestMembers.sort,
        details: interestMembers.details,
        firstName: players.firstName,
        lastName: players.lastName,
        retiredAt: players.retiredAt,
      })
      .from(interestMembers)
      .leftJoin(players, eq(players.id, interestMembers.playerId))
      .where(
        sql`${interestMembers.interestId} in (select ${interestProgrammes.interestId} from ${interestProgrammes}
          join ${interests} on ${interests.id} = ${interestProgrammes.interestId}
          where ${interestProgrammes.programmeId} = ${s.leagueId} and ${interestProgrammes.status} in ('new', 'contacted')
          and ${interests.kind} = 'team' and ${interests.archivedAt} is null)`,
      )
      .orderBy(asc(interestMembers.sort)),
    db.select({ id: teams.id, name: teams.name }).from(teams),
  ])) as unknown as [
    { id: string; name: string; startDate: string; leagueId: string; leagueCode: string }[],
    { teamId: string; seasonId: string; withdrawnAt: string | null; teamName: string }[],
    { interestId: string; reference: string; teamName: string | null; answers: unknown; status: string; createdAt: string }[],
    {
      interestId: string
      playerId: string | null
      role: RosterRole
      sort: number
      details: unknown
      firstName: string | null
      lastName: string | null
      retiredAt: string | null
    }[],
    { id: string; name: string }[],
  ]

  const seasonById = new Map(seasonRows.map((x) => [x.id, x]))
  const { lastSeasonId } = leagueWindow(
    seasonRows.filter((x) => x.leagueId === s.leagueId),
    { targetId: s.id, today: s.startDate },
  )
  const lastSeason = lastSeasonId ? (seasonById.get(lastSeasonId) ?? null) : null

  // Each team's seasons other than this one, newest first.
  const byTeam = new Map<string, { teamName: string; spots: { season: (typeof seasonRows)[number]; withdrawn: boolean }[] }>()
  for (const m of memberRows) {
    if (m.seasonId === s.id) continue
    const season = seasonById.get(m.seasonId)
    if (!season) continue
    const t = byTeam.get(m.teamId) ?? { teamName: m.teamName, spots: [] }
    t.spots.push({ season, withdrawn: !!m.withdrawnAt })
    byTeam.set(m.teamId, t)
  }
  const sources: Omit<SourceTeam, 'players'>[] = []
  for (const [teamId, t] of byTeam) {
    const spots = t.spots.toSorted((a, b) => newestFirst(a.season, b.season))
    const inLeague = spots.filter((x) => x.season.leagueId === s.leagueId)
    const last = lastSeasonId ? inLeague.find((x) => x.season.id === lastSeasonId) : undefined
    const from = last ?? inLeague[0] ?? spots[0]!
    sources.push({
      teamId,
      teamName: t.teamName,
      group: last ? 'last' : inLeague.length ? 'league' : 'other',
      from: {
        seasonId: from.season.id,
        seasonName: from.season.name,
        startDate: from.season.startDate,
        leagueCode: from.season.leagueCode,
        withdrawn: from.withdrawn,
      },
      seasons: spots.length,
    })
  }
  const groupRank = { last: 0, league: 1, other: 2 }
  sources.sort(
    (a, b) =>
      groupRank[a.group] - groupRank[b.group] ||
      newestFirst(a.from, b.from) ||
      a.teamName.localeCompare(b.teamName, 'en', { sensitivity: 'base' }),
  )

  // The rosters that would be copied: each source team's roster in its `from` season.
  const pairs = new Set(sources.map((x) => `${x.from.seasonId}|${x.teamId}`))
  const rosterRows = pairs.size
    ? await db
        .select({
          seasonId: seasonTeamPlayers.seasonId,
          teamId: seasonTeamPlayers.teamId,
          playerId: seasonTeamPlayers.playerId,
          role: seasonTeamPlayers.role,
          firstName: players.firstName,
          lastName: players.lastName,
          retiredAt: players.retiredAt,
        })
        .from(seasonTeamPlayers)
        .innerJoin(players, eq(players.id, seasonTeamPlayers.playerId))
        .where(
          and(
            inJson(seasonTeamPlayers.seasonId, [...new Set(sources.map((x) => x.from.seasonId))]),
            inJson(seasonTeamPlayers.teamId, [...new Set(sources.map((x) => x.teamId))]),
          ),
        )
        .orderBy(asc(seasonTeamPlayers.sort), asc(players.firstName))
        .all()
    : []
  const rosterOf = new Map<string, PreviewPlayer[]>()
  for (const r of rosterRows) {
    const key = `${r.seasonId}|${r.teamId}`
    if (!pairs.has(key)) continue
    const list = rosterOf.get(key) ?? []
    list.push({ playerId: r.playerId, name: nameOf(r), role: r.role, retired: !!r.retiredAt })
    rosterOf.set(key, list)
  }

  const teamByName = new Map(teamRows.map((t) => [t.name.trim().toLowerCase(), t]))
  const membersOf = new Map<string, typeof memberDetails>()
  for (const m of memberDetails) membersOf.set(m.interestId, [...(membersOf.get(m.interestId) ?? []), m])
  const teamInterests: TeamInterest[] = eoiRows.map((e) => {
    const members = membersOf.get(e.interestId) ?? []
    const first = members[0]
    const details = (d: unknown) => (typeof d === 'string' ? safeJson(d) : d) as Partial<MemberDetails> | null
    const shown = (m: (typeof members)[number]) => {
      const d = details(m.details)
      return m.firstName !== null
        ? nameOf({ firstName: m.firstName, lastName: m.lastName ?? '' })
        : nameOf({ firstName: d?.firstName ?? '?', lastName: d?.lastName ?? '' })
    }
    const answers = typeof e.answers === 'string' ? safeJson(e.answers) : e.answers
    const name = e.teamName?.trim() || 'Unnamed team'
    const matched = teamByName.get(name.toLowerCase())
    return {
      interestId: e.interestId,
      reference: e.reference,
      teamName: name,
      createdAt: e.createdAt,
      status: e.status,
      captain: first
        ? {
            playerId: first.playerId,
            name: shown(first),
            email: details(first.details)?.email ?? null,
            phone: details(first.details)?.phone ?? null,
          }
        : null,
      members: members
        .filter((m) => m.playerId)
        .map((m) => ({ playerId: m.playerId!, name: shown(m), role: m.role, retired: !!m.retiredAt })),
      matchedTeam: matched ? { id: matched.id, name: matched.name } : null,
      level: levelOf(answers),
    }
  })

  return {
    lastSeason: lastSeason ? { id: lastSeason.id, name: lastSeason.name } : null,
    teams: sources.map((x) => ({ ...x, players: rosterOf.get(`${x.from.seasonId}|${x.teamId}`) ?? [] })),
    interests: teamInterests,
  }
}

// ── Changes ───────────────────────────────────────────────────────────────────

export type RosterAction = 'add' | 'remove' | 'move' | 'replace' | 'captain' | 'order'
export type RosterChangeInput = {
  action?: unknown
  teamId?: unknown
  playerId?: unknown
  playerIds?: unknown
  newPlayers?: unknown
  toTeamId?: unknown
  withPlayerId?: unknown
  newPlayer?: unknown
  captain?: unknown
  move?: unknown
  /** add: the team EOI these players came from (its programme row for this league becomes placed in this team). */
  interestId?: unknown
}
export type RosterChangeResult = RosterView & {
  /** What happened, for the toast: "Added 3 players". */
  done: { action: RosterAction; added: number; created: number; moved: number }
}

/** Someone's already in another team this season. `players` says who and where, so the admin can offer "Move". */
const alreadyInTeam = (who: { playerId: string; name: string; teamId: string; teamName: string }[]) =>
  new HttpError(
    409,
    'already_in_team',
    who.length === 1
      ? `${who[0]!.name} is already in ${who[0]!.teamName} this season. Move them instead?`
      : `${who.length} of those players are already in other teams this season: ${who.map((w) => `${w.name} (${w.teamName})`).join(', ')}. Move them instead?`,
    { players: who },
  )

function parseNewPlayer(v: unknown, label: string): MemberDetails {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(`${label} must be an object.`)
  const o = v as Record<string, unknown>
  const firstName = text(o.firstName, `${label}: first name`, 80, { required: true })
  const lastName = text(o.lastName, `${label}: last name`, 80)
  const email = text(o.email, `${label}: email`, 254).toLowerCase()
  if (email && !isEmail(email)) throw invalid(`${label}: that email address doesn’t look right.`)
  const phone = text(o.phone, `${label}: phone`, 40)
  const gender = o.gender === undefined || o.gender === null || o.gender === '' ? null : o.gender
  if (gender !== null && !genders.includes(gender as Gender)) throw invalid(`${label}: pick a gender from the list.`)
  return { ...emptyDetails(firstName, lastName, email || null), phone: phone || null, gender: gender as Gender | null }
}

const idList = (v: unknown, label: string, max: number) => {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw invalid(`${label} must be a list of ids.`)
  if (v.length > max) throw invalid(`At most ${max} at a time.`)
  return [...new Set(v.map((x, i) => idOf(x, `${label} ${i + 1}`)))]
}

type Ctx = {
  season: SeasonRow
  teams: Map<string, string>
  rows: {
    teamId: string
    playerId: string
    role: RosterRole
    sort: number
    interestId: string | null
    fromSeasonId: string | null
    name: string
  }[]
}

async function loadCtx(db: AppDb, seasonId: string): Promise<Ctx> {
  const season = await seasonRow(db, seasonId)
  const [teamRows, rows] = (await runBatch(db, [
    db
      .select({ teamId: seasonTeams.teamId, teamName: teams.name })
      .from(seasonTeams)
      .innerJoin(teams, eq(teams.id, seasonTeams.teamId))
      .where(eq(seasonTeams.seasonId, seasonId)),
    db
      .select({
        teamId: seasonTeamPlayers.teamId,
        playerId: seasonTeamPlayers.playerId,
        role: seasonTeamPlayers.role,
        sort: seasonTeamPlayers.sort,
        interestId: seasonTeamPlayers.interestId,
        fromSeasonId: seasonTeamPlayers.fromSeasonId,
        firstName: players.firstName,
        lastName: players.lastName,
      })
      .from(seasonTeamPlayers)
      .innerJoin(players, eq(players.id, seasonTeamPlayers.playerId))
      .where(eq(seasonTeamPlayers.seasonId, seasonId)),
  ])) as unknown as [
    { teamId: string; teamName: string }[],
    {
      teamId: string
      playerId: string
      role: RosterRole
      sort: number
      interestId: string | null
      fromSeasonId: string | null
      firstName: string
      lastName: string
    }[],
  ]
  return {
    season,
    teams: new Map(teamRows.map((t) => [t.teamId, t.teamName])),
    rows: rows.map((r) => ({ ...r, name: nameOf(r) })),
  }
}

const teamIn = (ctx: Ctx, v: unknown, label = 'Team') => {
  const teamId = idOf(v, label)
  if (!ctx.teams.has(teamId)) throw new HttpError(409, 'team_not_in_season', 'That team isn’t in this season (save the team list first).')
  return teamId
}

/** Existing competition players by id (refusing training players and unknown ids), plus new ones to create. */
async function resolvePlayers(
  db: AppDb,
  ids: string[],
  fresh: MemberDetails[],
): Promise<{ list: { id: string; name: string; created: boolean }[]; newRows: (at: string, actorId: string) => NewPlayer[] }> {
  const found = ids.length
    ? await db
        .select({ id: players.id, pool: players.pool, firstName: players.firstName, lastName: players.lastName })
        .from(players)
        .where(inJson(players.id, ids))
        .all()
    : []
  for (const pid of ids) {
    const p = found.find((f) => f.id === pid)
    if (!p) throw invalid('One of those players doesn’t exist (they may have been deleted or merged).')
    if (p.pool !== 'competition') throw invalid(`${nameOf(p)} is a training player. Rosters only take competition players.`)
  }
  const matched = fresh.length ? await matchPeople(db, 'competition', fresh) : []
  const created: { id: string; d: MemberDetails }[] = []
  const freshList = fresh.map((d, i) => {
    const existing = matched[i]
    if (existing) return { id: existing, name: nameOf(d), created: false }
    const id = crypto.randomUUID()
    created.push({ id, d })
    return { id, name: nameOf(d), created: true }
  })
  return {
    list: [...ids.map((pid) => ({ id: pid, name: nameOf(found.find((f) => f.id === pid)!), created: false })), ...freshList],
    newRows: (at, actorId) => created.map((c) => newPlayerRow(c.id, 'competition', c.d, { source: 'admin', at, actorId })),
  }
}

/**
 * One roster change, saved straight away (docs/api/rosters.md):
 * - `add` { teamId, playerIds?, newPlayers?, move? }: existing competition players and/or new ones (created in the
 *   competition pool, or matched by email and name); someone already in this team is skipped.
 * - `remove` { teamId, playerId }
 * - `move` { teamId, playerId, toTeamId }: keeps captaincy only if the new team has no captain.
 * - `replace` { teamId, playerId, withPlayerId | newPlayer, move? }: the new player takes the old one's role and place.
 * - `captain` { teamId, playerId, captain }: one captain per team (the old one becomes a player).
 * - `order` { teamId, playerIds }: the team's whole roster in its new order.
 * `move: true` takes a player out of their other team this season first; without it that's 409 already_in_team.
 */
export async function changeRoster(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  input: RosterChangeInput,
  now = new Date(),
): Promise<RosterChangeResult> {
  const action = input.action as RosterAction
  if (!['add', 'remove', 'move', 'replace', 'captain', 'order'].includes(action)) throw invalid('Unknown roster action.')
  const ctx = await loadCtx(db, seasonId)
  const teamId = teamIn(ctx, input.teamId)
  const teamName = ctx.teams.get(teamId)!
  const at = now.toISOString()
  const base = { seasonId, leagueId: ctx.season.leagueId, at, actorId: actor.id }
  const mine = ctx.rows.filter((r) => r.teamId === teamId).toSorted((a, b) => a.sort - b.sort)
  const nextSort = mine.reduce((m, r) => Math.max(m, r.sort + 1), 0)
  const rowOf = (playerId: string) => ctx.rows.find((r) => r.playerId === playerId)
  const onTeam = (playerId: string) => {
    const r = ctx.rows.find((x) => x.playerId === playerId && x.teamId === teamId)
    if (!r)
      throw new HttpError(404, 'not_found', 'That player isn’t in this team (someone may have just changed it). Reload to see the roster.')
    return r
  }
  const where = (playerId: string, team = teamId) =>
    and(eq(seasonTeamPlayers.seasonId, seasonId), eq(seasonTeamPlayers.teamId, team), eq(seasonTeamPlayers.playerId, playerId))
  const items: Parameters<typeof runBatch>[1] = []
  const done = { action, added: 0, created: 0, moved: 0 }
  let detail: Record<string, unknown> = {}

  if (action === 'add' || action === 'replace') {
    const move = input.move === true
    const teamInterest =
      action === 'add' && input.interestId !== undefined && input.interestId !== null ? idOf(input.interestId, 'EOI') : null
    let ids: string[]
    let fresh: MemberDetails[]
    if (action === 'add') {
      ids = idList(input.playerIds, 'Player', MAX_ADD)
      if (input.newPlayers !== undefined && !Array.isArray(input.newPlayers)) throw invalid('newPlayers must be a list.')
      const np = (input.newPlayers as unknown[] | undefined) ?? []
      if (np.length > MAX_NEW_PLAYERS) throw invalid(`At most ${MAX_NEW_PLAYERS} new players at a time.`)
      fresh = np.map((p, i) => parseNewPlayer(p, `New player ${i + 1}`))
      if (ids.length + fresh.length === 0) throw invalid('Pick at least one player.')
    } else {
      onTeam(idOf(input.playerId, 'Player'))
      ids = input.withPlayerId !== undefined && input.withPlayerId !== null ? [idOf(input.withPlayerId, 'Replacement')] : []
      fresh = ids.length ? [] : [parseNewPlayer(input.newPlayer, 'The new player')]
    }
    const { list, newRows } = await resolvePlayers(db, ids, fresh)
    const out = action === 'replace' ? onTeam(input.playerId as string) : null
    if (out && list.some((p) => p.id === out.playerId)) throw invalid('Pick someone else to replace them with.')
    // De-duplicate (a new player matched someone also picked), skip people already in this team.
    const seen = new Set<string>()
    const adding = list.filter((p) => {
      if (seen.has(p.id)) return false
      seen.add(p.id)
      if (rowOf(p.id)?.teamId === teamId) {
        if (action === 'replace') throw invalid(`${p.name} is already in ${teamName}.`)
        return false
      }
      return true
    })
    const elsewhere = adding.flatMap((p) => {
      const r = rowOf(p.id)
      return r && r.teamId !== teamId ? [{ playerId: p.id, name: p.name, teamId: r.teamId, teamName: ctx.teams.get(r.teamId) ?? '?' }] : []
    })
    if (elsewhere.length && !move) throw alreadyInTeam(elsewhere)
    const eois = await openPlayerInterests(
      db,
      ctx.season.leagueId,
      adding.map((p) => p.id),
    )
    const rows: RosterInsert[] = adding.map((p, i) => {
      const prev = rowOf(p.id)
      return {
        teamId,
        playerId: p.id,
        role: out ? out.role : 'player',
        sort: out ? out.sort : nextSort + i,
        // A moved player keeps where they came from; otherwise their open EOI, if any.
        interestId: prev?.interestId ?? eois.get(p.id) ?? null,
        fromSeasonId: prev?.fromSeasonId ?? null,
      }
    })
    const movedIds = elsewhere.map((e) => e.playerId)
    const rowsToCreate = newRows(at, actor.id)
    items.push(
      ...chunk(rowsToCreate, rowsPerInsert(20)).map((part) => db.insert(players).values(part)),
      ...(movedIds.length
        ? [db.delete(seasonTeamPlayers).where(and(eq(seasonTeamPlayers.seasonId, seasonId), inJson(seasonTeamPlayers.playerId, movedIds)))]
        : []),
      ...(out
        ? [
            db.delete(seasonTeamPlayers).where(where(out.playerId)),
            unplaceStatement(db, base, { playerIds: [out.playerId], teamIds: [teamId] }),
          ]
        : []),
      ...rosterInsertStatements(db, seasonId, rows, at, actor.id),
      ...(adding.length
        ? [
            placeStatement(
              db,
              base,
              adding.map((p) => ({ playerId: p.id, teamId })),
            ),
          ]
        : []),
      ...(teamInterest
        ? [
            db
              .update(interestProgrammes)
              .set({ status: 'placed', seasonId, teamId, updatedAt: at, updatedBy: actor.id })
              .where(
                and(
                  eq(interestProgrammes.interestId, teamInterest),
                  eq(interestProgrammes.programmeId, ctx.season.leagueId),
                  sql`${interestProgrammes.interestId} in (select ${interests.id} from ${interests} where ${interests.kind} = 'team')`,
                ),
              ),
          ]
        : []),
    )
    done.added = adding.length
    done.created = rowsToCreate.length
    done.moved = movedIds.length
    detail = {
      players: adding.map((p) => p.name),
      ...(rowsToCreate.length ? { created: rowsToCreate.map((r) => nameOf(r)) } : {}),
      ...(elsewhere.length ? { movedFrom: elsewhere.map((e) => `${e.name} (${e.teamName})`) } : {}),
      ...(out ? { replaced: out.name } : {}),
    }
  } else if (action === 'remove') {
    const r = onTeam(idOf(input.playerId, 'Player'))
    items.push(
      db.delete(seasonTeamPlayers).where(where(r.playerId)),
      unplaceStatement(db, base, { playerIds: [r.playerId], teamIds: [teamId] }),
    )
    detail = { players: [r.name] }
  } else if (action === 'move') {
    const r = onTeam(idOf(input.playerId, 'Player'))
    const to = teamIn(ctx, input.toTeamId, 'Team to move to')
    if (to === teamId) throw invalid('Pick a different team.')
    const theirs = ctx.rows.filter((x) => x.teamId === to)
    const role: RosterRole = r.role === 'captain' && !theirs.some((x) => x.role === 'captain') ? 'captain' : 'player'
    items.push(
      db
        .update(seasonTeamPlayers)
        .set({ teamId: to, role, sort: theirs.reduce((m, x) => Math.max(m, x.sort + 1), 0), updatedAt: at, updatedBy: actor.id })
        .where(where(r.playerId)),
      placeStatement(db, base, [{ playerId: r.playerId, teamId: to }]),
    )
    done.moved = 1
    detail = { players: [r.name], to: ctx.teams.get(to) }
  } else if (action === 'captain') {
    const r = onTeam(idOf(input.playerId, 'Player'))
    const captain = input.captain !== false
    items.push(
      captain
        ? db
            .update(seasonTeamPlayers)
            .set({
              role: sql`case when ${seasonTeamPlayers.playerId} = ${r.playerId} then 'captain' else 'player' end`,
              updatedAt: at,
              updatedBy: actor.id,
            })
            .where(and(eq(seasonTeamPlayers.seasonId, seasonId), eq(seasonTeamPlayers.teamId, teamId)))
        : db.update(seasonTeamPlayers).set({ role: 'player', updatedAt: at, updatedBy: actor.id }).where(where(r.playerId)),
    )
    detail = { players: [r.name], captain }
  } else {
    const order = idList(input.playerIds, 'Player', 200)
    const have = new Set(mine.map((r) => r.playerId))
    if (order.length !== have.size || order.some((p) => !have.has(p)))
      throw new HttpError(409, 'roster_changed', 'The roster changed while you were reordering it. Reload and try again.')
    items.push(
      db
        .update(seasonTeamPlayers)
        .set({
          sort: sql`(select cast(j.key as integer) from json_each(${JSON.stringify(order)}) as j where j.value = ${seasonTeamPlayers.playerId})`,
          updatedAt: at,
          updatedBy: actor.id,
        })
        .where(and(eq(seasonTeamPlayers.seasonId, seasonId), eq(seasonTeamPlayers.teamId, teamId))),
    )
    detail = { order: order.map((p) => mine.find((r) => r.playerId === p)?.name ?? p) }
  }

  items.push(
    audit(
      db,
      actor,
      'roster.update',
      { type: 'season', id: seasonId },
      null,
      { action, season: ctx.season.name, team: teamName, ...detail },
      at,
    ),
  )
  await runBatch(db, items)
  return { ...(await readRosters(db, ctx.season)), done }
}

// ── Team list changes (the season's Save) ─────────────────────────────────────

export type RosterCopySummary = { copied: number; skipped: { name: string; team: string; reason: 'placed' | 'retired' }[] }

/** Parses PUT /teams' optional rosterFrom: { [teamId]: { seasonId } | { interestId } }. */
export function parseRosterFrom(v: unknown, seasonId: string): Map<string, RosterFrom> {
  const out = new Map<string, RosterFrom>()
  if (v === undefined || v === null) return out
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid('rosterFrom must be an object of team ids.')
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length > 40) throw invalid('rosterFrom has too many teams.')
  for (const [teamId, from] of entries) {
    if (!isId(teamId)) throw invalid('rosterFrom: team ids must be ids.')
    const f = (from ?? {}) as Record<string, unknown>
    if (isId(f.seasonId) && f.interestId === undefined) {
      if (f.seasonId === seasonId) throw invalid('rosterFrom: a team’s roster can’t be copied from this same season.')
      out.set(teamId, { seasonId: f.seasonId })
    } else if (isId(f.interestId) && f.seasonId === undefined) out.set(teamId, { interestId: f.interestId })
    else throw invalid('rosterFrom: each team needs { seasonId } or { interestId }.')
  }
  return out
}

/**
 * The statements PUT /teams adds to its batch: rosters of teams leaving the season are deleted (and EOIs placed
 * into them go back to contacted), and teams joining get their roster copied from `rosterFrom`: last time's roster
 * ({ seasonId }), or a team EOI's members ({ interestId }, whose programme row becomes placed). Copies skip retired
 * players and anyone already in a team this season (the first team listed wins). Copied players with an open
 * individual EOI for the league get it placed. Two reads (both before the batch).
 */
export async function rosterCopyStatements(
  db: AppDb,
  actor: Editor,
  ctx: {
    seasonId: string
    leagueId: string
    at: string
    teamIds: string[]
    previousTeamIds: string[]
    rosterFrom: Map<string, RosterFrom>
    teamName: (teamId: string) => string
  },
): Promise<{ statements: Parameters<typeof runBatch>[1]; summary: RosterCopySummary }> {
  const kept = new Set(ctx.teamIds)
  const removed = ctx.previousTeamIds.filter((t) => !kept.has(t))
  const before = new Set(ctx.previousTeamIds)
  for (const teamId of ctx.rosterFrom.keys()) if (!kept.has(teamId)) throw invalid('rosterFrom names a team that isn’t in the team list.')
  // Only teams joining now copy a roster (a team already in keeps its own).
  const joining = ctx.teamIds.filter((t) => !before.has(t) && ctx.rosterFrom.has(t))
  const base = { seasonId: ctx.seasonId, leagueId: ctx.leagueId, at: ctx.at, actorId: actor.id }
  const statements: Parameters<typeof runBatch>[1] = []
  if (removed.length)
    statements.push(
      db.delete(seasonTeamPlayers).where(and(eq(seasonTeamPlayers.seasonId, ctx.seasonId), inJson(seasonTeamPlayers.teamId, removed))),
      unplaceStatement(db, base, { teamIds: removed, kinds: 'any' }),
    )
  const summary: RosterCopySummary = { copied: 0, skipped: [] }
  if (joining.length === 0) return { statements, summary }

  const fromSeason = joining.flatMap((t) => {
    const f = ctx.rosterFrom.get(t)!
    return 'seasonId' in f ? [{ teamId: t, seasonId: f.seasonId }] : []
  })
  const fromInterest = joining.flatMap((t) => {
    const f = ctx.rosterFrom.get(t)!
    return 'interestId' in f ? [{ teamId: t, interestId: f.interestId }] : []
  })
  const [current, seasonRosters, interestRows] = (await runBatch(db, [
    // Who's in a team this season and staying (rows of teams leaving are deleted in the same batch).
    db
      .select({ playerId: seasonTeamPlayers.playerId, teamId: seasonTeamPlayers.teamId })
      .from(seasonTeamPlayers)
      .where(eq(seasonTeamPlayers.seasonId, ctx.seasonId)),
    db
      .select({
        seasonId: seasonTeamPlayers.seasonId,
        teamId: seasonTeamPlayers.teamId,
        playerId: seasonTeamPlayers.playerId,
        role: seasonTeamPlayers.role,
        sort: seasonTeamPlayers.sort,
        firstName: players.firstName,
        lastName: players.lastName,
        retiredAt: players.retiredAt,
      })
      .from(seasonTeamPlayers)
      .innerJoin(players, eq(players.id, seasonTeamPlayers.playerId))
      .where(
        fromSeason.length
          ? and(
              inJson(seasonTeamPlayers.seasonId, [...new Set(fromSeason.map((f) => f.seasonId))]),
              inJson(
                seasonTeamPlayers.teamId,
                fromSeason.map((f) => f.teamId),
              ),
            )
          : sql`0`,
      )
      .orderBy(asc(seasonTeamPlayers.sort), asc(players.firstName)),
    db
      .select({
        interestId: interestMembers.interestId,
        kind: interests.kind,
        playerId: interestMembers.playerId,
        role: interestMembers.role,
        sort: interestMembers.sort,
        firstName: players.firstName,
        lastName: players.lastName,
        retiredAt: players.retiredAt,
      })
      .from(interestMembers)
      .innerJoin(interests, eq(interests.id, interestMembers.interestId))
      .innerJoin(players, eq(players.id, interestMembers.playerId))
      .where(
        fromInterest.length
          ? inJson(
              interestMembers.interestId,
              fromInterest.map((f) => f.interestId),
            )
          : sql`0`,
      )
      .orderBy(asc(interestMembers.sort)),
  ])) as unknown as [
    { playerId: string; teamId: string }[],
    {
      seasonId: string
      teamId: string
      playerId: string
      role: RosterRole
      sort: number
      firstName: string
      lastName: string
      retiredAt: string | null
    }[],
    {
      interestId: string
      kind: string
      playerId: string
      role: RosterRole
      sort: number
      firstName: string
      lastName: string
      retiredAt: string | null
    }[],
  ]
  for (const f of fromInterest)
    if (
      !interestRows.some((r) => r.interestId === f.interestId && r.kind === 'team') &&
      interestRows.some((r) => r.interestId === f.interestId)
    )
      throw invalid('rosterFrom: that EOI is from a player, not a team. Add its player from the picker instead.')

  const placed = new Set(current.filter((c) => kept.has(c.teamId)).map((c) => c.playerId))
  const rows: RosterInsert[] = []
  for (const teamId of joining) {
    const f = ctx.rosterFrom.get(teamId)!
    const source =
      'seasonId' in f
        ? seasonRosters
            .filter((r) => r.seasonId === f.seasonId && r.teamId === teamId)
            .map((r) => ({ ...r, interestId: null as string | null, fromSeasonId: f.seasonId as string | null }))
        : interestRows
            .filter((r) => r.interestId === f.interestId)
            .map((r) => ({ ...r, interestId: f.interestId as string | null, fromSeasonId: null as string | null }))
    let captain = false
    let sort = 0
    for (const p of source) {
      if (p.retiredAt) {
        summary.skipped.push({ name: nameOf(p), team: ctx.teamName(teamId), reason: 'retired' })
        continue
      }
      if (placed.has(p.playerId)) {
        summary.skipped.push({ name: nameOf(p), team: ctx.teamName(teamId), reason: 'placed' })
        continue
      }
      placed.add(p.playerId)
      const role: RosterRole = p.role === 'captain' && !captain ? 'captain' : 'player'
      if (role === 'captain') captain = true
      rows.push({ teamId, playerId: p.playerId, role, sort: sort++, interestId: p.interestId, fromSeasonId: p.fromSeasonId })
    }
  }
  // Copied players' own open individual EOIs (from last season's roster, say) become placed too. Their roster row
  // keeps where it was copied from.
  if (rows.length) statements.push(...rosterInsertStatements(db, ctx.seasonId, rows, ctx.at, actor.id), placeStatement(db, base, rows))
  if (fromInterest.length) {
    const map = JSON.stringify(fromInterest.map((f) => ({ i: f.interestId, t: f.teamId })))
    statements.push(
      db
        .update(interestProgrammes)
        .set({
          status: 'placed',
          seasonId: ctx.seasonId,
          teamId: sql`(select json_extract(j.value, '$.t') from json_each(${map}) as j where json_extract(j.value, '$.i') = ${interestProgrammes.interestId})`,
          updatedAt: ctx.at,
          updatedBy: actor.id,
        })
        .where(
          and(
            eq(interestProgrammes.programmeId, ctx.leagueId),
            inJson(
              interestProgrammes.interestId,
              fromInterest.map((f) => f.interestId),
            ),
          ),
        ),
    )
  }
  summary.copied = rows.length
  return { statements, summary }
}

/**
 * "New season" copying an earlier one (createSeason): every roster of the source season comes along with the teams,
 * roles and order kept, minus retired players. One INSERT … SELECT.
 */
export function copySeasonRostersStatement(db: AppDb, c: { fromSeasonId: string; toSeasonId: string; at: string; actorId: string }) {
  return db.insert(seasonTeamPlayers).select(
    sql`select ${c.toSeasonId}, s.team_id, s.player_id, s.role, s.sort, null, ${c.fromSeasonId}, ${c.at}, ${c.at}, ${c.actorId}
        from ${seasonTeamPlayers} as s join ${players} as p on p.id = s.player_id
        where s.season_id = ${c.fromSeasonId} and p.retired_at is null`,
  )
}

// ── CSV ───────────────────────────────────────────────────────────────────────

const GENDER_TEXT: Record<Gender, string> = {
  female: 'Female',
  male: 'Male',
  non_binary: 'Non-binary',
  prefer_not_to_say: 'Prefer not to say',
}

/** The season's rosters as CSV (for WhatsApp groups): one row per player, team by team. Audited as roster.export. */
export async function exportRosters(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  now = new Date(),
): Promise<{ csv: string; filename: string }> {
  const s = await seasonRow(db, seasonId)
  const view = await readRosters(db, s)
  const rows: unknown[][] = [['Team', 'Role', 'First name', 'Last name', 'Email', 'Phone', 'Gender']]
  for (const t of view.rosters)
    for (const p of t.players)
      rows.push([
        t.teamName,
        p.role === 'captain' ? 'Captain' : 'Player',
        p.firstName,
        p.lastName,
        p.email,
        p.phone ?? '',
        p.gender ? GENDER_TEXT[p.gender] : '',
      ])
  await audit(
    db,
    actor,
    'roster.export',
    { type: 'season', id: seasonId },
    null,
    { season: s.name, players: view.placed },
    now.toISOString(),
  )
  return { csv: toCsv(rows), filename: `${s.slug}-rosters.csv` }
}
