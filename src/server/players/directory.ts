import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import { leagueWindow, type PlayerGroup } from '../../lib/players/groups'
import { sydneyToUtc } from '../../lib/time'
import type { AppDb } from '../db'
import {
  interestMembers,
  interestProgrammes,
  interests,
  leagues,
  openInterestStatuses,
  players,
  seasons,
  seasonTeamPlayers,
  teams,
  type Gender,
  type InterestKind,
  type InterestStatus,
  type RosterRole,
} from '../db/schema'

// The competition player directory (docs/interest.md): every competition player with what the season builder's
// player picker shows: their group for a league (New interest, Last season, Past, Retired), their latest team, their
// open EOI and where they are in the season being built.
//
// Groups are worked out in SQL (groupContext().groupSql, one CASE per player), so the Players screen can page and
// count in SQL with exactly the picker's groups. D1 reads stay bounded by the number of players, not by history:
// the open EOIs and last season's roster are each read once (uncorrelated IN), and "has played" is one index probe
// per player. The picker's roster reads are this league's seasons plus each player's latest spot elsewhere.

/** The most players the directory returns (newest first past this). */
export const DIRECTORY_LIMIT = 3000

export type RosterSpot = {
  seasonId: string
  seasonName: string
  startDate: string
  leagueId: string
  leagueCode: string
  teamId: string
  teamName: string
}

export type DirectoryPlayer = {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  gender: Gender | null
  retiredAt: string | null
  /** Their group for the league asked about (null league: across all leagues). */
  group: PlayerGroup
  /** Their latest roster spot in this league, and anywhere. */
  lastInLeague: RosterSpot | null
  lastAnywhere: RosterSpot | null
  /** Their newest open EOI for the league (any league when none is asked about). */
  interest: {
    interestId: string
    reference: string
    kind: InterestKind
    teamName: string | null
    status: InterestStatus
    createdAt: string
    /** From the EOI's answers, when the form asked. */
    level: string | null
    position: string | null
  } | null
  /** In the season being built: their team(s). */
  inSeason: { teamId: string; teamName: string; role: RosterRole }[]
}

