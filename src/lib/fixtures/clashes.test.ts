import { describe, expect, it } from 'vitest'
import { courtClashes, overlaps, seasonBookings, type SeasonDraw } from './clashes'
import type { Game, Settings, Week } from './types'

const settings = (over: Partial<Settings>): Settings => ({
  name: '',
  startDate: '2026-10-16',
  skipDates: [],
  courts: ['Court 1', 'Court 2'],
  sessions: ['20:00', '21:00'],
  sessionMinutes: 60,
  teams: [],
  meetings: 1,
  includeFinals: false,
  seed: 1,
  ...over,
})

const game = (id: string, session: number, court: number): Game => ({
  id,
  session,
  court,
  home: { label: 'A' },
  away: { label: 'B' },
  duty: null,
})
const week = (id: string, date: string, games: Game[], over: Partial<Week> = {}): Week => ({
  id,
  kind: 'regular',
  date,
  matchDay: 1,
  games,
  ...over,
})

const draw = (seasonId: string, venue: string, s: Settings, weeks: Week[]): SeasonDraw => ({
  seasonId,
  label: seasonId,
  venue,
  settings: s,
  weeks,
})

describe('court clashes across leagues', () => {
  const fnl = draw('FNL Q4 2026', 'tempe', settings({}), [week('f1', '2026-10-16', [game('f-a', 0, 0), game('f-b', 1, 1)])])

  it('flags two seasons on the same court, date and time', () => {
    const other = draw('TVSL Q4 2026', 'tempe', settings({ sessions: ['20:30'], sessionMinutes: 90 }), [
      week('t1', '2026-10-16', [game('t-a', 0, 0)]),
    ])
    const clashes = courtClashes([fnl, other])
    expect(clashes).toHaveLength(1)
    expect(clashes[0]).toMatchObject({
      date: '2026-10-16',
      court: 'Court 1',
      message: 'Court 1 on 16/10/2026: FNL Q4 2026 at 20:00 and TVSL Q4 2026 at 20:30 overlap.',
    })
    expect(clashes[0]!.bookings.map((b) => b.gameId)).toEqual(['f-a', 't-a'])
  })

  it('compares overlapping times, so different session lengths still clash', () => {
    // TVSL 18:30-20:00 vs FNL 21:00 on Court 2: fine. 19:45-21:15 on Court 2: clashes with 21:00.
    const early = draw('TVSL', 'tempe', settings({ sessions: ['18:30'], sessionMinutes: 90 }), [
      week('t1', '2026-10-16', [game('t', 0, 1)]),
    ])
    const late = draw('TVSL', 'tempe', settings({ sessions: ['19:45'], sessionMinutes: 90 }), [week('t1', '2026-10-16', [game('t', 0, 1)])])
    expect(courtClashes([fnl, early])).toEqual([])
    expect(courtClashes([fnl, late])).toHaveLength(1)
  })

  it('back to back is not a clash', () => {
    expect(overlaps({ start: '20:00', end: '21:00' }, { start: '21:00', end: '22:00' })).toBe(false)
    expect(overlaps({ start: '20:00', end: '21:00' }, { start: '20:59', end: '22:00' })).toBe(true)
    expect(overlaps({ start: '23:30', end: '00:30' }, { start: '23:45', end: '23:55' })).toBe(true)
  })

  it('needs the same venue and date, and matches court names loosely', () => {
    const s = settings({ courts: [' court 1 '] })
    const fiveDock = draw('SNL', 'five-dock', s, [week('s1', '2026-10-16', [game('s', 0, 0)])])
    const nextDay = draw('SNL', 'tempe', s, [week('s1', '2026-10-17', [game('s', 0, 0)])])
    const sameNight = draw('SNL', 'tempe', s, [week('s1', '2026-10-16', [game('s', 0, 0)])])
    expect(courtClashes([fnl, fiveDock, nextDay])).toEqual([])
    expect(courtClashes([fnl, sameNight])).toHaveLength(1)
  })

  it('uses week court overrides, and leaves clashes inside one season to validate()', () => {
    const moved = draw('SAL', 'tempe', settings({}), [
      week('s1', '2026-10-16', [game('s', 1, 0)], { courtOverrides: { '1:0': 'Court 2' } }),
    ])
    expect(courtClashes([fnl, moved]).map((c) => c.court)).toEqual(['Court 2'])
    const twice = draw('FNL Q4 2026', 'tempe', settings({}), [week('f2', '2026-10-16', [game('x', 0, 0)])])
    expect(courtClashes([fnl, twice])).toEqual([])
  })

  it('skips weeks off and games with no court or time', () => {
    const s = settings({ courts: ['Court 1'] })
    const weeks = [
      week('w0', '2026-10-16', [], { kind: 'skip', matchDay: 0 }),
      week('w1', '2026-10-23', [game('ok', 0, 0), game('no-court', 0, 1), game('no-time', 5, 0)]),
    ]
    expect(seasonBookings(draw('X', 'tempe', s, weeks)).map((b) => [b.gameId, b.start, b.end])).toEqual([['ok', '20:00', '21:00']])
  })
})
