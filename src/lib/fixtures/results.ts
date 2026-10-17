import { sydneyDateTime } from '../time'
import { formatAU } from './dates'
import { DEFAULT_POINTS, MAX_SETS, isTeam, type Ref, type Result, type SetScore, type Settings, type Week } from './types'

export type CompleteResult = { home: number; away: number; homePoints: number; awayPoints: number }

const filled = (v: number | null | undefined): v is number => typeof v === 'number'

const hasSets = (r: Result | undefined): r is Result & { sets: SetScore[] } => !!r?.sets && r.sets.length > 0

/**
 * The result as it counts: with set scores, sets won and point totals come
 * from them (a level set counts for neither side); without, the typed totals.
 */
export function effectiveResult(r: Result | undefined): Result | undefined {
  if (!hasSets(r)) return r
  let home = 0
  let away = 0
  let homePoints = 0
  let awayPoints = 0
  for (const [h, a] of r.sets) {
    homePoints += h
    awayPoints += a
    if (h > a) home++
    else if (a > h) away++
  }
  return { ...r, home, away, homePoints, awayPoints }
}

/** Sets and points for both teams, or null if anything's missing. */
export function completeResult(r: Result | undefined): CompleteResult | null {
  const e = effectiveResult(r)
  if (!e || !filled(e.home) || !filled(e.away) || !filled(e.homePoints) || !filled(e.awayPoints)) return null
  return { home: e.home, away: e.away, homePoints: e.homePoints, awayPoints: e.awayPoints }
}

/** Sets and points entered for both teams (directly or as set scores). */
export const isComplete = (r: Result | undefined): boolean => completeResult(r) !== null

/** Anything typed in at all. */
export const hasEntry = (r: Result | undefined) => !!r && ([r.home, r.away, r.homePoints, r.awayPoints].some(filled) || hasSets(r))

/** Who won on sets. */
export function outcome(r: Result | undefined): 'home' | 'away' | 'draw' | null {
  const e = effectiveResult(r)
  if (!e || !filled(e.home) || !filled(e.away)) return null
  return e.home > e.away ? 'home' : e.away > e.home ? 'away' : 'draw'
}

const setsKey = (r: Result | undefined) => JSON.stringify(r?.sets ?? [])

export const sameResult = (a: Result | undefined, b: Result | undefined) =>
  (a?.home ?? null) === (b?.home ?? null) &&
  (a?.away ?? null) === (b?.away ?? null) &&
  (a?.homePoints ?? null) === (b?.homePoints ?? null) &&
  (a?.awayPoints ?? null) === (b?.awayPoints ?? null) &&
  setsKey(a) === setsKey(b)

/** Why a list of set scores isn't valid, or null if it is. */
export function setScoresProblem(sets: SetScore[] | undefined, maxSets = MAX_SETS): string | null {
  if (!sets) return null
  if (sets.length > maxSets) return `A match has at most ${maxSets} sets.`
  if (sets.some((set) => set.some((p) => !Number.isInteger(p) || p < 0))) return 'Set scores must be whole numbers, 0 or more.'
  return null
}

/** "25-21, 19-25", or '' without set scores. */
export const setScoresText = (r: Result | undefined) => (r?.sets ?? []).map(([h, a]) => `${h}-${a}`).join(', ')

export type Standing = {
  teamId: string
  played: number
  won: number
  drawn: number
  lost: number
  setsFor: number
  setsAgainst: number
  pointsFor: number
  pointsAgainst: number
  /** Ladder points. */
  points: number
}

/**
 * The ladder from published round-robin results. Ties go to set difference,
 * then points difference, then wins, then name, so the order is always stable.
 */
