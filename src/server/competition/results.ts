import { and, eq, inArray } from 'drizzle-orm'
import { dayPublishProblem, setScoresProblem, type Game, type Ref, type Week } from '../../lib/fixtures'
import { tags, type PurgeTargets } from '../cache'
import { runBatch, type AppDb } from '../db'
import {
  leagues,
  matchDays,
  matches,
  matchResults,
  seasons,
  type League,
  type Match,
  type MatchDay,
  type MatchResult,
  type Season,
} from '../db/schema'
import { HttpError } from '../http'
import { audit, notFound, type Changed, type Editor } from '../content/common'
import { toResult } from './adapter'
import { chunkByParams, compact } from './draw'
import { baseUpdatedAt, id, invalid, parseResult, type ResultValues } from './input'
import { archived } from './seasons'

// Results, one match day at a time (the demo's enter -> publish -> edit -> republish cycle):
//  - saveResults writes `draft` rows: what's being typed in. Nothing public changes.
//  - publishResults copies the day's draft rows over its `published` rows, stamps results_published_at (the
//    ladder's "Updated" line), marks the games played and purges the league's pages.
//  - undoResults throws away unpublished edits (draft := published).
// Editors can do all three. The season must be published (draws are locked by then); archived seasons are read-only.
// Concurrency: match_days.updated_at, which all three bump (and so does setMatchStatus).
//
// Cancelled games (matches.status = 'cancelled') take no result: saving one is refused, and publishing skips them
// and drops any result they had. A forfeit is an ordinary result with a label.

export type MatchDayState = { id: string; updatedAt: string; resultsPublishedAt: string | null }

type Loaded = {
  season: Season
  league: League
  day: MatchDay
  matches: Match[]
  results: MatchResult[]
}

/** The season, its league, one match day, its matches and their results: one round trip, 5 queries. */
async function loadDay(db: AppDb, seasonId: string, dayId: string): Promise<Loaded> {
  const ids = db.select({ id: matches.id }).from(matches).where(eq(matches.matchDayId, dayId))
  const [seasonRows, leagueRows, dayRows, matchRows, resultRows] = (await runBatch(db, [
    db.select().from(seasons).where(eq(seasons.id, seasonId)),
    db
      .select()
      .from(leagues)
      .where(inArray(leagues.id, db.select({ id: seasons.leagueId }).from(seasons).where(eq(seasons.id, seasonId)))),
    db
      .select()
      .from(matchDays)
      .where(and(eq(matchDays.id, dayId), eq(matchDays.seasonId, seasonId))),
    db.select().from(matches).where(eq(matches.matchDayId, dayId)),
    db.select().from(matchResults).where(inArray(matchResults.matchId, ids)),
  ])) as unknown as [Season[], League[], MatchDay[], Match[], MatchResult[]]
  const season = seasonRows[0]
  const league = leagueRows[0]
  const day = dayRows[0]
  if (!season || !league) throw notFound('season')
  if (!day) throw notFound('match day')
  return { season, league, day, matches: matchRows, results: resultRows }
}

function assertResultsOpen(l: Loaded, base: string) {
  if (l.season.status === 'archived') throw archived()
  if (l.season.status !== 'published')
    throw new HttpError(409, 'season_not_published', 'Publish the season (which locks the draw) before entering results.')
  if (l.day.kind === 'skip') throw invalid('That’s a week off: there are no games to enter.')
  if (base !== l.day.updatedAt)
    throw new HttpError(
      409,
      'conflict',
      'Someone else changed this match day’s results while you were working. Reload to see their changes.',
    )
}

const dayState = (day: MatchDay, at: string, resultsPublishedAt = day.resultsPublishedAt): MatchDayState => ({
  id: day.id,
  updatedAt: at,
  resultsPublishedAt,
})

const purgeFor = (l: Loaded): PurgeTargets => ({ tags: [tags.season(l.season.slug), tags.league(l.league.slug), tags.site] })

const ref = (teamId: string | null, label: string | null): Ref => (teamId ? { team: teamId } : { label: label ?? 'TBC' })

/** The day as the lib's Week, with draft results as `result` and published ones as `publishedResult`. */
function asWeek(l: Loaded): Week {
  const byKey = new Map(l.results.map((r) => [`${r.matchId}:${r.kind}`, r]))
  return {
    id: l.day.id,
    kind: l.day.kind,
    date: l.day.date,
    matchDay: l.day.number,
    games: l.matches
      .toSorted((a, b) => a.session - b.session || a.position - b.position)
      .map((m): Game => ({
        id: m.id,
        session: m.session,
        court: m.position,
        home: ref(m.homeTeamId, m.homeLabel),
        away: ref(m.awayTeamId, m.awayLabel),
        duty: m.dutyTeamId || m.dutyLabel ? ref(m.dutyTeamId, m.dutyLabel) : null,
        ...(m.stageTitle ? { title: m.stageTitle } : {}),
        result: toResult(byKey.get(`${m.id}:draft`)),
        publishedResult: toResult(byKey.get(`${m.id}:published`)),
      })),
  }
}

