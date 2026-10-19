import { describe, expect, it } from 'vitest'
import type { DirectoryPlayer, RosterSources, SourceTeam } from '../api'
import {
  addTeams,
  answerLabel,
  lastSeasonPlan,
  moveActive,
  pendingRoster,
  pickerCounts,
  pickerRows,
  placedMap,
  retiredMatching,
} from './roster-helpers'

const spot = (teamName: string, seasonName: string, startDate: string) => ({
  seasonId: seasonName,
  seasonName,
  startDate,
  leagueId: 'tnl',
  leagueCode: 'TNL',
  teamId: teamName,
  teamName,
})

const p = (id: string, firstName: string, lastName: string, extra: Partial<DirectoryPlayer> = {}): DirectoryPlayer => ({
  id,
  firstName,
  lastName,
  email: `${id}@example.com`,
  phone: null,
  gender: null,
  retiredAt: null,
  group: 'other',
  lastInLeague: null,
  lastAnywhere: null,
  interest: null,
  inSeason: [],
  ...extra,
})

const eoi = (createdAt: string) => ({
  interestId: `i-${createdAt}`,
  reference: 'EOI-AAAA',
  kind: 'player' as const,
  teamName: null,
  status: 'new' as const,
  createdAt,
  level: 'beginner',
  position: null,
})

const people = [
  p('a', 'Zoe', 'Old', { group: 'interest', interest: eoi('2026-10-01T00:00:00Z') }),
  p('b', 'Amy', 'New', { group: 'interest', interest: eoi('2026-10-15T00:00:00Z') }),
  p('c', 'Bo', 'Last', { group: 'last', lastInLeague: spot('Chaos', 'TNL Q3 2026', '2026-07-09') }),
  p('d', 'Al', 'Last', { group: 'last', lastInLeague: spot('Aces', 'TNL Q3 2026', '2026-07-09') }),
  p('e', 'Ed', 'Past', { group: 'past', lastAnywhere: spot('Floaters', 'FNL Q1 2026', '2026-01-09') }),
  p('f', 'Fi', 'Past', { group: 'past', lastInLeague: spot('Aces', 'TNL Q2 2026', '2026-04-09') }),
  p('g', 'Gus', 'Gone', { group: 'retired', retiredAt: '2026-01-01T00:00:00Z' }),
  p('h', 'Hal', 'Other', { phone: '0412 345 678' }),
]

describe('the player picker', () => {
  it('counts each tab, with All leaving out the retired', () => {
    expect(pickerCounts(people)).toEqual({ interest: 2, last: 2, past: 2, retired: 1, all: 7 })
  })

  it('orders each tab its own way', () => {
    const ids = (tab: Parameters<typeof pickerRows>[1], q = '') => pickerRows(people, tab, q).map((x) => x.id)
    expect(ids('interest')).toEqual(['b', 'a'])
    expect(ids('last')).toEqual(['d', 'c'])
    expect(ids('past')).toEqual(['f', 'e'])
    expect(ids('all')).toEqual(['d', 'b', 'c', 'e', 'f', 'h', 'a'])
    expect(ids('retired')).toEqual(['g'])
  })

  it('searches names, emails and phones, and says when retired players match', () => {
    expect(pickerRows(people, 'all', 'past').map((x) => x.id)).toEqual(['e', 'f'])
    expect(pickerRows(people, 'all', '0412345').map((x) => x.id)).toEqual(['h'])
    expect(pickerRows(people, 'all', 'gus')).toEqual([])
    expect(retiredMatching(people, 'gus')).toBe(1)
    expect(retiredMatching(people, '')).toBe(0)
  })

  it('moves the active row with the keyboard, clamped', () => {
    expect(moveActive(-1, 'ArrowDown', 3)).toBe(0)
    expect(moveActive(2, 'ArrowDown', 3)).toBe(2)
    expect(moveActive(0, 'ArrowUp', 3)).toBe(0)
    expect(moveActive(1, 'End', 3)).toBe(2)
    expect(moveActive(2, 'Home', 3)).toBe(0)
    expect(moveActive(0, 'PageDown', 30)).toBe(10)
    expect(moveActive(0, 'ArrowDown', 0)).toBe(-1)
  })

  it('shows answers as words', () => {
    expect(answerLabel('not_sure')).toBe('Not sure')
    expect(answerLabel('middle')).toBe('Middle hitter')
    expect(answerLabel(null)).toBeNull()
  })

  it('knows who is placed from the rosters', () => {
    const m = placedMap([{ teamId: 't1', teamName: 'Aces', withdrawn: false, players: [{ playerId: 'a' } as never] }])
    expect(m.get('a')).toEqual({ teamId: 't1', teamName: 'Aces' })
  })
})

const source = (teamId: string, group: SourceTeam['group'], withdrawn = false): SourceTeam => ({
  teamId,
  teamName: teamId.toUpperCase(),
  group,
  from: { seasonId: 'q3', seasonName: 'TNL Q3 2026', startDate: '2026-07-09', leagueCode: 'TNL', withdrawn },
  seasons: 1,
  players: [{ playerId: `${teamId}-1`, name: 'Ann', role: 'captain', retired: false }],
})
const sources: RosterSources = {
  lastSeason: { id: 'q3', name: 'TNL Q3 2026' },
  teams: [source('a', 'last'), source('b', 'last', true), source('c', 'last'), source('d', 'league')],
  interests: [
    {
      interestId: 'i1',
      reference: 'EOI-BBBB',
      teamName: 'New Kids',
      createdAt: '2026-10-01',
      status: 'new',
      captain: null,
      members: [{ playerId: 'x', name: 'Xi', role: 'captain', retired: false }],
      matchedTeam: null,
      level: null,
    },
  ],
}

describe('adding teams', () => {
  it('plans "Add all of last season’s teams": skips withdrawn ones and ones already in', () => {
    const plan = lastSeasonPlan(sources, new Set(['c']))
    expect(plan.add.map((t) => t.teamId)).toEqual(['a'])
    expect(plan.withdrawn.map((t) => t.teamId)).toEqual(['b'])
    expect(plan.already.map((t) => t.teamId)).toEqual(['c'])
    expect(lastSeasonPlan(null, new Set()).add).toEqual([])
  })

  it('appends teams with where their roster comes from, once each', () => {
    const r = addTeams([{ id: 'c', name: 'C' }], { gone: { seasonId: 'x' } }, [
      { team: { id: 'a', name: 'A' }, from: { seasonId: 'q3' } },
      { team: { id: 'a', name: 'A' }, from: { seasonId: 'q2' } },
      { team: { id: 'c', name: 'C' }, from: { seasonId: 'q3' } },
      { team: { id: 'n', name: 'N' }, from: null },
    ])
    expect(r.teams.map((t) => t.id)).toEqual(['c', 'a', 'n'])
    expect(r.rosterFrom).toEqual({ gone: { seasonId: 'x' }, a: { seasonId: 'q3' } })
  })

  it('previews what an unsaved team brings', () => {
    expect(pendingRoster('a', { seasonId: 'q3' }, sources)).toMatchObject({ label: 'Copied from TNL Q3 2026', players: [{ name: 'Ann' }] })
    expect(pendingRoster('n', { interestId: 'i1' }, sources)).toMatchObject({
      label: 'From EOI-BBBB (team EOI)',
      players: [{ name: 'Xi' }],
    })
    expect(pendingRoster('n', undefined, sources)).toBeNull()
  })
})
