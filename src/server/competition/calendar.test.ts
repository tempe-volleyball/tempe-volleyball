import { describe, expect, it } from 'vitest'
import type { FixtureRow, SeasonCompetition } from './adapter'
import { seasonCalendarEvents, type SeasonCalendarInput } from './calendar'

const row = (extra: Partial<FixtureRow> = {}): FixtureRow => ({
  key: 'm1',
  date: '2026-10-29',
  matchDay: 5,
  time: '18:30',
  match: 'PENGUINS vs ICE COLD',
  result: '',
  resultNote: '',
  referee: '',
  sets: '',
  court: 'Court 1',
  duty: '',
  kind: 'game',
  forfeit: false,
  status: 'scheduled',
  note: '',
  movedFrom: '',
  movedTo: '',
  teamIds: { home: 'a', away: 'b', duty: null },
  label: 'Penguins vs Ice Cold',
  ...extra,
})

const input = {
  data: { league: { code: 'TNL' }, matches: [] },
  competition: { settings: { sessionMinutes: 60 }, weeks: [] } as unknown as SeasonCompetition,
} as unknown as SeasonCalendarInput

describe('seasonCalendarEvents', () => {
  it('says where a moved game was first set for in the Sydney date format, like the fixtures table', () => {
    const [event] = seasonCalendarEvents(input, { rows: [row({ movedFrom: '2026-10-22' })] })
    expect(event!.description).toBe('Match day 5\nMoved from 22/10/2026')
    expect(event!.start).toBe('2026-10-29T07:30:00.000Z')
  })
})