export function standings(s: Settings, weeks: Week[]): Standing[] {
  const pts = s.points ?? DEFAULT_POINTS
  const rows = new Map<string, Standing>(
    s.teams.map((t) => [
      t.id,
      { teamId: t.id, played: 0, won: 0, drawn: 0, lost: 0, setsFor: 0, setsAgainst: 0, pointsFor: 0, pointsAgainst: 0, points: 0 },
    ]),
  )
  for (const w of weeks) {
    if (w.kind !== 'regular') continue
    for (const g of w.games) {
      const r = completeResult(g.publishedResult)
      if (!r || !isTeam(g.home) || !isTeam(g.away)) continue
      const sides = [
        [rows.get(g.home.team), r.home, r.away, r.homePoints, r.awayPoints],
        [rows.get(g.away.team), r.away, r.home, r.awayPoints, r.homePoints],
      ] as const
      for (const [row, sf, sa, pf, pa] of sides) {
        if (!row) continue
        row.played++
        row.setsFor += sf
        row.setsAgainst += sa
        row.pointsFor += pf
        row.pointsAgainst += pa
        if (sf > sa) {
          row.won++
          row.points += pts.win
        } else if (sf < sa) {
          row.lost++
          row.points += pts.loss
        } else {
          row.drawn++
          row.points += pts.draw
        }
      }
    }
  }
  const name = (id: string) => s.teams.find((t) => t.id === id)?.name ?? ''
  return [...rows.values()].sort(
    (a, b) =>
      b.points - a.points ||
      b.setsFor - b.setsAgainst - (a.setsFor - a.setsAgainst) ||
      b.pointsFor - b.pointsAgainst - (a.pointsFor - a.pointsAgainst) ||
      b.won - a.won ||
      name(a.teamId).localeCompare(name(b.teamId)),
  )
}

/** The ladder's Ratio column: P+ ÷ (P+ + P−), as on tempevb.com. null before any points. */
export function ratio(row: Pick<Standing, 'pointsFor' | 'pointsAgainst'>): number | null {
  const total = row.pointsFor + row.pointsAgainst
  return total > 0 ? row.pointsFor / total : null
}

/** "0.558", as the old ladder shows it; '' before any points. */
export const formatRatio = (r: number | null) => (r === null ? '' : r.toFixed(3))

/** Published results so far. */
export function progress(weeks: Week[]) {
  const count = (kinds: Week['kind'][]) => {
    const games = weeks.filter((w) => kinds.includes(w.kind)).flatMap((w) => w.games)
    return { done: games.filter((g) => isComplete(g.publishedResult)).length, total: games.length }
  }
  return { regular: count(['regular']), finals: count(['semi', 'final']) }
}

/** Every match day's results are published. */
export function isFinished(weeks: Week[]): boolean {
  const games = weeks.flatMap((w) => w.games)
  return games.length > 0 && games.every((g) => isComplete(g.publishedResult))
}

/** The last round-robin match day with published results, or 0. */
export function lastPublishedMatchDay(weeks: Week[]): number {
  return Math.max(
    0,
    ...weeks.filter((w) => w.kind === 'regular' && w.games.some((g) => isComplete(g.publishedResult))).map((w) => w.matchDay),
  )
}

// ---------------------------------------------------------------------------
// Ladder heading ("Week 4 of 9", "Updated 16/10/2026"), generated, never typed.

/**
 * Where the ladder is up to: the last round-robin match day with published
 * results, out of the season's round-robin match days (finals and weeks off
 * don't count). null for a season with no round robin.
 */
export function ladderWeek(weeks: Week[]): { week: number; of: number } | null {
  const of = weeks.filter((w) => w.kind === 'regular').length
  return of > 0 ? { week: lastPublishedMatchDay(weeks), of } : null
}

/** "Week 4 of 9"; null until the first results are published. */
export function ladderWeekLabel(weeks: Week[]): string | null {
  const lw = ladderWeek(weeks)
  return lw && lw.week > 0 ? `Week ${lw.week} of ${lw.of}` : null
}

/**
 * The ladder's heading word: "Final standings" once the season is over (every match day's results published, or at
 * least every round-robin one, since the ladder counts only those), otherwise "Ladder".
 */