export type Directory = {
  league: { id: string; code: string; name: string } | null
  /** The season the window is for, and its "last season" and since-date (leagueWindow). */
  seasonId: string | null
  lastSeason: { id: string; name: string; startDate: string } | null
  interestSince: string | null
  players: DirectoryPlayer[]
  truncated: boolean
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
const jsonIn = (values: readonly string[]) => sql`(select value from json_each(${JSON.stringify(values)}))`
const OPEN = sql.raw(openInterestStatuses.map((s) => `'${s}'`).join(', '))

/** The UTC instant a Sydney date starts (EOI dates compare in Sydney time, like groupOf()). */
const startOfSydneyDay = (date: string) => sydneyToUtc(`${date}T00:00`) ?? `${date}T00:00:00.000Z`

export type GroupContext = {
  league: { id: string; code: string; name: string } | null
  seasonId: string | null
  lastSeason: { id: string; name: string; startDate: string } | null
  interestSince: string | null
  /** A CASE over `players` (no alias) giving each player's PlayerGroup, as groupOf() would. */
  groupSql: SQL<PlayerGroup>
}

/**
 * The group window for a league (building `seasonId`, or as of `today`), or across every league, and the SQL that
 * puts each player in a group. Two small reads (the league and its seasons). The same rules as groupOf():
 * retired; an open EOI for the league sent since the window started (across leagues: each league's own window);
 * on last season's roster (across leagues: any league's last season); any other roster (the season being built
 * doesn't count); else other.
 */
export async function groupContext(
  db: AppDb,
  opts: { leagueId?: string | null; seasonId?: string | null; today: string },
): Promise<GroupContext> {
  const leagueId = opts.leagueId ?? null
  const seasonId = leagueId ? (opts.seasonId ?? null) : null
  const [league, seasonRows] = await Promise.all([
    leagueId
      ? db.select({ id: leagues.id, code: leagues.code, name: leagues.name }).from(leagues).where(eq(leagues.id, leagueId)).get()
      : null,
    db
      .select({ id: seasons.id, name: seasons.name, startDate: seasons.startDate, leagueId: seasons.leagueId })
      .from(seasons)
      .innerJoin(leagues, eq(leagues.id, seasons.leagueId))
      .where(leagueId ? eq(seasons.leagueId, leagueId) : eq(leagues.kind, 'league')),
  ])

  let interestCond: SQL
  let lastSeasonIds: string[]
  let lastSeason: GroupContext['lastSeason'] = null
  let interestSince: string | null = null
  if (leagueId) {
    const w = leagueWindow(seasonRows, { targetId: seasonId, today: opts.today })
    interestSince = w.interestSince
    const last = w.lastSeasonId ? seasonRows.find((s) => s.id === w.lastSeasonId) : undefined
    lastSeason = last ? { id: last.id, name: last.name, startDate: last.startDate } : null
    lastSeasonIds = last ? [last.id] : []
    interestCond = w.interestSince
      ? sql`ip.programme_id = ${leagueId} and ip.created_at >= ${startOfSydneyDay(w.interestSince)}`
      : sql`ip.programme_id = ${leagueId}`
  } else {
    // Each league's own window; programmes without a started season (events, new leagues) count every open EOI.
    const byLeague = new Map<string, { id: string; startDate: string }[]>()
    for (const s of seasonRows) byLeague.set(s.leagueId, [...(byLeague.get(s.leagueId) ?? []), s])
    const sinceBy: [string, string][] = []
    lastSeasonIds = []
    for (const [id, ss] of byLeague) {
      const w = leagueWindow(ss, { today: opts.today })
      if (w.lastSeasonId) lastSeasonIds.push(w.lastSeasonId)
      if (w.interestSince) sinceBy.push([id, startOfSydneyDay(w.interestSince)])
    }
    // One parameter: { programmeId: since }.
    interestCond = sinceBy.length
      ? sql`ip.created_at >= coalesce(json_extract(${JSON.stringify(Object.fromEntries(sinceBy))}, '$."' || ip.programme_id || '"'), '')`
      : sql`1`
  }
  const openEoi = sql`${players.id} in (select m.player_id from ${interestProgrammes} as ip
    join ${interests} as i on i.id = ip.interest_id
    join ${interestMembers} as m on m.interest_id = ip.interest_id
    where ip.status in (${OPEN}) and i.archived_at is null and m.player_id is not null and ${interestCond})`
  const onLast = lastSeasonIds.length
    ? sql`${players.id} in (select l.player_id from ${seasonTeamPlayers} as l where l.season_id in ${jsonIn(lastSeasonIds)})`
    : sql`0`
  const played = sql`exists (select 1 from ${seasonTeamPlayers} as h where h.player_id = ${players.id}${seasonId ? sql` and h.season_id <> ${seasonId}` : sql``})`
  const groupSql = sql<PlayerGroup>`(case when ${players.retiredAt} is not null then 'retired' when ${openEoi} then 'interest' when ${onLast} then 'last' when ${played} then 'past' else 'other' end)`
  return { league: league ?? null, seasonId, lastSeason, interestSince, groupSql }
}

type SpotRow = RosterSpot & { playerId: string; role: RosterRole }

const spotOf = (s: SpotRow): RosterSpot => ({
  seasonId: s.seasonId,
  seasonName: s.seasonName,
  startDate: s.startDate,
  leagueId: s.leagueId,
  leagueCode: s.leagueCode,
  teamId: s.teamId,
  teamName: s.teamName,
})

/**
 * Each player's latest roster spot (one per player; one per player and league with `perLeague`), leaving out
 * `exceptSeasonId`. With `preferLeagueId`, a spot in that league wins over newer ones elsewhere (the Players
 * screen's "last team": in this league, else anywhere). `playerIds` limits it to those players (a page). One query:
 * a window over the roster rows, joined to names only for the rows kept.
 */
export async function latestSpots(
  db: AppDb,
  opts: { exceptSeasonId?: string | null; preferLeagueId?: string | null; perLeague?: boolean; playerIds?: readonly string[] },
): Promise<SpotRow[]> {
  if (opts.playerIds && opts.playerIds.length === 0) return []
  const where = and(
    opts.exceptSeasonId ? sql`r.season_id <> ${opts.exceptSeasonId}` : undefined,
    opts.playerIds ? sql`r.player_id in ${jsonIn(opts.playerIds)}` : undefined,
  )
  const partition = opts.perLeague ? sql`r.player_id, se.league_id` : sql`r.player_id`
  const prefer = opts.preferLeagueId ? sql`(se.league_id = ${opts.preferLeagueId}) desc, ` : sql``
  const ranked = sql`(select r.player_id, r.season_id, r.team_id, r.role, se.name as season_name, se.start_date, se.league_id,
      row_number() over (partition by ${partition} order by ${prefer}se.start_date desc, se.id desc) as rn
    from ${seasonTeamPlayers} as r join ${seasons} as se on se.id = r.season_id
    ${where ? sql`where ${where}` : sql``})`
  return db
    .select({
      playerId: sql<string>`x.player_id`.as('x_player_id'),
      seasonId: sql<string>`x.season_id`.as('x_season_id'),
      seasonName: sql<string>`x.season_name`.as('x_season_name'),
      startDate: sql<string>`x.start_date`.as('x_start_date'),
      leagueId: sql<string>`x.league_id`.as('x_league_id'),
      leagueCode: sql<string>`${leagues.code}`.as('x_league_code'),
      teamId: sql<string>`x.team_id`.as('x_team_id'),
      teamName: sql<string>`${teams.name}`.as('x_team_name'),
      role: sql<RosterRole>`x.role`.as('x_role'),
    })
    .from(sql`${ranked} as x`)
    .innerJoin(leagues, sql`${leagues.id} = x.league_id`)
    .innerJoin(teams, sql`${teams.id} = x.team_id`)
    .where(sql`x.rn = 1`)
    .all()
}

/** Open EOIs (for the league, or all) of these players or everyone, newest first, with each member's player. */
export function openInterestRows(db: AppDb, opts: { leagueId: string | null; playerIds?: readonly string[] }) {
  return db
    .select({
      playerId: interestMembers.playerId,
      interestId: interests.id,
      reference: interests.reference,
      kind: interests.kind,
      teamName: interests.teamName,
      answers: interests.answers,
      status: interestProgrammes.status,
      programmeId: interestProgrammes.programmeId,
      createdAt: interestProgrammes.createdAt,
    })
    .from(interestProgrammes)
    .innerJoin(interests, eq(interests.id, interestProgrammes.interestId))
    .innerJoin(interestMembers, eq(interestMembers.interestId, interests.id))
    .where(
      and(
        opts.leagueId ? eq(interestProgrammes.programmeId, opts.leagueId) : undefined,
        inArray(interestProgrammes.status, [...openInterestStatuses]),
        isNull(interests.archivedAt),
        opts.playerIds ? sql`${interestMembers.playerId} in ${jsonIn(opts.playerIds)}` : undefined,
      ),
    )
    .orderBy(desc(interestProgrammes.createdAt))
    .all()
}

type OpenRow = Awaited<ReturnType<typeof openInterestRows>>[number]

/** The newest open EOI per player, as the directory shows it. */
export function newestInterestBy(rows: readonly OpenRow[]): Map<string, DirectoryPlayer['interest']> {
  const out = new Map<string, DirectoryPlayer['interest']>()
  for (const e of rows) {
    if (!e.playerId || out.has(e.playerId)) continue
    const answers = (e.answers ?? {}) as Record<string, unknown>
    out.set(e.playerId, {
      interestId: e.interestId,
      reference: e.reference,
      kind: e.kind,
      teamName: e.teamName,
      status: e.status,
      createdAt: e.createdAt,
      level: str(answers.playing_level) ?? str(answers.skill_level),
      position: str(answers.position),
    })
  }
  return out
}

/**
 * The directory: every competition player (newest first, at most DIRECTORY_LIMIT) with their group, latest spots,
 * open EOI and spots in `seasonId`. Reads: the group window (two), then the players with their group, this league's
 * roster rows, each player's latest spot anywhere and the open EOIs (run together).
 */
export async function competitionDirectory(
  db: AppDb,
  opts: { leagueId?: string | null; seasonId?: string | null; today: string },
): Promise<Directory> {
  const ctx = await groupContext(db, opts)
  const leagueId = ctx.league?.id ?? null
  const seasonId = ctx.seasonId
  const [people, leagueSpots, anywhere, open] = await Promise.all([
    db
      .select({
        id: players.id,
        firstName: players.firstName,
        lastName: players.lastName,
        email: players.email,
        phone: players.phone,
        gender: players.gender,
        retiredAt: players.retiredAt,
        group: ctx.groupSql,
      })
      .from(players)
      .where(eq(players.pool, 'competition'))
      .orderBy(desc(players.createdAt), desc(players.id))
      .limit(DIRECTORY_LIMIT + 1)
      .all(),
    // This league's roster rows (its seasons only): the latest in the league, and the season being built.
    leagueId
      ? db
          .select({
            playerId: seasonTeamPlayers.playerId,
            seasonId: seasons.id,
            seasonName: seasons.name,
            startDate: seasons.startDate,
            leagueId: seasons.leagueId,
            leagueCode: leagues.code,
            teamId: teams.id,
            teamName: teams.name,
            role: seasonTeamPlayers.role,
          })
          .from(seasonTeamPlayers)
          .innerJoin(seasons, eq(seasons.id, seasonTeamPlayers.seasonId))
          .innerJoin(leagues, eq(leagues.id, seasons.leagueId))
          .innerJoin(teams, eq(teams.id, seasonTeamPlayers.teamId))
          .where(eq(seasons.leagueId, leagueId))
          .all()
      : Promise.resolve([] as SpotRow[]),
    // Each player's latest spot anywhere (not the season being built).
    latestSpots(db, { exceptSeasonId: seasonId }),
    openInterestRows(db, { leagueId }),
  ])

  const truncated = people.length > DIRECTORY_LIMIT
  const list = truncated ? people.slice(0, DIRECTORY_LIMIT) : people
  const newest = (a: { startDate: string; seasonId: string }, b: { startDate: string; seasonId: string }) =>
    a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : a.seasonId < b.seasonId ? 1 : -1
  const lastInLeague = new Map<string, SpotRow>()
  const inSeason = new Map<string, DirectoryPlayer['inSeason']>()
  for (const s of leagueSpots.toSorted(newest)) {
    if (s.seasonId === seasonId) {
      inSeason.set(s.playerId, [...(inSeason.get(s.playerId) ?? []), { teamId: s.teamId, teamName: s.teamName, role: s.role }])
      continue
    }
    if (!lastInLeague.has(s.playerId)) lastInLeague.set(s.playerId, s)
  }
  const lastAnywhere = new Map(anywhere.map((s) => [s.playerId, s]))
  const eoi = newestInterestBy(open)

  const out: DirectoryPlayer[] = list.map((p) => {
    const inL = lastInLeague.get(p.id)
    const any = lastAnywhere.get(p.id)
    return {
      ...p,
      lastInLeague: inL ? spotOf(inL) : null,
      lastAnywhere: any ? spotOf(any) : null,
      interest: eoi.get(p.id) ?? null,
      inSeason: inSeason.get(p.id) ?? [],
    }
  })

  return {
    league: ctx.league,
    seasonId,
    lastSeason: ctx.lastSeason,
    interestSince: ctx.interestSince,
    players: out,
    truncated,
  }
}
