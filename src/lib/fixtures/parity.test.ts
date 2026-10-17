import { describe, expect, it } from 'vitest'
import { pushBack, pushBackProblem } from './calendar'
import { withGenerated } from './competition'
import { fullCsv } from './export'
import { importFixturesCsv, parseCsv, parseCsvDate, parseCsvTime, placeholderLabel } from './csv-import'
import { demoCompetition } from './demo'
import { publishWeekResults, setResult } from './edit'
import { makeResolver, progress, standings, tieBreakOrder } from './results'
import { offGameIds } from './status'
import { validate } from './analysis'
import type { Result, Settings, Week } from './types'

// Fixtures parity (docs/admin.md §1): tie-break order, withdrawn teams, postponing a night, CSV import.

const team = (id: string, name = id) => ({ id, name })
const r = (home: number, away: number, hp = 25 * home + 20 * away, ap = 25 * away + 20 * home): Result => ({
  home,
  away,
  homePoints: hp,
  awayPoints: ap,
})

const settings = (over: Partial<Settings> = {}): Settings => ({
  name: 'Test',
  startDate: '2027-01-07',
  skipDates: [],
  courts: ['Court 1', 'Court 2'],
  sessions: ['20:00', '21:00'],
  sessionMinutes: 60,
  teams: [team('a', 'Aces'), team('b', 'Blockers'), team('c', 'Chaos'), team('d', 'Diggers')],
  meetings: 1,
  includeFinals: false,
  seed: 1,
  ...over,
})

let n = 0
/** One regular week with these published results: [home, away, result]. */
const week = (games: [string, string, Result][], date = `2027-01-${String(7 + n).padStart(2, '0')}`): Week => ({
  id: `w${n++}`,
  kind: 'regular',
  date,
  matchDay: n,
  games: games.map(([h, a, res], i) => ({
    id: `g${n}-${i}`,
    session: i,
    court: 0,
    home: { team: h },
    away: { team: a },
    duty: null,
    result: res,
    publishedResult: res,
  })),
})

const order = (s: Settings, weeks: Week[], adjustments?: Map<string, number>) =>
  standings(s, weeks, adjustments ? { adjustments } : {}).map((x) => x.teamId)

