import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { groupOf, leagueWindow, type PlayerGroup } from '../../lib/players/groups'
import { sydneyDate } from '../../lib/time'
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
// player picker and the Players screen show: their group for a league (New interest, Last season, Past, Retired),
// their latest team, their open EOI and where they are in the season being built. Five reads (run together); the list is small (hundreds of players), so the browser filters and searches it.

/** The most players the directory returns (newest first past this); the Players screen pages beyond it. */
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

export async function competitionDirectory(
  db: AppDb,
  opts: { leagueId?: string | null; seasonId?: string | null; today: string },
): Promise<Directory> {
  const leagueId = opts.leagueId ?? null
  const seasonId = opts.seasonId ?? null
  const [league, leagueSeasons, people, spots, open] = await Promise.all([
    leagueId
      ? db.select({ id: leagues.id, code: leagues.code, name: leagues.name }).from(leagues).where(eq(leagues.id, leagueId)).get()
      : null,
    leagueId
      ? db
          .select({ id: seasons.id, name: seasons.name, startDate: seasons.startDate, leagueId: seasons.leagueId })
          .from(seasons)
          .where(eq(seasons.leagueId, leagueId))
      : db
          .select({ id: seasons.id, name: seasons.name, startDate: seasons.startDate, leagueId: seasons.leagueId })
          .from(seasons)
          .innerJoin(leagues, eq(leagues.id, seasons.leagueId))
          .where(eq(leagues.kind, 'league')),
    db
      .select({
        id: players.id,
        firstName: players.firstName,
        lastName: players.lastName,
        email: players.email,
        phone: players.phone,
        gender: players.gender,
        retiredAt: players.retiredAt,
      })
      .from(players)
      .where(eq(players.pool, 'competition'))
      .orderBy(desc(players.createdAt))
      .limit(DIRECTORY_LIMIT + 1),
    // Every roster spot of competition players (a few per player per season: small).
    db
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
      .innerJoin(teams, eq(teams.id, seasonTeamPlayers.teamId)),
    // Open EOIs (for the league, or all), newest first, with each member's player.
    db
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
          leagueId ? eq(interestProgrammes.programmeId, leagueId) : sql`1 = 1`,
          inArray(interestProgrammes.status, [...openInterestStatuses]),
          isNull(interests.archivedAt),
        ),
      )
      .orderBy(desc(interestProgrammes.createdAt)),
  ])

  const truncated = people.length > DIRECTORY_LIMIT
  const list = truncated ? people.slice(0, DIRECTORY_LIMIT) : people

  // The window: for one league, its seasons; across leagues, each league's own (a player is "last season" if on
  // the latest started roster of any league).
  const windows = new Map<string, { lastSeasonId: string | null; interestSince: string | null }>()
  if (leagueId) windows.set(leagueId, leagueWindow(leagueSeasons, { targetId: seasonId, today: opts.today }))
  else {
    const byLeague = new Map<string, { id: string; startDate: string }[]>()
    for (const s of leagueSeasons) {
      const l = byLeague.get(s.leagueId) ?? []
      l.push(s)
      byLeague.set(s.leagueId, l)
    }
    for (const [id, ss] of byLeague) windows.set(id, leagueWindow(ss, { today: opts.today }))
  }
  const w = leagueId ? windows.get(leagueId)! : null
  const lastSeason = w?.lastSeasonId ? (leagueSeasons.find((s) => s.id === w.lastSeasonId) ?? null) : null

  const spotsBy = new Map<string, typeof spots>()
  for (const s of spots) {
    const l = spotsBy.get(s.playerId) ?? []
    l.push(s)
    spotsBy.set(s.playerId, l)
  }
  const openBy = new Map<string, typeof open>()
  for (const o of open) {
    if (!o.playerId) continue
    const l = openBy.get(o.playerId) ?? []
    l.push(o)
    openBy.set(o.playerId, l)
  }
  const newest = (a: { startDate: string }, b: { startDate: string }) =>
    a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0
  const spot = (s: (typeof spots)[number]): RosterSpot => ({
    seasonId: s.seasonId,
    seasonName: s.seasonName,
    startDate: s.startDate,
    leagueId: s.leagueId,
    leagueCode: s.leagueCode,
    teamId: s.teamId,
    teamName: s.teamName,
  })

  const out: DirectoryPlayer[] = list.map((p) => {
    const mine = (spotsBy.get(p.id) ?? []).slice().sort(newest)
    const before = mine.filter((s) => s.seasonId !== seasonId)
    const eois = openBy.get(p.id) ?? []
    let group: PlayerGroup
    if (leagueId) {
      group = groupOf(
        {
          retiredAt: p.retiredAt,
          leagueSeasonIds: before.filter((s) => s.leagueId === leagueId).map((s) => s.seasonId),
          playedElsewhere: before.some((s) => s.leagueId !== leagueId),
          openInterestDates: eois.map((e) => sydneyDate(new Date(e.createdAt))),
        },
        w!,
        seasonId,
      )
    } else {
      // Across leagues: the "best" group any league gives them (interest > last > past > other).
      const rank: PlayerGroup[] = ['interest', 'last', 'past', 'other']
      const leaguesSeen = new Set([...before.map((s) => s.leagueId), ...eois.map((e) => e.programmeId)])
      group = p.retiredAt ? 'retired' : 'other'
      if (!p.retiredAt)
        for (const lid of leaguesSeen) {
          const g = groupOf(
            {
              retiredAt: null,
              leagueSeasonIds: before.filter((s) => s.leagueId === lid).map((s) => s.seasonId),
              playedElsewhere: before.some((s) => s.leagueId !== lid),
              openInterestDates: eois.filter((e) => e.programmeId === lid).map((e) => sydneyDate(new Date(e.createdAt))),
            },
            windows.get(lid) ?? { lastSeasonId: null, interestSince: null },
          )
          if (rank.indexOf(g) < rank.indexOf(group)) group = g
        }
    }
    const eoi = eois[0]
    const answers = (eoi?.answers ?? {}) as Record<string, unknown>
    return {
      ...p,
      group,
      lastInLeague: leagueId
        ? before.find((s) => s.leagueId === leagueId)
          ? spot(before.find((s) => s.leagueId === leagueId)!)
          : null
        : null,
      lastAnywhere: before[0] ? spot(before[0]) : null,
      interest: eoi
        ? {
            interestId: eoi.interestId,
            reference: eoi.reference,
            kind: eoi.kind,
            teamName: eoi.teamName,
            status: eoi.status,
            createdAt: eoi.createdAt,
            level: str(answers.playing_level) ?? str(answers.skill_level),
            position: str(answers.position),
          }
        : null,
      inSeason: seasonId
        ? mine.filter((s) => s.seasonId === seasonId).map((s) => ({ teamId: s.teamId, teamName: s.teamName, role: s.role }))
        : [],
    }
  })

  return {
    league: league ?? null,
    seasonId,
    lastSeason: lastSeason ? { id: lastSeason.id, name: lastSeason.name, startDate: lastSeason.startDate } : null,
    interestSince: w?.interestSince ?? null,
    players: out,
    truncated,
  }
}
