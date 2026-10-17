import { describe, expect, it } from 'vitest'
import { teamStats, validate } from './analysis'
import { isStale, shapeKey, withGenerated, withSettings } from './competition'
import { demoCompetition } from './demo'
import { generate, sessionPatterns } from './scheduler'
import { dutyEnabled, type Settings } from './types'

/** A TVSL-like season: no team duty, 90-minute slots. */
function superLeague(teams: number, over: Partial<Settings> = {}): Settings {
  return {
    name: 'TVSL Q4 2026',
    startDate: '2026-10-18',
    skipDates: [],
    courts: ['Court 1', 'Court 2'],
    sessions: ['18:00', '19:30'],
    sessionMinutes: 90,
    teams: Array.from({ length: teams }, (_, i) => ({ id: `t${i}`, name: `Team ${i}` })),
    meetings: 1,
    includeFinals: true,
    duty: false,
    seed: 42,
    ...over,
  }
}

const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs)

describe('seasons without team duty (TVSL)', () => {
  it('duty defaults to on, so older settings keep working', () => {
    const { duty: _, ...rest } = superLeague(6)
    expect(dutyEnabled(rest)).toBe(true)
    expect(dutyEnabled(superLeague(6))).toBe(false)
  })

  for (const [name, s] of [
    ['6 teams', superLeague(6)],
    ['5 teams (byes)', superLeague(5)],
    ['8 teams twice', superLeague(8, { meetings: 2 })],
    ['10 teams, 3 sessions', superLeague(10, { sessions: ['17:00', '18:30', '20:00'] })],
  ] as const)
    it(`gives no game a duty team and still passes validation: ${name}`, () => {
      for (const seed of [1, 2, 3]) {
        const cfg = { ...s, seed }
        const weeks = generate(cfg)
        expect(weeks.flatMap((w) => w.games).every((g) => g.duty === null)).toBe(true)
        expect(validate(cfg, weeks)).toEqual([])
        const stats = teamStats(cfg, weeks)
        expect(stats.every((t) => t.duties === 0)).toBe(true)
        expect(spread(stats.map((t) => t.games))).toBe(0)
        for (const t of stats) expect(t.longestSameSlot).toBeLessThanOrEqual(3)
      }
    })

  it('finals have no duty refs', () => {
    const weeks = generate(superLeague(6))
    const finals = weeks.filter((w) => w.kind === 'semi' || w.kind === 'final').flatMap((w) => w.games)
    expect(finals.map((g) => g.title)).toEqual(['Semi Final 1', 'Semi Final 2', 'Grand Final', '3rd Place'])
    expect(finals.every((g) => g.duty === null)).toBe(true)
  })

  it('social finals still have the agreed duty refs', () => {
    const weeks = generate({ ...superLeague(6), duty: true })
    const finals = weeks.filter((w) => w.kind === 'semi' || w.kind === 'final').flatMap((w) => w.games)
    expect(finals.map((g) => g.duty)).toEqual([{ label: '4th' }, { label: 'Loser SF1' }, { label: 'Loser SF1' }, { label: 'Loser GF' }])
  })

  it('session splits ignore duty feasibility when there is no duty', () => {
    // Where the most even splits can all be reffed from next door, duty makes no difference.
    expect(sessionPatterns(3, 2, 3)).toEqual([
      [2, 1],
      [1, 2],
    ])
    expect(sessionPatterns(3, 2, 3, false)).toEqual(sessionPatterns(3, 2, 3))
    // With duty, a session with 2 games next to one with none can't be reffed; without, spread wins.
    expect(sessionPatterns(2, 3, 2)).not.toContainEqual([2, 0, 0])
    expect(sessionPatterns(2, 3, 2, false)).toEqual([
      [1, 1, 0],
      [1, 0, 1],
      [0, 1, 1],
    ])
  })

  it('validation does not flag missing duty, but flags a duty team set by hand', () => {
    const s = superLeague(6)
    const weeks = generate(s)
    expect(validate(s, weeks).some((i) => i.message.includes('no duty team'))).toBe(false)
    const first = weeks[0]!
    const withDuty = weeks.map((w) =>
      w.id !== first.id ? w : { ...w, games: w.games.map((g, i) => (i ? g : { ...g, duty: { team: 't0' } })) },
    )
    expect(validate(s, withDuty)).toEqual([
      expect.objectContaining({ level: 'warning', message: 'Match day 1: a game has a duty team, but this season has no team duty.' }),
    ])
  })

  it('a social season with a game missing duty is still flagged', () => {
    const s = { ...superLeague(6), duty: true }
    const weeks = generate(s)
    const first = weeks[0]!
    const noDuty = weeks.map((w) => (w.id !== first.id ? w : { ...w, games: w.games.map((g, i) => (i ? g : { ...g, duty: null })) }))
    expect(validate(s, noDuty).some((i) => i.message === 'Match day 1: a game has no duty team.')).toBe(true)
  })

  it('turning duty off needs a regenerate', () => {
    const c = withGenerated(demoCompetition())
    expect(shapeKey({ ...c.settings, duty: true })).toBe(shapeKey(c.settings))
    expect(isStale(withSettings(c, { ...c.settings, duty: false }))).toBe(true)
  })
})
