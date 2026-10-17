import { describe, expect, it } from 'vitest'
import { mapEventResult } from './results'

const header = { s: 'S', one: '1', two: '2', points: 'T' }

describe('mapEventResult', () => {
  it('maps a two-set social result, home first', () => {
    const results = {
      0: header,
      765: { s: '0', one: '21', two: '22', three: '', four: '', five: '', points: '43', outcome: ['loss'] },
      3499: { s: '2', one: '25', two: '25', three: '', four: '', five: '', points: '50', outcome: ['win'] },
    }
    expect(mapEventResult(results, 3499, 765)).toEqual({
      homeSets: 2,
      awaySets: 0,
      homePoints: 50,
      awayPoints: 43,
      setScores: [
        [25, 21],
        [25, 22],
      ],
      setScoresDropped: false,
      forfeit: false,
    })
  })

  it('maps five-set TVSL results', () => {
    const r = mapEventResult(
      {
        1: { s: '3', one: '22', two: '25', three: '25', four: '29', five: '', points: '101' },
        2: { s: '1', one: '25', two: '13', three: '17', four: '27', points: '82' },
      },
      1,
      2,
    )
    expect(r).toMatchObject({ homeSets: 3, awaySets: 1, homePoints: 101, awayPoints: 82 })
    expect(r?.setScores).toHaveLength(4)
  })

  it('keeps SportsPress sets but drops set scores that disagree (time-capped third set)', () => {
    // 25-21, 22-25, 0-7: SportsPress says 1-1 (the short third set didn't count as a set).
    const r = mapEventResult(
      { 1: { s: '1', one: '25', two: '22', three: '0', points: '47' }, 2: { s: '1', one: '21', two: '25', three: '7', points: '53' } },
      1,
      2,
    )
    expect(r).toMatchObject({ homeSets: 1, awaySets: 1, homePoints: 47, awayPoints: 53, setScores: null, setScoresDropped: true })
  })

  it('keeps a counted third set', () => {
    const r = mapEventResult(
      { 1: { s: '1', one: '25', two: '15', three: '8', points: '48' }, 2: { s: '2', one: '21', two: '25', three: '12', points: '58' } },
      1,
      2,
    )
    expect(r?.setScores).toEqual([
      [25, 21],
      [15, 25],
      [8, 12],
    ])
  })

  it('flags walkovers', () => {
    const r = mapEventResult({ 1: { s: '0', one: '0', two: '0', points: '0' }, 2: { s: '2', one: '25', two: '25', points: '50' } }, 1, 2)
    expect(r).toMatchObject({ forfeit: true, homeSets: 0, awaySets: 2 })
  })

  it('returns null when nothing was entered', () => {
    expect(
      mapEventResult({ 0: [], 1: { s: '', one: '', two: '', points: '' }, 2: { s: '', one: '', two: '', points: '' } }, 1, 2),
    ).toBeNull()
    expect(mapEventResult({ 0: [], '-1': [] }, -1, -1)).toBeNull()
    expect(mapEventResult([], 1, 2)).toBeNull()
  })

  it('derives totals from set scores when they are missing', () => {
    expect(mapEventResult({ 1: { one: '25', two: '25' }, 2: { one: '20', two: '23' } }, 1, 2)).toMatchObject({
      homeSets: 2,
      awaySets: 0,
      homePoints: 50,
      awayPoints: 43,
    })
  })
})
