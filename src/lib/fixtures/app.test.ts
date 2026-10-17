import { describe, expect, it } from 'vitest'
import { validate } from './analysis'
import { isStale, withGenerated, withSettings } from './competition'
import { moveGame, setCourt } from './edit'
import { fullCsv, publicRows, refName } from './export'
import { demoCompetition } from './demo'
import { courtName, type Game, type Week } from './types'

const generated = () => withGenerated(demoCompetition())

describe('editing', () => {
  it('swaps two games across weeks, and validation spots the clash', () => {
    const c = generated()
    const [w1, w2] = c.weeks! as [Week, Week]
    const a = w1.games[0]!
    const b = w2.games[0]!
    const weeks = moveGame(c.weeks!, { weekId: w1.id, gameId: a.id }, { weekId: w2.id, session: b.session, court: b.court })
    expect(weeks[0]!.games.find((g) => g.id === b.id)).toMatchObject({ session: a.session, court: a.court })
    expect(weeks[1]!.games.find((g) => g.id === a.id)).toMatchObject({ session: b.session, court: b.court })
    expect(validate(c.settings, weeks).some((i) => i.level === 'error')).toBe(true)
  })

  it('swaps two games in the same week without losing either', () => {
    const c = generated()
    const w = c.weeks![0]!
    const [a, , , d] = w.games as [Game, Game, Game, Game]
    const weeks = moveGame(c.weeks!, { weekId: w.id, gameId: a.id }, { weekId: w.id, session: d.session, court: d.court })
    const after = weeks[0]!.games
    expect(after).toHaveLength(w.games.length)
    expect(after.find((g) => g.id === a.id)).toMatchObject({ session: d.session, court: d.court })
    expect(after.find((g) => g.id === d.id)).toMatchObject({ session: a.session, court: a.court })
  })

  it('moves a game into an empty slot', () => {
    const c = generated()
    const semi = c.weeks!.find((w) => w.kind === 'semi')!
    const weeks = moveGame(c.weeks!, { weekId: semi.id, gameId: semi.games[0]!.id }, { weekId: semi.id, session: 0, court: 1 })
    expect(weeks.find((w) => w.id === semi.id)!.games.map((g) => [g.session, g.court])).toEqual([
      [0, 1],
      [1, 0],
    ])
  })
})

describe('courts per slot', () => {
  it('overrides one slot, and the season default clears it', () => {
    const c = generated()
    const w = c.weeks![0]!
    let weeks = setCourt(c.weeks!, c.settings, w.id, 1, 0, 'Court 2')
    expect(courtName(c.settings, weeks[0]!, 1, 0)).toBe('Court 2')
    expect(courtName(c.settings, weeks[0]!, 0, 0)).toBe('Court 1')
    expect(courtName(c.settings, weeks[1]!, 1, 0)).toBe('Court 1')
    weeks = setCourt(weeks, c.settings, w.id, 1, 0, 'Court 1')
    expect(weeks[0]!.courtOverrides).toEqual({})
  })

  it('a moved game plays on the court of the slot it lands in', () => {
    const c = generated()
    const [w1, w2] = c.weeks! as [Week, Week]
    let weeks = setCourt(c.weeks!, c.settings, w2.id, 0, 0, 'Court 5')
    const g = w1.games.find((x) => x.session === 1 && x.court === 1)!
    weeks = moveGame(weeks, { weekId: w1.id, gameId: g.id }, { weekId: w2.id, session: 0, court: 0 })
    const row = publicRows(c.settings, weeks).find((r) => r.date === w2.date && r.time === '20:00' && r.venue === 'Court 5')
    expect(row?.match).toContain(refName(c.settings, g.home).toUpperCase())
  })

  it('flags two games on the same court at the same time', () => {
    const c = generated()
    const w = c.weeks![0]!
    const weeks = setCourt(c.weeks!, c.settings, w.id, 0, 1, 'court 1') // case doesn't matter
    const clash = validate(c.settings, weeks).find((i) => i.message.includes('two games on'))
    expect(clash).toMatchObject({ level: 'error', message: 'Match day 1: two games on court 1 at 20:00.' })
    expect(clash!.gameIds).toHaveLength(2)
  })

  it('removing a default court keeps the draw, but games left without a court are flagged', () => {
    const c = generated()
    const next = withSettings(c, { ...c.settings, courts: ['Court 1'] })
    expect(isStale(next)).toBe(false)
    expect(validate(next.settings, next.weeks!).filter((i) => i.message.includes('has no court')).length).toBeGreaterThan(0)
  })
})

describe('settings changes', () => {
  it('re-dates around a new week off without changing the draw', () => {
    const c = generated()
    const next = withSettings(c, { ...c.settings, skipDates: [{ date: '2027-02-18', reason: 'Venue closed' }] })
    expect(next.weeks!.map((w) => w.date).slice(0, 4)).toEqual(['2027-02-04', '2027-02-11', '2027-02-18', '2027-02-25'])
    expect(next.weeks![2]!).toMatchObject({ kind: 'skip', note: 'Venue closed' })
    expect(next.weeks![3]!.games).toEqual(c.weeks![2]!.games)
    expect(next.weeks![3]!.id).toBe(c.weeks![2]!.id)
    expect(isStale(next)).toBe(false)
  })

  it('flags the draw as stale when a team is added', () => {
    const c = generated()
    const next = withSettings(c, { ...c.settings, teams: [...c.settings.teams, { id: 'new', name: 'New Team' }] })
    expect(isStale(next)).toBe(true)
  })
})

describe('exports', () => {
  it('public rows include a bye row each round-robin week and finals placeholders', () => {
    const c = generated()
    const rows = publicRows(c.settings, c.weeks!)
    expect(rows.filter((r) => r.kind === 'bye')).toHaveLength(9)
    expect(rows.find((r) => r.match.startsWith('SEMI FINAL 1'))).toMatchObject({ match: 'SEMI FINAL 1 - (2ND) vs (3RD)', duty: '(4TH)' })
  })

  it('full CSV quotes awkward team names', () => {
    const c = generated()
    c.settings.teams[0]!.name = 'Spike, Set & "Serve"'
    expect(fullCsv(c.settings, c.weeks!)).toContain('"Spike, Set & ""Serve"""')
  })
})