const cancelledIn = (l: Loaded) => new Set(l.matches.filter((m) => m.status === 'cancelled').map((m) => m.id))

const copyRows = (rows: MatchResult[], kind: MatchResult['kind'], actorId: string, at: string) =>
  rows.map((r) =>
    compact({
      matchId: r.matchId,
      kind,
      homeSets: r.homeSets,
      awaySets: r.awaySets,
      setScores: r.setScores,
      homePoints: r.homePoints,
      awayPoints: r.awayPoints,
      updatedAt: at,
      updatedBy: actorId,
    }),
  )

export type SaveResultsInput = {
  baseUpdatedAt?: unknown
  /** By match id: the result as typed (the lib's Result), or null to clear it. Matches left out are unchanged. */
  results?: unknown
}

/** Saves draft results for some (or all) of one match day's games. Nothing public changes until publishResults. */
export async function saveResults(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  dayId: string,
  input: SaveResultsInput,
  now = new Date(),
): Promise<MatchDayState> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  if (!input.results || typeof input.results !== 'object' || Array.isArray(input.results))
    throw invalid('results must be an object keyed by match id.')
  const l = await loadDay(db, seasonId, dayId)
  assertResultsOpen(l, base)
  const inDay = new Set(l.matches.map((m) => m.id))
  const cancelled = cancelledIn(l)
  const entries = Object.entries(input.results as Record<string, unknown>)
  if (entries.length > inDay.size) throw invalid('More results than games on this match day.')
  const values: (ResultValues & { matchId: string })[] = []
  const touched: string[] = []
  for (const [matchId, v] of entries) {
    id(matchId, 'Match')
    if (!inDay.has(matchId)) throw invalid('One of those games isn’t on this match day.')
    if (v !== null && cancelled.has(matchId)) throw invalid('That game was cancelled, so it can’t have a result. Mark it played first.')
    touched.push(matchId)
    const r = parseResult(v, l.season.setsPerMatch)
    if (r) values.push({ matchId, ...r })
  }
  const at = now.toISOString()
  const rows = values.map((r) => compact({ ...r, kind: 'draft' as const, updatedAt: at, updatedBy: actor.id }))
  await runBatch(db, [
    ...(touched.length ? [db.delete(matchResults).where(and(eq(matchResults.kind, 'draft'), inArray(matchResults.matchId, touched)))] : []),
    ...chunkByParams(rows).map((chunk) => db.insert(matchResults).values(chunk)),
    db.update(matchDays).set({ updatedAt: at, updatedBy: actor.id }).where(eq(matchDays.id, dayId)),
  ])
  return dayState(l.day, at)
}

/**
 * Publishes a match day: every game needs a complete draft result (the lib's publishProblem, plus the season's sets
 * per match), finals can't be draws. Replaces the day's published results, stamps results_published_at, marks
 * scheduled games played. Audited as results.publish; purges the season, its league and the ladder widgets.
 */
export async function publishResults(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  dayId: string,
  input: { baseUpdatedAt?: unknown },
  now = new Date(),
): Promise<Changed<MatchDayState>> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  const l = await loadDay(db, seasonId, dayId)
  assertResultsOpen(l, base)
  const week = asWeek(l)
  if (week.games.length === 0) throw invalid('This match day has no games.')
  const cancelled = cancelledIn(l)
  const problem =
    dayPublishProblem(week, cancelled) ??
    week.games
      .filter((g) => !cancelled.has(g.id))
      .map((g) => setScoresProblem(g.result?.sets, l.season.setsPerMatch))
      .find((p) => p !== null) ??
    null
  if (problem) throw new HttpError(422, 'not_ready', problem)

  const at = now.toISOString()
  const ids = l.matches.map((m) => m.id)
  // Cancelled games publish without a result, so one they had before leaves the ladder.
  const drafts = l.results.filter((r) => r.kind === 'draft' && !cancelled.has(r.matchId))
  const before = l.results.filter((r) => r.kind === 'published').length
  await runBatch(db, [
    db.delete(matchResults).where(and(eq(matchResults.kind, 'published'), inArray(matchResults.matchId, ids))),
    ...chunkByParams(copyRows(drafts, 'published', actor.id, at)).map((chunk) => db.insert(matchResults).values(chunk)),
    db
      .update(matches)
      .set({ status: 'played', updatedAt: at, updatedBy: actor.id })
      .where(and(eq(matches.matchDayId, dayId), eq(matches.status, 'scheduled'))),
    db.update(matchDays).set({ resultsPublishedAt: at, updatedAt: at, updatedBy: actor.id }).where(eq(matchDays.id, dayId)),
    audit(
      db,
      actor,
      'results.publish',
      { type: 'match_day', id: dayId },
      { season: l.season.name, date: l.day.date, published: before, resultsPublishedAt: l.day.resultsPublishedAt },
      { season: l.season.name, date: l.day.date, matchDay: l.day.number, published: drafts.length },
      at,
    ),
  ])
  return { result: dayState(l.day, at, at), purge: purgeFor(l) }
}

