import { describe, expect, it } from 'vitest'
import { compareLadders, computeLadder, outcomeTable, tableRow, type LadderGame } from './ladder'
import type { MappedResult } from './results'

const res = (homeSets: number, awaySets: number, homePoints: number, awayPoints: number): MappedResult => ({
  homeSets,
  awaySets,
  homePoints,
  awayPoints,
  setScores: null,
  setScoresDropped: false,
  forfeit: false,
})

const teams = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
  { id: 'c', name: 'C' },
]

const games: LadderGame[] = [
  { date: '2026-10-01', regular: true, homeTeam: 'a', awayTeam: 'b', result: res(2, 0, 50, 40) },
  { date: '2026-10-08', regular: true, homeTeam: 'b', awayTeam: 'c', result: res(1, 1, 45, 45) },
  { date: '2026-10-15', regular: true, homeTeam: 'a', awayTeam: 'c', result: null },
  // Finals never count on the ladder.
  { date: '2026-10-22', regular: false, homeTeam: 'a', awayTeam: 'b', result: res(0, 2, 30, 50) },
]

describe('computeLadder', () => {
  it('uses the fixtures library rules (win 3, draw 2, loss 1)', () => {
    const table = computeLadder(teams, games)
    expect(table.map((r) => [r.teamId, r.points, r.played])).toEqual([
      ['a', 3, 1],
      ['b', 3, 2],
      ['c', 2, 1],
    ])
  })
})

describe('compareLadders', () => {
  it('reports the points to adjust and every differing column', () => {
    const computed = computeLadder(teams, games)
    const sp = [
      tableRow('a', { pts: '3', p: '1', w: '1', d: '0', l: '0', s: '2', stwo: '0', pw: '50', pl: '40' }),
      tableRow('b', { pts: '1', p: '2', w: '0', d: '1', l: '1', s: '1', stwo: '3', pw: '85', pl: '95' }), // 2 points docked
      tableRow('c', { pts: '2', p: '1', w: '0', d: '1', l: '0', s: '1', stwo: '1', pw: '45', pl: '45' }),
    ]
    expect(compareLadders(computed, sp)).toEqual([{ teamId: 'b', pointsDiff: -2, fields: [['pts', 1, 3]] }])
  })

  it('treats a team missing from the table as zeros', () => {
    const computed = computeLadder(teams, games)
    const diffs = compareLadders(computed, [])
    expect(diffs.map((d) => [d.teamId, d.pointsDiff])).toEqual([
      ['a', -3],
      ['b', -3],
      ['c', -2],
    ])
  })
})

describe('outcomeTable', () => {
  it('counts SportsPress draw-on-sets outcomes by points', () => {
    const og = (g: LadderGame, homeOutcome: string | null, awayOutcome: string | null) => ({ ...g, homeOutcome, awayOutcome })
    const rows = outcomeTable(
      ['a', 'b', 'c'],
      [og(games[0]!, 'win', 'loss'), og(games[1]!, 'drawl', 'draww'), og(games[2]!, null, null), og(games[3]!, 'loss', 'win')],
    )
    expect(rows.map((r) => [r.teamId, r.pts, r.w, r.d, r.l])).toEqual([
      ['a', 3, 1, 0, 0],
      ['b', 2, 0, 0, 2],
      ['c', 3, 1, 0, 0],
    ])
  })
})
