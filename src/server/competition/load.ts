import { and, asc, eq, inArray, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { AppDb } from '../db'
import {
  courts,
  ladderAdjustments,
  leagues,
  matchDays,
  matches,
  matchResults,
  seasons,
  seasonTeams,
  teams,
  type League,
  type Season,
} from '../db/schema'
import type { SeasonData } from './adapter'

// Loading seasons for the public site: a fixed number of queries per call, whatever the number of seasons or matches,
// always inside one db.batch() round trip. Only published results are read.

/** Which seasons to load: by id, or every season in a status (e.g. all published ones, for the ladder widgets). */
export type SeasonFilter = { ids: string[] } | { status: Season['status'] }

const where = (col: SQLiteColumn, f: SeasonFilter, db: AppDb): SQL =>
  'ids' in f
    ? inArray(col, f.ids.length > 0 ? f.ids : [''])
    : inArray(col, db.select({ id: seasons.id }).from(seasons).where(eq(seasons.status, f.status)))

/**
 * The queries for a set of seasons, to put in a db.batch() (possibly with other queries). Pass the batch results
 * for these, in order, to assembleSeasons().
 */
export function seasonQueries(db: AppDb, f: SeasonFilter) {
  return [
    db
      .select()
      .from(seasons)
      .where('ids' in f ? inArray(seasons.id, f.ids.length > 0 ? f.ids : ['']) : eq(seasons.status, f.status)),
    db
      .select({ seasonId: seasonTeams.seasonId, team: teams })
      .from(seasonTeams)
      .innerJoin(teams, eq(teams.id, seasonTeams.teamId))
      .where(where(seasonTeams.seasonId, f, db))
      .orderBy(asc(seasonTeams.sort), asc(teams.name)),
    db
      .select()
      .from(matchDays)
      .where(where(matchDays.seasonId, f, db)),
    db
      .select()
      .from(matches)
      .where(where(matches.seasonId, f, db)),
    db
      .select()
      .from(matchResults)
      .where(
        and(
          eq(matchResults.kind, 'published'),
          inArray(
            matchResults.matchId,
            db
              .select({ id: matches.id })
              .from(matches)
              .where(where(matches.seasonId, f, db)),
          ),
        ),
      ),
    db
      .select()
      .from(ladderAdjustments)
      .where(where(ladderAdjustments.seasonId, f, db)),
  ] as const
}

type Rows<T extends readonly unknown[]> = { [K in keyof T]: Awaited<T[K]> }
export type SeasonRows = Rows<ReturnType<typeof seasonQueries>>

const group = <T, K>(rows: T[], key: (r: T) => K) => {
  const m = new Map<K, T[]>()
  for (const r of rows) {
    const list = m.get(key(r))
    if (list) list.push(r)
    else m.set(key(r), [r])
  }
  return m
}

/** Batch results -> SeasonData per season id. `leagueRows` and `courtRows` are all leagues and all courts. */
export function assembleSeasons(
  rows: SeasonRows,
  leagueRows: League[],
  courtRows: (typeof courts.$inferSelect)[],
): Map<string, SeasonData> {
  const [seasonRows, teamRows, dayRows, matchRows, resultRows, adjustmentRows] = rows
  const leagueById = new Map(leagueRows.map((l) => [l.id, l]))
  const teamsBy = group(teamRows, (r) => r.seasonId)
  const daysBy = group(dayRows, (r) => r.seasonId)
  const matchesBy = group(matchRows, (r) => r.seasonId)
  const seasonOfMatch = new Map(matchRows.map((m) => [m.id, m.seasonId]))
  const resultsBy = group(resultRows, (r) => seasonOfMatch.get(r.matchId))
  const adjustmentsBy = group(adjustmentRows, (r) => r.seasonId)
  const out = new Map<string, SeasonData>()
  for (const season of seasonRows) {
    const league = leagueById.get(season.leagueId)
    if (!league) continue
    out.set(season.id, {
      season,
      league,
      teams: (teamsBy.get(season.id) ?? []).map((r) => r.team),
      matchDays: daysBy.get(season.id) ?? [],
      matches: matchesBy.get(season.id) ?? [],
      results: resultsBy.get(season.id) ?? [],
      adjustments: adjustmentsBy.get(season.id) ?? [],
      courts: courtRows,
    })
  }
  return out
}

/** Leagues and courts: small tables every competition page needs. */
export const baseQueries = (db: AppDb) =>
  [db.select().from(leagues).orderBy(asc(leagues.sort), asc(leagues.code)), db.select().from(courts).orderBy(asc(courts.sort))] as const

/** Season summaries (no draw), for archive lists and to find each league's current season. */
export const seasonListQuery = (db: AppDb) =>
  db
    .select({
      id: seasons.id,
      leagueId: seasons.leagueId,
      name: seasons.name,
      slug: seasons.slug,
      year: seasons.year,
      quarter: seasons.quarter,
      status: seasons.status,
      startDate: seasons.startDate,
    })
    .from(seasons)

export type SeasonSummary = Awaited<ReturnType<typeof seasonListQuery>>[number]

const newestFirst = (a: Pick<SeasonSummary, 'year' | 'quarter'>, b: Pick<SeasonSummary, 'year' | 'quarter'>) =>
  b.year - a.year || b.quarter - a.quarter

/**
 * A league's current season: its newest published season. Drafts never show; when nothing is published (yet),
 * the newest archived season stands in so the league page isn't empty.
 */
export function currentSeason<T extends Pick<SeasonSummary, 'leagueId' | 'year' | 'quarter' | 'status'>>(
  list: T[],
  leagueId: string,
): T | undefined {
  const mine = list.filter((s) => s.leagueId === leagueId).toSorted(newestFirst)
  return mine.find((s) => s.status === 'published') ?? mine.find((s) => s.status === 'archived')
}

/** A league's public seasons, newest first. */
export const publicSeasons = <T extends Pick<SeasonSummary, 'leagueId' | 'year' | 'quarter' | 'status'>>(
  list: T[],
  leagueId: string,
): T[] => list.filter((s) => s.leagueId === leagueId && s.status !== 'draft').toSorted(newestFirst)
