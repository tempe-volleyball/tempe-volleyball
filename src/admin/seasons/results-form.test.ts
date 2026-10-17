import { describe, expect, it } from 'vitest'
import { demoCompetition, setResult, withGenerated } from '../../lib/fixtures'
import { changedResults, formFromResult, resultFromForm, type ResultForm } from './results-form'

const sets = (...rows: [string, string][]): ResultForm => ({ mode: 'sets', sets: rows, totals: ['', '', '', ''] })

describe('formFromResult', () => {
  it('has one row per set the season plays', () => {
    expect(formFromResult(undefined, 2).sets).toEqual([
      ['', ''],
      ['', ''],
    ])
    expect(formFromResult(undefined, 5).sets).toHaveLength(5)
    expect(formFromResult(undefined, 2).mode).toBe('sets')
  })

  it('fills in set scores', () => {
    const f = formFromResult(
      {
        home: 1,
        away: 1,
        sets: [
          [25, 20],
          [18, 25],
        ],
      },
      2,
    )
    expect(f.sets).toEqual([
      ['25', '20'],
      ['18', '25'],
    ])
  })

  it('uses totals for a result recorded without set scores', () => {
    const f = formFromResult({ home: 2, away: 0, homePoints: 50, awayPoints: 31 }, 2)
    expect(f.mode).toBe('totals')
    expect(f.totals).toEqual(['2', '0', '50', '31'])
  })
})

describe('resultFromForm', () => {
  it('derives sets won and points from set scores', () => {
    expect(resultFromForm(sets(['25', '20'], ['18', '25']))).toEqual({
      result: {
        home: 1,
        away: 1,
        homePoints: 43,
        awayPoints: 45,
        sets: [
          [25, 20],
          [18, 25],
        ],
      },
      problem: null,
    })
  })

  it('a best of 5 can stop after 3 sets', () => {
    const r = resultFromForm(sets(['25', '20'], ['25', '18'], ['25', '10'], ['', ''], ['', '']))
    expect(r.problem).toBeNull()
    expect(r.result).toMatchObject({ home: 3, away: 0 })
    expect(r.result?.sets).toHaveLength(3)
  })

  it('is blank when nothing is typed', () => {
    expect(resultFromForm(sets(['', ''], ['', '']))).toEqual({ result: undefined, problem: null })
    expect(resultFromForm({ mode: 'totals', sets: [], totals: ['', '', '', ''] })).toEqual({ result: undefined, problem: null })
  })

  it('flags half-typed and out-of-order sets', () => {
    expect(resultFromForm(sets(['25', ''], ['', ''])).problem).toMatch(/Set 1: enter both/)
    expect(resultFromForm(sets(['', ''], ['25', '20'])).problem).toMatch(/Set 1 is blank but set 2/)
    expect(resultFromForm(sets(['125', '20'], ['', ''])).problem).toMatch(/over 99/)
  })

  it('reads totals', () => {
    expect(resultFromForm({ mode: 'totals', sets: [], totals: ['2', '0', '50', ''] })).toEqual({
      result: { home: 2, away: 0, homePoints: 50, awayPoints: null },
      problem: null,
    })
  })
})

describe('changedResults', () => {
  it('lists only the games that changed, with null for a cleared one', () => {
    const w = withGenerated(demoCompetition()).weeks![0]!
    const [a, b] = w.games
    const saved = setResult([w], w.id, a!.id, { home: 2, away: 0, homePoints: 50, awayPoints: 30 })[0]!
    let edited = setResult([saved], w.id, a!.id, { home: null, away: null })[0]!
    edited = setResult([edited], w.id, b!.id, { home: 1, away: 1, homePoints: 45, awayPoints: 45 })[0]!
    expect(changedResults(saved, edited)).toEqual({ [a!.id]: null, [b!.id]: { home: 1, away: 1, homePoints: 45, awayPoints: 45 } })
    expect(changedResults(saved, saved)).toEqual({})
  })
})
