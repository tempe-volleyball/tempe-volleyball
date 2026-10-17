import type { SetScore } from '../fixtures'

// SportsPress keeps a match's result per team in event.results[<team id>]: `s` (sets won), `one`…`five` (rally
// points per set) and `points` (total). Values are strings, '' when not entered. (event.performance holds per-player
// stats and is empty on this site.)

export type SpResultRow = {
  s?: string
  one?: string
  two?: string
  three?: string
  four?: string
  five?: string
  points?: string
}

export type MappedResult = {
  homeSets: number
  awaySets: number
  homePoints: number
  awayPoints: number
  /**
   * Set-by-set scores, or null when there were none or they disagree with the recorded sets/points (social leagues
   * play a short, time-capped third set that SportsPress doesn't always count as a set; storing those scores would
   * make the fixtures library re-derive a different result).
   */
  setScores: SetScore[] | null
  /** True when set scores existed but were dropped because they disagree with `s`/`points`. */
  setScoresDropped: boolean
  /** One side scored nothing at all: a walkover. */
  forfeit: boolean
}

const SET_KEYS = ['one', 'two', 'three', 'four', 'five'] as const

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string' || v.trim() === '') return null
  const n = Number(v.trim())
  return Number.isInteger(n) && n >= 0 ? n : null
}

const row = (results: unknown, teamId: number): SpResultRow | null => {
  if (!results || typeof results !== 'object') return null
  const r = (results as Record<string, unknown>)[String(teamId)]
  return r && typeof r === 'object' && !Array.isArray(r) ? (r as SpResultRow) : null
}

/** The published result of a SportsPress event, home first, or null if nothing was entered. */
export function mapEventResult(results: unknown, homeId: number, awayId: number): MappedResult | null {
  const h = row(results, homeId)
  const a = row(results, awayId)
  if (!h || !a) return null

  const sets: SetScore[] = []
  for (const k of SET_KEYS) {
    const hp = num(h[k])
    const ap = num(a[k])
    if (hp === null && ap === null) continue
    sets.push([hp ?? 0, ap ?? 0])
  }
  while (sets.length > 0 && sets.at(-1)![0] === 0 && sets.at(-1)![1] === 0) sets.pop()

  let dh = 0
  let da = 0
  let ph = 0
  let pa = 0
  for (const [x, y] of sets) {
    ph += x
    pa += y
    if (x > y) dh++
    else if (y > x) da++
  }

  const hs = num(h.s)
  const as = num(a.s)
  const hpts = num(h.points)
  const apts = num(a.points)
  if (hs === null && as === null && hpts === null && apts === null && sets.length === 0) return null

  const homeSets = hs ?? (sets.length ? dh : 0)
  const awaySets = as ?? (sets.length ? da : 0)
  const homePoints = hpts ?? ph
  const awayPoints = apts ?? pa
  const consistent = sets.length > 0 && dh === homeSets && da === awaySets && ph === homePoints && pa === awayPoints

  return {
    homeSets,
    awaySets,
    homePoints,
    awayPoints,
    setScores: consistent ? sets : null,
    setScoresDropped: sets.length > 0 && !consistent,
    forfeit: (homePoints === 0) !== (awayPoints === 0),
  }
}