/** Throws away unpublished edits to a match day: its draft results become the published ones again. */
export async function undoResults(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  dayId: string,
  input: { baseUpdatedAt?: unknown },
  now = new Date(),
): Promise<MatchDayState> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  const l = await loadDay(db, seasonId, dayId)
  assertResultsOpen(l, base)
  const at = now.toISOString()
  const ids = l.matches.map((m) => m.id)
  const cancelled = cancelledIn(l)
  const published = l.results.filter((r) => r.kind === 'published' && !cancelled.has(r.matchId))
  await runBatch(db, [
    db.delete(matchResults).where(and(eq(matchResults.kind, 'draft'), inArray(matchResults.matchId, ids))),
    ...chunkByParams(copyRows(published, 'draft', actor.id, at)).map((chunk) => db.insert(matchResults).values(chunk)),
    db.update(matchDays).set({ updatedAt: at, updatedBy: actor.id }).where(eq(matchDays.id, dayId)),
  ])
  return dayState(l.day, at)
}

/**
 * What the admin can set a game to. 'played' means "neither cancelled nor a forfeit": it's stored as played once the
 * game has a published result, and as scheduled before that.
 */
export const settableStatuses = ['played', 'forfeit', 'cancelled'] as const
export type SettableStatus = (typeof settableStatuses)[number]

export type SetMatchStatusInput = { baseUpdatedAt?: unknown; status?: unknown }

/**
 * Marks one game cancelled or a forfeit, or back to played. Cancelling throws away its draft result; a published one
 * stays on the ladder until the match day is published again. Bumps the match day's token. The public fixtures show
 * "Cancelled" and "(forfeit)" straight away, so this purges the league's pages. Audited as match.status.
 */
export async function setMatchStatus(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  dayId: string,
  matchId: string,
  input: SetMatchStatusInput,
  now = new Date(),
): Promise<Changed<{ matchDay: MatchDayState; match: { id: string; status: Match['status'] } }>> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  const wanted = input.status
  if (typeof wanted !== 'string' || !(settableStatuses as readonly string[]).includes(wanted))
    throw invalid('status must be played, forfeit or cancelled.')
  id(matchId, 'Match')
  const l = await loadDay(db, seasonId, dayId)
  assertResultsOpen(l, base)
  const match = l.matches.find((m) => m.id === matchId)
  if (!match) throw notFound('game')
  const hasPublished = l.results.some((r) => r.matchId === matchId && r.kind === 'published')
  const status: Match['status'] = wanted === 'played' ? (hasPublished ? 'played' : 'scheduled') : (wanted as SettableStatus)
  if (status === match.status) return { result: { matchDay: dayState(l.day, l.day.updatedAt), match: { id: matchId, status } }, purge: {} }
  const at = now.toISOString()
  await runBatch(db, [
    db.update(matches).set({ status, updatedAt: at, updatedBy: actor.id }).where(eq(matches.id, matchId)),
    ...(status === 'cancelled'
      ? [db.delete(matchResults).where(and(eq(matchResults.kind, 'draft'), eq(matchResults.matchId, matchId)))]
      : []),
    db.update(matchDays).set({ updatedAt: at, updatedBy: actor.id }).where(eq(matchDays.id, dayId)),
    audit(
      db,
      actor,
      'match.status',
      { type: 'match', id: matchId },
      { season: l.season.name, date: l.day.date, status: match.status },
      { season: l.season.name, date: l.day.date, status },
      at,
    ),
  ])
  return { result: { matchDay: dayState(l.day, at), match: { id: matchId, status } }, purge: purgeFor(l) }
}
