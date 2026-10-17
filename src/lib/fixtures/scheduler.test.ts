/* oxlint-disable unicorn/no-new-array */
import { describe, expect, it } from 'vitest'
import { teamStats, validate } from './analysis'
import { generate, settingsErrors } from './scheduler'
import type { Settings } from './types'

function settings(teams: number, over: Partial<Settings> = {}): Settings {
  return {
    name: 'Test',
    startDate: '2026-09-24',
    skipDates: [],
    courts: ['Court 1', 'Court 3'],
    sessions: ['20:00', '21:00'],
    sessionMinutes: 60,
    teams: Array.from({ length: teams }, (_, i) => ({ id: `t${i}`, name: `Team ${i}` })),
    meetings: 1,
    includeFinals: true,
    seed: 42,
    ...over,
  }
}

const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs)

const cases: [string, Settings][] = [
  ['8 teams, 2×2', settings(8)],
  ['9 teams, 2×2 (byes)', settings(9)],
  ['7 teams, 2×2', settings(7)],
  ['6 teams twice, 2×2', settings(6, { meetings: 2 })],
  ['12 teams, 3 sessions × 2 courts', settings(12, { sessions: ['19:00', '20:00', '21:00'] })],
  ['10 teams, 3 sessions × 2 courts', settings(10, { sessions: ['19:00', '20:00', '21:00'] })],
  ['4 teams twice, 1 court', settings(4, { meetings: 2, courts: ['Court 1'] })],
]

describe.each(cases)('%s', (_, s) => {
  for (const seed of [1, 2, 3, 42, 1000]) {
    it(`produces a clean, fair draw (seed ${seed})`, () => {
      const cfg = { ...s, seed }
      const weeks = generate(cfg)
      expect(validate(cfg, weeks)).toEqual([])

      const stats = teamStats(cfg, weeks)
      // equal games for everyone
      expect(spread(stats.map((t) => t.games))).toBe(0)
      // duties within one of each other
      expect(spread(stats.map((t) => t.duties))).toBeLessThanOrEqual(1)
      // byes within one of each other
      expect(spread(stats.map((t) => t.byes))).toBeLessThanOrEqual(1)
      // each team's split across session times is as even as possible (±1 of the others)
      for (let si = 0; si < cfg.sessions.length; si++) {
        expect(spread(stats.map((t) => t.perSession[si]!))).toBeLessThanOrEqual(2)
      }
      for (const t of stats) expect(t.longestSameSlot).toBeLessThanOrEqual(3)
    })
  }
})

describe('season structure', () => {
  it('runs round robin, then semis, then finals', () => {
    const weeks = generate(settings(8))
    expect(weeks.map((w) => w.kind)).toEqual([...new Array(7).fill('regular'), 'semi', 'final'])
    expect(weeks.map((w) => w.matchDay)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('plays semis back to back with the agreed duties', () => {
    const semi = generate(settings(8)).find((w) => w.kind === 'semi')!
    expect(semi.games.map((g) => [g.session, g.court])).toEqual([
      [0, 0],
      [1, 0],
    ])
    expect(semi.games[0]!).toMatchObject({ home: { label: '2nd' }, away: { label: '3rd' }, duty: { label: '4th' } })
    expect(semi.games[1]!).toMatchObject({ home: { label: '1st' }, away: { label: '4th' }, duty: { label: 'Loser SF1' } })
  })

  it('plays the grand final first, then 3rd place reffed by the GF loser', () => {
    const final = generate(settings(8)).find((w) => w.kind === 'final')!
    expect(final.games[0]!).toMatchObject({ session: 0, title: 'Grand Final' })
    expect(final.games[1]!).toMatchObject({ session: 1, title: '3rd Place', duty: { label: 'Loser GF' } })
  })

  it('weekly dates, pushed back past skipped weeks', () => {
    const weeks = generate(settings(8, { skipDates: [{ date: '2026-10-08', reason: 'School holidays' }] }))
    expect(weeks.slice(0, 4).map((w) => [w.date, w.kind])).toEqual([
      ['2026-09-24', 'regular'],
      ['2026-10-01', 'regular'],
      ['2026-10-08', 'skip'],
      ['2026-10-15', 'regular'],
    ])
    expect(weeks.filter((w) => w.kind !== 'skip')).toHaveLength(9)
  })

  it('is reproducible from its seed', () => {
    const strip = (s: Settings) => generate(s).map((w) => w.games.map((g) => ({ ...g, id: '' })))
    expect(strip(settings(8))).toEqual(strip(settings(8)))
    expect(strip(settings(8))).not.toEqual(strip(settings(8, { seed: 7 })))
  })

  it('refuses when teams do not fit the courts', () => {
    expect(settingsErrors(settings(10))).toContain('10 teams need 5 games a night, but 2 court(s) × 2 session(s) only gives 4 slots.')
  })

  it('skips finals for fewer than 4 teams', () => {
    expect(generate(settings(3)).every((w) => w.kind === 'regular')).toBe(true)
  })
})
