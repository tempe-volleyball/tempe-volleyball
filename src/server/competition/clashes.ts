import { and, asc, between, eq, inArray, max, min, ne } from 'drizzle-orm'
import type { SeasonDraw } from '../../lib/fixtures'
import { runBatch, type AppDb } from '../db'
import {
  courts,
  leagues,
  matchDays,
  matches,
  seasons,
  seasonTeams,
  teams,
  type Court,
  type League,
  type Match,
  type MatchDay,
  type Season,
  type Team,
} from '../db/schema'
import { notFound } from '../content/common'
import { toCompetition } from './adapter'
import { invalid, isDate } from './input'

// Other seasons' draws at the same venue in the same dates, for the admin to run the lib's courtClashes() against
// the draw it's editing (several leagues share Robyn Webster's courts). The server only gathers the draws.
// Two round trips: this season and its date range, then up to MAX_SEASONS other seasons' match days in that range.

export const MAX_SEASONS = 10

export type ClashDraws = {
  /** The venue id every draw is tagged with: pass it as SeasonDraw.venue for the season being edited too. */
  venue: string | null
  from: string | null
  to: string | null
  draws: SeasonDraw[]
}

export async function clashDraws(
  db: AppDb,
  seasonId: string,
  range: { from?: string | null; to?: string | null } = {},
): Promise<ClashDraws> {
  if ((range.from && !isDate(range.from)) || (range.to && !isDate(range.to))) throw invalid('from and to must be dates, YYYY-MM-DD.')
  const [seasonRows, leagueRows, spanRows] = (await runBatch(db, [
    db.select().from(seasons).where(eq(seasons.id, seasonId)),
    db
      .select()
      .from(leagues)
      .where(inArray(leagues.id, db.select({ id: seasons.leagueId }).from(seasons).where(eq(seasons.id, seasonId)))),
    db
      .select({ from: min(matchDays.date), to: max(matchDays.date) })
      .from(matchDays)
      .where(eq(matchDays.seasonId, seasonId)),
  ])) as unknown as [Season[], League[], { from: string | null; to: string | null }[]]
  const season = seasonRows[0]
  const league = leagueRows[0]
  if (!season || !league) throw notFound('season')
  const venue = league.defaultVenueId
  const from = range.from || spanRows[0]?.from || null
  const to = range.to || spanRows[0]?.to || null
  if (!venue || !from || !to || from > to) return { venue, from, to, draws: [] }

  const inRange = and(between(matchDays.date, from, to), ne(matchDays.seasonId, seasonId))
  const others = db
    .selectDistinct({ id: matchDays.seasonId })
    .from(matchDays)
    .innerJoin(seasons, eq(seasons.id, matchDays.seasonId))
    .innerJoin(leagues, eq(leagues.id, seasons.leagueId))
    .where(and(inRange, eq(leagues.defaultVenueId, venue)))
    .limit(MAX_SEASONS)
  const dayIds = db
    .select({ id: matchDays.id })
    .from(matchDays)
    .where(and(inRange, inArray(matchDays.seasonId, others)))
  const [otherSeasons, teamRows, dayRows, matchRows, courtRows] = (await runBatch(db, [
    db.select().from(seasons).where(inArray(seasons.id, others)),
    db
      .select({ seasonId: seasonTeams.seasonId, team: teams })
      .from(seasonTeams)
      .innerJoin(teams, eq(teams.id, seasonTeams.teamId))
      .where(inArray(seasonTeams.seasonId, others))
      .orderBy(asc(seasonTeams.sort)),
    db
      .select()
      .from(matchDays)
      .where(and(inRange, inArray(matchDays.seasonId, others))),
    db.select().from(matches).where(inArray(matches.matchDayId, dayIds)),
    db.select().from(courts),
  ])) as unknown as [Season[], { seasonId: string; team: Team }[], MatchDay[], Match[], Court[]]

  const draws = otherSeasons
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((s): SeasonDraw => {
      const days = dayRows.filter((d) => d.seasonId === s.id)
      const dayIdSet = new Set(days.map((d) => d.id))
      const c = toCompetition({
        season: s,
        league,
        teams: teamRows.filter((r) => r.seasonId === s.id).map((r) => r.team),
        matchDays: days,
        matches: matchRows.filter((m) => dayIdSet.has(m.matchDayId)),
        results: [],
        adjustments: [],
        courts: courtRows,
      })
      return { seasonId: s.id, label: s.name, venue, settings: c.settings, weeks: c.weeks }
    })
  return { venue, from, to, draws }
}
