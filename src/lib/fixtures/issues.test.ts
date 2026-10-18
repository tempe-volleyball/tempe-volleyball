import { describe, expect, it } from 'vitest'
import { groupIssues, matchDaysText, type Issue } from './analysis'
import { suggestCatchUpDate } from './move'
import type { Week } from './types'

const week = (id: string, matchDay: number): Week => ({ id, kind: 'regular', date: '2026-10-01', matchDay, games: [] })

describe('groupIssues', () => {
  it('groups the same message across nights, keeping first-seen order', () => {
    const weeks = [week('a', 1), week('b', 2), week('c', 3)]
    const issues: Issue[] = [
      { level: 'warning', weekId: 'a', message: 'Match day 1: a game has no duty team.' },
      { level: 'warning', weekId: 'a', message: 'Match day 1: a game has no duty team.' },
      { level: 'error', weekId: 'b', message: 'Match day 2: KBU is playing 2 games.' },
      { level: 'warning', weekId: 'c', message: 'Match day 3: a game has no duty team.' },
      { level: 'warning', message: 'Should meet 1× but don’t: A v B (2×).' },
    ]
    expect(groupIssues(issues, weeks)).toEqual([
      { level: 'warning', message: 'A game has no duty team.', count: 3, weekIds: ['a', 'c'], matchDays: [1, 3] },
      { level: 'error', message: 'KBU is playing 2 games.', count: 1, weekIds: ['b'], matchDays: [2] },
      { level: 'warning', message: 'Should meet 1× but don’t: A v B (2×).', count: 1, weekIds: [], matchDays: [] },
    ])
  })
})

describe('suggestCatchUpDate', () => {
  const w = (date: string, kind: Week['kind'] = 'regular'): Week => ({ id: date, kind, date, matchDay: 1, games: [] })
  it('picks the first free week before the finals', () => {
    const weeks = [w('2026-10-01'), w('2026-10-08'), w('2026-10-22'), w('2026-10-29', 'semi'), w('2026-11-05', 'final')]
    expect(suggestCatchUpDate(weeks, '2026-10-01')).toEqual({ date: '2026-10-15', beforeFinals: true })
  })
  it('falls back to after the season when no week before the finals is free', () => {
    const weeks = [w('2026-10-01'), w('2026-10-08'), w('2026-10-15', 'skip'), w('2026-10-22', 'semi'), w('2026-10-29', 'final')]
    expect(suggestCatchUpDate(weeks, '2026-10-01')).toEqual({ date: '2026-11-05', beforeFinals: false })
    // No finals: the week after the last night counts as "before the finals".
    expect(suggestCatchUpDate([w('2026-10-01'), w('2026-10-08')], '2026-10-01')).toEqual({ date: '2026-10-15', beforeFinals: true })
  })
})

describe('matchDaysText', () => {
  it('writes runs as ranges and joins the last with "and"', () => {
    expect(matchDaysText([])).toBe('')
    expect(matchDaysText([4])).toBe('match day 4')
    expect(matchDaysText([2, 1])).toBe('match days 1 and 2')
    expect(matchDaysText([1, 2, 3, 4, 6, 8, 9])).toBe('match days 1–4, 6, 8 and 9')
  })
})
