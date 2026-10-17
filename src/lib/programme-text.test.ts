import { describe, expect, it } from 'vitest'
import {
  formatTime,
  formatTimeRange,
  generatedSummaryLine,
  nextStartsLine,
  programmeLineSource,
  scheduleText,
  summaryLine,
  venueSuburb,
  venueText,
  type ProgrammeTextInput,
} from './programme-text'
import { sydneyToUtc, utcToSydneyInput } from './time'
import { weeklyDates, weekdayOf } from './weekly'

const tnl: ProgrammeTextInput = {
  kind: 'league',
  name: 'Thursday Night League',
  code: 'TNL',
  weekday: 4,
  startTime: '20:00',
  endTime: '22:00',
  scheduleLabel: null,
  summaryLine: null,
  nextStartsOn: null,
  nextStartsText: null,
}
const tempe = { name: 'Robyn Webster Sports Centre', address: 'Holbeach Ave, Tempe NSW 2044' }

describe('programme text', () => {
  it('formats times the way the old site wrote them', () => {
    expect(formatTime('20:00')).toBe('8pm')
    expect(formatTime('18:30')).toBe('6:30pm')
    expect(formatTime('12:00')).toBe('12pm')
    expect(formatTime('00:15')).toBe('12:15am')
    expect(formatTime('8pm')).toBe('')
    expect(formatTimeRange('20:00', '22:00')).toBe('8–10pm')
    expect(formatTimeRange('11:00', '13:00')).toBe('11am–1pm')
    expect(formatTimeRange('18:30', null)).toBe('6:30pm')
    expect(formatTimeRange(null, '22:00')).toBe('')
  })

  it('finds the suburb in an address', () => {
    expect(venueSuburb('Holbeach Ave, Tempe NSW 2044')).toBe('Tempe')
    expect(venueSuburb('1 William St, Five Dock, NSW 2046')).toBe('')
    expect(venueSuburb('Rowley St, Burwood')).toBe('Burwood')
    expect(venueSuburb('Holbeach Ave')).toBe('')
    expect(venueText(tempe)).toBe('Robyn Webster Sports Centre, Tempe')
    expect(venueText({ name: 'Five Dock Leisure Centre', address: 'William St, Five Dock NSW 2046' })).toBe('Five Dock Leisure Centre')
    expect(venueText(null)).toBe('')
  })

  it('generates the summary line from the details', () => {
    expect(generatedSummaryLine(tnl, tempe)).toBe('Thursday Night League (TNL) @ Robyn Webster Sports Centre, Tempe, Thursdays 8–10pm')
    expect(generatedSummaryLine({ ...tnl, name: 'TNL social' }, null)).toBe('TNL social, Thursdays 8–10pm')
    expect(generatedSummaryLine({ ...tnl, startTime: null, endTime: null }, null)).toBe('Thursday Night League (TNL), Thursdays')
    expect(scheduleText({ ...tnl, kind: 'event' })).toBe('8–10pm')
  })

  it('hand-written text wins', () => {
    expect(scheduleText({ ...tnl, scheduleLabel: 'Thursdays, 6:30 till late' })).toBe('Thursdays, 6:30 till late')
    expect(summaryLine({ ...tnl, summaryLine: ' Our flagship league ' }, tempe)).toBe('Our flagship league')
    expect(summaryLine({ ...tnl, summaryLine: '  ' }, tempe)).toContain('(TNL)')
  })

  it('says when the next instance starts', () => {
    expect(nextStartsLine(tnl, null)).toBe('')
    expect(nextStartsLine(tnl, '2027-01-14')).toBe('Next season starts Thursday 14 January 2027')
    expect(nextStartsLine({ ...tnl, nextStartsOn: '2027-01-21' }, '2027-01-14')).toBe('Next season starts Thursday 21 January 2027')
    expect(nextStartsLine({ ...tnl, nextStartsText: 'Starts after Easter' }, '2027-01-14')).toBe('Starts after Easter')
    expect(nextStartsLine({ ...tnl, kind: 'development' }, '2027-01-14')).toBe('Next term starts Thursday 14 January 2027')
  })

  it('builds the block line source', () => {
    expect(programmeLineSource(tnl, tempe, null)).toEqual({
      name: 'Thursday Night League',
      code: 'TNL',
      venue: 'Robyn Webster Sports Centre, Tempe',
      times: 'Thursdays 8–10pm',
      nextStarts: '',
      summaryLine: '',
    })
  })
})

describe('weekly dates', () => {
  it('runs from the first matching day to the end, inclusive', () => {
    expect(weekdayOf('2026-10-22')).toBe(4)
    expect(weeklyDates('2026-10-20', '2026-11-12', 4)).toEqual(['2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12'])
    expect(weeklyDates('2026-10-22', '2026-11-12', 4, { everyWeeks: 2 })).toEqual(['2026-10-22', '2026-11-05'])
    expect(weeklyDates('2026-10-22', '2026-11-12', 4, { skip: ['2026-10-29'] })).toEqual(['2026-10-22', '2026-11-05', '2026-11-12'])
    expect(weeklyDates('2026-10-22', '2027-12-31', 4, { max: 3 })).toHaveLength(3)
    expect(weeklyDates('2026-11-12', '2026-10-22', 4)).toEqual([])
  })
})

describe('Sydney time input', () => {
  it('converts Sydney wall-clock time to UTC across DST', () => {
    expect(sydneyToUtc('2026-07-01T09:00')).toBe('2026-06-30T23:00:00.000Z') // AEST +10
    expect(sydneyToUtc('2026-12-01 09:00')).toBe('2026-11-30T22:00:00.000Z') // AEDT +11
    expect(sydneyToUtc('2026-10-04T01:30')).toBe('2026-10-03T15:30:00.000Z') // the night DST starts, before 2am
    expect(sydneyToUtc('soon')).toBeNull()
    expect(utcToSydneyInput('2026-11-30T22:00:00.000Z')).toBe('2026-12-01T09:00')
    expect(utcToSydneyInput(null)).toBe('')
  })
})
