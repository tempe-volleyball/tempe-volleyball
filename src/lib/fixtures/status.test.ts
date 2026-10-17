import { describe, expect, it } from 'vitest'
import { withGenerated } from './competition'
import { demoCompetition } from './demo'
import { publishWeekResults, setResult } from './edit'
import { dayPublishProblem, dayResultsState, withoutCancelled } from './status'
import type { Result, Week } from './types'

const r = (home: number, away: number): Result => ({ home, away, homePoints: 25 * home + 20 * away, awayPoints: 25 * away + 20 * home })
const firstWeek = (): Week => withGenerated(demoCompetition()).weeks![0]!
const enterAll = (w: Week, except: string[] = []): Week =>
  w.games.filter((g) => !except.includes(g.id)).reduce((ws, g) => setResult(ws, w.id, g.id, r(2, 0)), [w])[0]!

describe('cancelled games', () => {
  it('leaves cancelled games out', () => {
    const w = firstWeek()
    const gone = w.games[0]!.id
    expect(withoutCancelled(w, new Set([gone])).games.map((g) => g.id)).not.toContain(gone)
    expect(withoutCancelled(w, new Set())).toBe(w)
  })

  it('a cancelled game without a result does not block publishing', () => {
    const w = firstWeek()
    const gone = w.games[0]!.id
    const entered = enterAll(w, [gone])
    expect(dayPublishProblem(entered, new Set())).toMatch(/remaining game/)
    expect(dayPublishProblem(entered, new Set([gone]))).toBeNull()
    expect(dayResultsState(entered, new Set([gone]))).toBe('ready')
  })

  it('a night where every game was cancelled can be published, and then reads as published', () => {
    const w = firstWeek()
    const all = new Set(w.games.map((g) => g.id))
    expect(dayPublishProblem(w, all)).toBeNull()
    expect(dayResultsState(w, all)).toBe('ready')
    expect(dayResultsState({ ...w, resultsPublishedAt: '2027-02-04T11:00:00.000Z' }, all)).toBe('published')
  })

  it('cancelling a game whose result was published counts as a change until republished', () => {
    const start = firstWeek()
    const w = publishWeekResults([enterAll(start)], start.id)[0]!
    expect(dayResultsState(w, new Set())).toBe('published')
    const gone = w.games[0]!.id
    const cleared = setResult([w], w.id, gone, { home: null, away: null })[0]!
    expect(dayResultsState(cleared, new Set([gone]))).toBe('changed')
    const republished = publishWeekResults([cleared], w.id)[0]!
    expect(dayResultsState(republished, new Set([gone]))).toBe('published')
  })
})
