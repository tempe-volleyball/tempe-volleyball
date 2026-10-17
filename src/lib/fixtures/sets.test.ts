import { describe, expect, it } from 'vitest'
import { withGenerated } from './competition'
import { demoCompetition } from './demo'
import { publishWeekResults, setResult } from './edit'
import { fullCsv } from './export'
import {
  completeResult,
  effectiveResult,
  formatRatio,
  hasEntry,
  isComplete,
  outcome,
  publishProblem,
  ratio,
  sameResult,
  setScoresProblem,
  setScoresText,
  standings,
  weekResultsState,
} from './results'
import { isTeam, type Game, type Result } from './types'

const sets = (...s: [number, number][]): Result => ({ home: null, away: null, sets: s })

describe('set-by-set scores', () => {
  it('derive sets won and point totals', () => {
    expect(completeResult(sets([25, 21], [19, 25]))).toEqual({ home: 1, away: 1, homePoints: 44, awayPoints: 46 })
    expect(outcome(sets([25, 21], [19, 25]))).toBe('draw')
    // TVSL, best of 5
    expect(completeResult(sets([25, 20], [23, 25], [25, 18], [26, 24]))).toEqual({ home: 3, away: 1, homePoints: 99, awayPoints: 87 })
    expect(outcome(sets([20, 25], [23, 25], [25, 18], [24, 26]))).toBe('away')
  })

  it('win over typed totals when both are there', () => {
    const r: Result = {
      home: 2,
      away: 0,
      homePoints: 1,
      awayPoints: 1,
      sets: [
        [25, 10],
        [10, 25],
      ],
    }
    expect(effectiveResult(r)).toMatchObject({ home: 1, away: 1, homePoints: 35, awayPoints: 35 })
  })

  it('without set scores, the typed totals still count', () => {
    const r: Result = { home: 2, away: 1, homePoints: 60, awayPoints: 51 }
    expect(effectiveResult(r)).toBe(r)
    expect(completeResult({ ...r, sets: [] })).toEqual(r)
    expect(isComplete({ home: 2, away: 1 })).toBe(false)
  })

  it('count as an entry and as a change', () => {
    expect(hasEntry(sets([25, 20]))).toBe(true)
    expect(hasEntry(sets())).toBe(false)
    expect(sameResult(sets([25, 20]), sets([25, 20]))).toBe(true)
    expect(sameResult(sets([25, 20]), sets([25, 21]))).toBe(false)
  })

  it('are checked: at most 5 sets of whole numbers', () => {
    expect(setScoresProblem([[25, 20]])).toBeNull()
    expect(setScoresProblem(Array.from({ length: 6 }, (): [number, number] => [25, 20]))).toBe('A match has at most 5 sets.')
    expect(setScoresProblem([[25, 20]], 2)).toBeNull()
    expect(
      setScoresProblem(
        [
          [25, 20],
          [20, 25],
          [15, 10],
        ],
        2,
      ),
    ).toBe('A match has at most 2 sets.')
    expect(setScoresProblem([[25, -1]])).toMatch(/whole numbers/)
    expect(setScoresProblem([[25.5, 20]])).toMatch(/whole numbers/)
    expect(setScoresText(sets([25, 21], [19, 25]))).toBe('25-21, 19-25')
    expect(setScoresText({ home: 2, away: 0 })).toBe('')
  })

  it('feed the ladder, the publish check and the export', () => {
    const c = withGenerated(demoCompetition())
    const w = c.weeks![0]!
    const [a, ...rest] = w.games as [Game, ...Game[]]
    let weeks = setResult(c.weeks!, w.id, a.id, sets([25, 21], [25, 23]))
    weeks = rest.reduce((ws, g) => setResult(ws, w.id, g.id, sets([25, 20], [20, 25])), weeks)
    expect(weekResultsState(weeks[0]!)).toBe('ready')
    expect(publishProblem(weeks[0]!)).toBeNull()
    weeks = publishWeekResults(weeks, w.id)

    const team = (g: Game) => (isTeam(g.home) ? g.home.team : '')
    const row = standings(c.settings, weeks).find((t) => t.teamId === team(a))!
    expect(row).toMatchObject({ won: 1, points: 3, setsFor: 2, setsAgainst: 0, pointsFor: 50, pointsAgainst: 44 })
    expect(fullCsv(c.settings, weeks).split('\r\n')[1]).toMatch(/,2 - 0,50 - 44$/)
  })

  it('a bad set score blocks publishing', () => {
    const c = withGenerated(demoCompetition())
    const w = c.weeks![0]!
    const weeks = w.games.reduce((ws, g) => setResult(ws, w.id, g.id, sets([25, 20], [25, -3])), c.weeks!)
    expect(publishProblem(weeks[0]!)).toMatch(/whole numbers/)
  })

  it('clearing every field, sets included, clears the result', () => {
    const c = withGenerated(demoCompetition())
    const w = c.weeks![0]!
    const g = w.games[0]!
    let weeks = setResult(c.weeks!, w.id, g.id, sets([25, 20]))
    expect(weeks[0]!.games[0]!.result).toBeDefined()
    weeks = setResult(weeks, w.id, g.id, sets())
    expect(weeks[0]!.games[0]!.result).toBeUndefined()
  })
})

describe('ratio column', () => {
  it('is P+ ÷ (P+ + P−), shown to 3 places as on the old site', () => {
    // Ice Cold on the TNL ladder: 208 for, 165 against -> 0.558
    expect(formatRatio(ratio({ pointsFor: 208, pointsAgainst: 165 }))).toBe('0.558')
    expect(formatRatio(ratio({ pointsFor: 126, pointsAgainst: 154 }))).toBe('0.450')
    expect(ratio({ pointsFor: 0, pointsAgainst: 0 })).toBeNull()
    expect(formatRatio(null)).toBe('')
  })
})