describe('tie-break order', () => {
  it('defaults to set difference, points difference, wins, then name (the pre-Phase 6 order)', () => {
    expect(tieBreakOrder({})).toEqual(['setDiff', 'pointDiff', 'wins', 'name'])
    expect(tieBreakOrder({ tieBreaks: ['headToHead', 'name', 'headToHead', 'wins'] })).toEqual(['headToHead', 'wins', 'name'])
    // a and b both win 2-0, a by more points (so d lost by less than c).
    const weeks = [
      week([
        ['a', 'c', r(2, 0, 50, 30)],
        ['b', 'd', r(2, 0, 50, 40)],
      ]),
    ]
    expect(order(settings(), weeks)).toEqual(['a', 'b', 'd', 'c'])
    // Level on everything: the name decides.
    const level = [
      week([
        ['a', 'c', r(2, 0, 50, 40)],
        ['b', 'd', r(2, 0, 50, 40)],
      ]),
    ]
    expect(order(settings(), level)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('follows a custom order, and head to head is decided among the tied teams only', () => {
    // a beat b, b beat c, c beat a: all on 1 win. d lost to everyone in another week.
    const weeks = [
      week([['a', 'b', r(2, 0, 50, 48)]]),
      week([['b', 'c', r(2, 0, 50, 10)]]),
      week([['c', 'a', r(2, 1, 60, 59)]]),
      week([['d', 'a', r(0, 2)]]),
      week([['d', 'b', r(0, 2)]]),
      week([['d', 'c', r(0, 2)]]),
    ]
    const s = settings()
    // a, b and c all have 2 wins; d none. Points for decides: c (60+60+…) vs a vs b.
    const pf = (id: string) => standings(s, weeks).find((x) => x.teamId === id)!.pointsFor
    const byPoints = order({ ...s, tieBreaks: ['pointsFor'] }, weeks)
    expect(byPoints.slice(0, 3)).toEqual(['a', 'b', 'c'].toSorted((x, y) => pf(y) - pf(x)))
    expect(byPoints.at(-1)).toBe('d')
    // A three-way head to head (each beat one of the others) is still tied, so the next rule decides.
    expect(order({ ...s, tieBreaks: ['headToHead', 'pointsFor'] }, weeks)).toEqual(byPoints)

    // y and z are level on ladder points; z has the better set difference, but y beat z.
    const four = settings({ teams: [team('w', 'Wasps'), team('x', 'Xtra'), team('y', 'Yell'), team('z', 'Zed')] })
    const h2h = [week([['y', 'z', r(2, 1)]]), week([['x', 'y', r(2, 0)]]), week([['z', 'w', r(2, 0)]])]
    expect(order(four, h2h)).toEqual(['z', 'y', 'x', 'w'])
    expect(order({ ...four, tieBreaks: ['headToHead', 'setDiff'] }, h2h)).toEqual(['y', 'z', 'x', 'w'])
  })

  it('adds ladder adjustments before sorting', () => {
    const weeks = [
      week([
        ['a', 'b', r(2, 0)],
        ['c', 'd', r(2, 0)],
      ]),
    ]
    expect(order(settings(), weeks, new Map([['d', 5]]))[0]).toBe('d')
  })
})

describe('withdrawn teams', () => {
  const withdrawnD = (over: Partial<Settings> = {}) =>
    settings({
      teams: [
        team('a', 'Aces'),
        team('b', 'Blockers'),
        team('c', 'Chaos'),
        { id: 'd', name: 'Diggers', withdrawn: { at: 'x', reason: 'Folded' } },
      ],
      ...over,
    })
  const weeks = () => [
    week([
      ['d', 'a', r(2, 0)],
      ['b', 'c', r(2, 0)],
    ]),
  ]

  it('marks them and sorts them last by default, keeping their results', () => {
    const rows = standings(withdrawnD(), weeks())
    expect(rows.at(-1)).toMatchObject({ teamId: 'd', withdrawn: true, won: 1 })
    expect(rows.find((x) => x.teamId === 'a')).toMatchObject({ lost: 1, played: 1 })
  })

  it('hides them, or voids their games for both sides', () => {
    expect(standings(withdrawnD({ withdrawn: { ladder: 'hide', results: 'keep' } }), weeks()).map((x) => x.teamId)).not.toContain('d')
    const voided = standings(withdrawnD({ withdrawn: { ladder: 'mark', results: 'void' } }), weeks())
    expect(voided.find((x) => x.teamId === 'a')).toMatchObject({ played: 0, points: 0 })
    expect(voided.find((x) => x.teamId === 'd')).toMatchObject({ played: 0, withdrawn: true })
  })
})

describe('cancelled and other off games', () => {
  it('a cancelled game doesn’t hold up finals seeding', () => {
    const c = withGenerated({ ...demoCompetition(), settings: { ...demoCompetition().settings, includeFinals: true } })
    let weeks = c.weeks!
    const regular = weeks.filter((w) => w.kind === 'regular')
    const cancelled = regular[0]!.games[0]!.id
    for (const w of regular) for (const g of w.games) if (g.id !== cancelled) weeks = setResult(weeks, w.id, g.id, r(2, 0))
    for (const w of regular) weeks = publishWeekResults(weeks, w.id)
    expect(progress(weeks).regular.done).toBeLessThan(progress(weeks).regular.total)
    weeks = weeks.map((w) => ({ ...w, games: w.games.map((g) => (g.id === cancelled ? { ...g, status: 'cancelled' as const } : g)) }))
    expect(progress(weeks).regular.done).toBe(progress(weeks).regular.total)
    const resolve = makeResolver(c.settings, weeks)
    expect(resolve({ label: '1st' })).toHaveProperty('team')
  })

  it('finds a week’s off games from Game.status or a lookup', () => {
    const w = week([
      ['a', 'b', r(2, 0)],
      ['c', 'd', r(2, 0)],
    ])
    w.games[0]!.status = 'postponed'
    expect([...offGameIds(w)]).toEqual([w.games[0]!.id])
    expect([...offGameIds(w, (id) => (id === w.games[1]!.id ? 'tbd' : 'played'))]).toEqual([w.games[1]!.id])
  })
})

describe('postponing a night and pushing the season back', () => {
  const season = () => {
    const c = withGenerated({ ...demoCompetition(), settings: { ...demoCompetition().settings, skipDates: [] } })
    return { s: c.settings, weeks: c.weeks! }
  }

  it('moves the night and every later one a week, keeping ids, order and match day numbers', () => {
    const { weeks } = season()
    const night = weeks[2]!
    const plan = pushBack(weeks, night.id, { skipId: 'skip1', note: 'Postponed – Venue flooded', status: 'postponed' })
    expect(plan.skipDate).toBe(night.date)
    expect(plan.moves).toHaveLength(weeks.length - 2)
    expect(plan.moves[0]).toEqual({ weekId: night.id, from: night.date, to: weeks[3]!.date })
    const after = plan.weeks
    expect(after).toHaveLength(weeks.length + 1)
    expect(after.slice(0, 2)).toEqual(weeks.slice(0, 2))
    expect(after[2]).toMatchObject({ id: 'skip1', kind: 'skip', date: night.date, status: 'postponed', note: 'Postponed – Venue flooded' })
    expect(after[3]).toMatchObject({ id: night.id, date: weeks[3]!.date, originalDate: night.date, matchDay: night.matchDay })
    expect(after.filter((w) => w.kind !== 'skip').map((w) => w.id)).toEqual(weeks.map((w) => w.id))
    expect(new Set(after.map((w) => w.date)).size).toBe(after.length)
  })

  it('steps over weeks off and skip dates, which stay put, and adds weeks for skip dates it now spans', () => {
    const { s, weeks } = season()
    // A week off after match day 4, and a holiday a week after the season currently ends.
    const off = { ...weeks[4]!, id: 'off', kind: 'skip' as const, games: [], matchDay: 0, note: 'Easter' }
    const withOff = [...weeks.slice(0, 4), off, ...weeks.slice(4).map((w) => ({ ...w, date: addWeek(w.date) }))]
    const end = withOff.at(-1)!.date
    // The last night would land on it, so it steps over it.
    const holiday = addWeek(end)
    const plan = pushBack(withOff, withOff[1]!.id, {
      skipId: 'p',
      note: 'Postponed',
      status: 'postponed',
      skipDates: [
        { date: off.date, reason: 'Easter' },
        { date: holiday, reason: 'Christmas' },
      ],
      newId: () => 'new',
    })
    const dates = plan.weeks.map((w) => w.date)
    expect(plan.weeks.find((w) => w.id === 'off')!.date).toBe(off.date)
    expect(plan.moves.every((m) => m.to !== off.date && m.to !== holiday)).toBe(true)
    expect(plan.newSkipWeeks).toEqual([{ date: holiday, reason: 'Christmas' }])
    expect(plan.weeks.find((w) => w.id === 'new')).toMatchObject({ kind: 'skip', date: holiday, note: 'Christmas' })
    expect(new Set(dates).size).toBe(dates.length)
    expect(dates).toEqual(dates.toSorted())
    // Everything is on the same weekday as before.
    expect(new Set(dates.map((d) => new Date(d).getUTCDay())).size).toBe(1)
    // validate() is still happy with the draw (only dates moved).
    expect(validate(s, plan.weeks).filter((i) => i.level === 'error')).toEqual(validate(s, withOff).filter((i) => i.level === 'error'))
  })

  it('refuses weeks off and nights from published results on', () => {
    const { weeks } = season()
    const published = publishWeekResults(
      weeks[3]!.games.reduce((ws, g) => setResult(ws, weeks[3]!.id, g.id, r(2, 0)), weeks),
      weeks[3]!.id,
    )
    expect(pushBackProblem(published, weeks[1]!.id)).toMatch(/Match day 4 .* published results/)
    expect(pushBackProblem(published, weeks[4]!.id)).toBeNull()
    expect(() => pushBack(published, weeks[1]!.id, { skipId: 'x', note: '', status: 'postponed' })).toThrow(/published results/)
  })
})

const addWeek = (d: string) => {
  const dt = new Date(`${d}T00:00:00Z`)
  dt.setUTCDate(dt.getUTCDate() + 7)
  return dt.toISOString().slice(0, 10)
}

describe('CSV fixture import', () => {
  it('parses quotes, tabs and semicolons, dates, times and placeholders', () => {
    expect(parseCsv('a,"b ""c""",d\r\n1,"x,y",\n')).toEqual([
      ['a', 'b "c"', 'd'],
      ['1', 'x,y', ''],
    ])
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('a;b\n1;2')[1]).toEqual(['1', '2'])
    expect(parseCsvDate('5/11/2026')).toBe('2026-11-05')
    expect(parseCsvDate('2026-11-05')).toBe('2026-11-05')
    expect(parseCsvDate('31/02/2026')).toBeNull()
    expect(parseCsvTime('8pm')).toBe('20:00')
    expect(parseCsvTime('8:30 PM')).toBe('20:30')
    expect(parseCsvTime('20.15')).toBe('20:15')
    expect(parseCsvTime('8')).toBeNull()
    expect(placeholderLabel('(WINNER SF1)')).toBe('Winner SF1')
    expect(placeholderLabel('(2ND)')).toBe('2nd')
    expect(placeholderLabel('Aces')).toBeNull()
  })

  it('round-trips the season’s own CSV export', () => {
    const c = withGenerated({
      ...demoCompetition(),
      settings: { ...demoCompetition().settings, includeFinals: true, skipDates: [{ date: '2027-02-11', reason: 'Venue closed' }] },
    })
    const csv = fullCsv(c.settings, c.weeks!)
    let i = 0
    const out = importFixturesCsv(csv, { teams: c.settings.teams, courtNames: c.settings.courts, newId: () => `id${i++}` })
    expect(out.issues.filter((x) => x.level === 'error')).toEqual([])
    expect(out.settings.startDate).toBe(c.settings.startDate)
    expect(out.settings.skipDates).toEqual([{ date: '2027-02-11', reason: 'Venue closed' }])
    expect(out.settings.sessions).toEqual(c.settings.sessions)
    const shape = (weeks: Week[], courts: string[], sessions: string[]) =>
      weeks.map((w) => ({
        kind: w.kind,
        date: w.date,
        matchDay: w.matchDay,
        games: w.games
          .map((g) => [
            sessions[g.session],
            courts[g.court],
            JSON.stringify(g.home),
            JSON.stringify(g.away),
            JSON.stringify(g.duty),
            g.title ?? '',
          ])
          .toSorted(),
      }))
    expect(shape(out.weeks, out.settings.courts, out.settings.sessions)).toEqual(
      shape(
        c.weeks!.map((w) => ({
          ...w,
          games: w.games.map((g) => ({ ...g, court: out.settings.courts.indexOf(c.settings.courts[g.court]!) })),
        })),
        out.settings.courts,
        c.settings.sessions,
      ),
    )
    expect(validate({ ...c.settings, ...out.settings }, out.weeks).filter((x) => x.level === 'error')).toEqual([])
  })

  it('lists every problem with its line', () => {
    const teams = [team('a', 'Aces'), team('b', 'Blockers')]
    const csv = [
      'Date,Time,Court,Home,Away',
      '2027-01-07,20:00,Court 1,Aces,Blockers',
      'soon,20:00,Court 1,Aces,Blockers',
      '2027-01-14,whenever,Court 1,Aces,Blockers',
      '2027-01-21,20:00,Court 9,Aces,Nobody',
      '2027-01-28,20:00,Court 1,Aces,Blockers',
      '2027-01-28,20:00,Court 1,Blockers,Aces',
    ].join('\n')
    const out = importFixturesCsv(csv, { teams, courtNames: ['Court 1', 'Court 2'] })
    const lines = out.issues.map((x) => [x.line, x.message])
    expect(lines).toEqual([
      [3, expect.stringMatching(/isn’t a date/)],
      [4, expect.stringMatching(/isn’t a time/)],
      [5, expect.stringMatching(/no team called “Nobody”/)],
      [5, expect.stringMatching(/no court called “Court 9”/)],
      [7, expect.stringMatching(/Two games on Court 1 at 20:00/)],
    ])
    expect(importFixturesCsv('Home,Away\nAces,Blockers', { teams, courtNames: [] }).issues[0]!.message).toMatch(/Date, Time, Court/)
    expect(importFixturesCsv('', { teams, courtNames: [] }).issues[0]!.message).toMatch(/empty/)
  })
})