export function ladderTitle(weeks: Week[]): 'Final standings' | 'Ladder' {
  if (isFinished(weeks)) return 'Final standings'
  const games = weeks.filter((w) => w.kind === 'regular').flatMap((w) => w.games)
  return games.length > 0 && games.every((g) => isComplete(g.publishedResult)) ? 'Final standings' : 'Ladder'
}

/** The latest results publish of any match day (UTC ISO), or null. */
export function lastResultsPublishedAt(weeks: Week[]): string | null {
  const times = weeks.map((w) => w.resultsPublishedAt).filter((t): t is string => !!t)
  return times.length ? times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null
}

/** "Updated 16/10/2026" (Sydney date of the last results publish); null if never published. */
export function ladderUpdatedLabel(weeks: Week[]): string | null {
  const at = lastResultsPublishedAt(weeks)
  return at ? `Updated ${formatAU(sydneyDateTime(new Date(at)).slice(0, 10))}` : null
}

export type WeekResultsState = 'empty' | 'entering' | 'ready' | 'published' | 'changed'

/** Where a match day is in the enter → publish → (edit → republish) cycle. */
export function weekResultsState(w: Week): WeekResultsState {
  const published = w.games.length > 0 && w.games.every((g) => isComplete(g.publishedResult))
  if (published) return w.games.every((g) => sameResult(g.result, g.publishedResult)) ? 'published' : 'changed'
  if (w.games.length > 0 && w.games.every((g) => isComplete(g.result))) return 'ready'
  return w.games.some((g) => hasEntry(g.result)) ? 'entering' : 'empty'
}

/** Why a match day's results can't be published yet, or null if they can. */
export function publishProblem(w: Week): string | null {
  const missing = w.games.filter((g) => !isComplete(g.result)).length
  if (missing)
    return `Enter sets and points for ${missing === w.games.length ? 'every game' : `the ${missing} remaining game${missing > 1 ? 's' : ''}`} to publish.`
  for (const g of w.games) {
    const problem = setScoresProblem(g.result?.sets)
    if (problem) return `${g.title ?? 'A game'}: ${problem}`
  }
  if (w.kind !== 'regular') {
    const draw = w.games.find((g) => outcome(g.result) === 'draw')
    if (draw) return `${draw.title ?? 'A finals game'} is a draw, but finals need a winner.`
  }
  return null
}

const FINALS_GAME: Record<string, string> = { SF1: 'Semi Final 1', SF2: 'Semi Final 2', GF: 'Grand Final' }
const SEEDS = ['1st', '2nd', '3rd', '4th']

/**
 * Turns finals placeholders into teams as results are published: "1st"–"4th"
 * once every round-robin result is published, and "Winner/Loser SF1" etc. once
 * that game's result is. Anything not yet known stays a placeholder.
 */
export function makeResolver(s: Settings, weeks: Week[]): (r: Ref | null) => Ref | null {
  const p = progress(weeks).regular
  const table = p.total > 0 && p.done === p.total ? standings(s, weeks) : null
  const finals = weeks.filter((w) => w.kind === 'semi' || w.kind === 'final').flatMap((w) => w.games)

  const resolve = (r: Ref | null, depth = 0): Ref | null => {
    if (!r || isTeam(r) || depth > 4) return r
    const seed = SEEDS.indexOf(r.label)
    if (seed >= 0) {
      const row = table?.[seed]
      return row ? { team: row.teamId } : r
    }
    const m = /^(Winner|Loser) (SF1|SF2|GF)$/.exec(r.label)
    const game = m && finals.find((g) => g.title === FINALS_GAME[m[2]!])
    if (!m || !game) return r
    const home = resolve(game.home, depth + 1)
    const away = resolve(game.away, depth + 1)
    const o = isComplete(game.publishedResult) ? outcome(game.publishedResult) : null
    if (!isTeam(home) || !isTeam(away) || !o || o === 'draw') return r
    return (m[1] === 'Winner') === (o === 'home') ? home : away
  }
  return (r) => resolve(r)
}
