import { describe, expect, it } from 'vitest'
import { groupOf, leagueWindow, matchesSearch } from './groups'

const seasons = [
  { id: 'q2', startDate: '2026-04-02' },
  { id: 'q4', startDate: '2026-10-08' },
  { id: 'q3', startDate: '2026-07-09' },
  { id: 'q1-27', startDate: '2027-01-14' },
]

describe('leagueWindow', () => {
  it('building a season: the latest season before it', () => {
    expect(leagueWindow(seasons, { targetId: 'q1-27', today: '2026-10-20' })).toEqual({ lastSeasonId: 'q4', interestSince: '2026-10-08' })
    expect(leagueWindow(seasons, { targetId: 'q2', today: '2026-10-20' })).toEqual({ lastSeasonId: null, interestSince: null })
  })
  it('no target: the latest season that has started', () => {
    expect(leagueWindow(seasons, { today: '2026-10-20' })).toEqual({ lastSeasonId: 'q4', interestSince: '2026-10-08' })
    expect(leagueWindow(seasons, { today: '2026-10-07' })).toEqual({ lastSeasonId: 'q3', interestSince: '2026-07-09' })
    expect(leagueWindow([], { today: '2026-10-07' })).toEqual({ lastSeasonId: null, interestSince: null })
  })
})

describe('groupOf', () => {
  const w = { lastSeasonId: 'q4', interestSince: '2026-10-08' }
  const base = { retiredAt: null, leagueSeasonIds: [], playedElsewhere: false, openInterestDates: [] }
  it('retired wins', () => {
    expect(groupOf({ ...base, retiredAt: '2026-01-01T00:00:00Z', openInterestDates: ['2026-10-10'] }, w)).toBe('retired')
  })
  it('new interest: an open EOI since the last season started', () => {
    expect(groupOf({ ...base, openInterestDates: ['2026-10-09T01:00:00.000Z'] }, w)).toBe('interest')
    expect(groupOf({ ...base, openInterestDates: ['2026-10-08T00:00:00.000Z'] }, w)).toBe('interest')
    expect(groupOf({ ...base, openInterestDates: ['2026-09-01T00:00:00.000Z'] }, w)).toBe('other')
    expect(groupOf({ ...base, openInterestDates: ['2020-01-01'] }, { lastSeasonId: null, interestSince: null })).toBe('interest')
  })
  it('last season, then past', () => {
    expect(groupOf({ ...base, leagueSeasonIds: ['q3', 'q4'] }, w)).toBe('last')
    expect(groupOf({ ...base, leagueSeasonIds: ['q2'] }, w)).toBe('past')
    expect(groupOf({ ...base, playedElsewhere: true }, w)).toBe('past')
    expect(groupOf(base, w)).toBe('other')
  })
  it("the target season's own roster doesn't count", () => {
    expect(groupOf({ ...base, leagueSeasonIds: ['q1-27'] }, w, 'q1-27')).toBe('other')
    expect(groupOf({ ...base, leagueSeasonIds: ['q1-27', 'q4'] }, w, 'q1-27')).toBe('last')
  })
})

describe('matchesSearch', () => {
  const p = { firstName: 'Zoë', lastName: 'Lee', email: 'zoe@example.com', phone: '0412 345 678' }
  it('matches every word against name, email and phone', () => {
    expect(matchesSearch(p, 'zoe l')).toBe(true)
    expect(matchesSearch(p, '0412345')).toBe(true)
    expect(matchesSearch(p, 'zoe smith')).toBe(false)
    expect(matchesSearch(p, '  ')).toBe(true)
  })
})
