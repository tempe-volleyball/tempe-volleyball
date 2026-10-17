import { describe, expect, it } from 'vitest'
import {
  defaultLeagueTab,
  filterFixtureRows,
  fixtureQueryString,
  leagueCalendarPath,
  parseFixtureQuery,
  splitFixtures,
  teamCalendarPath,
  weekRange,
} from './fixture-lists'

const weeks = [
  { date: '2026-10-01', kind: 'regular', resultsPublishedAt: '2026-10-02T00:00:00Z' },
  { date: '2026-10-08', kind: 'skip' },
  { date: '2026-10-15', kind: 'regular' },
  { date: '2026-10-22', kind: 'final' },
]

describe('defaultLeagueTab', () => {
  it('opens on the fixtures before the first game night and with no draw', () => {
    expect(defaultLeagueTab([], '2026-10-01')).toBe('fixtures')
    expect(defaultLeagueTab([{ date: '2026-10-01', kind: 'skip' }], '2026-09-01')).toBe('fixtures')
    expect(defaultLeagueTab(weeks.slice(2), '2026-10-14')).toBe('fixtures')
  })
  it('opens on the ladder from the first night on, and once results are out', () => {
    expect(defaultLeagueTab(weeks.slice(2), '2026-10-15')).toBe('ladder')
    expect(defaultLeagueTab(weeks, '2026-09-01')).toBe('ladder')
    expect(defaultLeagueTab(weeks, '2027-01-01')).toBe('ladder')
  })
})

describe('splitFixtures', () => {
  const rows = [
    { date: '2026-10-01', key: 'a' },
    { date: '2026-10-01', key: 'b' },
    { date: '2026-10-08', key: 'skip' },
    { date: '2026-10-15', key: 'c' },
    { date: '2026-10-22', key: 'd' },
  ]
  it('puts past and published nights under results, latest night first, keeping each night in order', () => {
    const { upcoming, played } = splitFixtures(rows, weeks, '2026-10-15')
    expect(upcoming.map((r) => r.key)).toEqual(['c', 'd'])
    expect(played.map((r) => r.key)).toEqual(['skip', 'a', 'b'])
  })
  it('moves tonight to results the moment it is published', () => {
    const published = weeks.map((w) => (w.date === '2026-10-15' ? { ...w, resultsPublishedAt: '2026-10-15T12:00:00Z' } : w))
    const { upcoming, played } = splitFixtures(rows, published, '2026-10-15')
    expect(upcoming.map((r) => r.key)).toEqual(['d'])
    expect(played.map((r) => r.key)).toEqual(['c', 'skip', 'a', 'b'])
  })
})

describe('weekRange', () => {
  it('is Monday to Sunday around today', () => {
    expect(weekRange('2026-10-18')).toEqual({ from: '2026-10-12', to: '2026-10-18' }) // a Sunday
    expect(weekRange('2026-10-19')).toEqual({ from: '2026-10-19', to: '2026-10-25' }) // a Monday
    expect(weekRange('2026-10-22')).toEqual({ from: '2026-10-19', to: '2026-10-25' })
  })
})

describe('fixture list query', () => {
  it('parses and tolerates junk', () => {
    expect(parseFixtureQuery(new URLSearchParams('view=upcoming&league=TNL&team=ice-cold'))).toEqual({
      view: 'upcoming',
      league: 'tnl',
      team: 'ice-cold',
    })
    expect(parseFixtureQuery(new URLSearchParams('view=all&league=../x&team=' + 'a'.repeat(101)))).toEqual({
      view: 'week',
      league: '',
      team: '',
    })
  })
  it('round-trips with defaults left out', () => {
    expect(fixtureQueryString({ view: 'week', league: '', team: '' })).toBe('')
    expect(fixtureQueryString({ view: 'upcoming', league: 'tnl' })).toBe('?view=upcoming&league=tnl')
    const q = { view: 'upcoming' as const, league: 'fnl', team: 'aces' }
    expect(parseFixtureQuery(new URLSearchParams(fixtureQueryString(q).slice(1)))).toEqual(q)
  })
})

describe('filterFixtureRows', () => {
  const t = (home: string | null, away: string | null, duty: string | null) => ({ home, away, duty })
  const rows = [
    { date: '2026-10-15', kind: 'game', teamIds: t('a', 'b', 'c') },
    { date: '2026-10-15', kind: 'bye', teamIds: t('d', null, null) },
    { date: '2026-10-16', kind: 'skip', teamIds: t(null, null, null) },
    { date: '2026-10-22', kind: 'game', teamIds: t('c', 'd', 'a') },
  ]
  it('keeps games and byes in the range, never weeks off', () => {
    expect(filterFixtureRows(rows, { from: '2026-10-15', to: '2026-10-21' })).toHaveLength(2)
    expect(filterFixtureRows(rows, { from: '2026-10-16', to: null })).toHaveLength(1)
  })
  it("keeps a team's games, byes and duties", () => {
    expect(filterFixtureRows(rows, { from: '2026-01-01', to: null, teamId: 'a' })).toHaveLength(2)
    expect(filterFixtureRows(rows, { from: '2026-01-01', to: null, teamId: 'd' })).toHaveLength(2)
    expect(filterFixtureRows(rows, { from: '2026-01-01', to: null, teamId: 'zz' })).toHaveLength(0)
  })
})

it('builds calendar paths', () => {
  expect(leagueCalendarPath('tnl')).toBe('/leagues/tnl/calendar.ics')
  expect(teamCalendarPath('tnl', 'ice-cold')).toBe('/leagues/tnl/teams/ice-cold.ics')
})
