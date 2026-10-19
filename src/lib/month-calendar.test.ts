import { describe, expect, it } from 'vitest'
import { addMonths, byDate, dayLabel, monthBodyHtml, monthWeeks } from './month-calendar'

describe('month calendar', () => {
  it('lays out a month Monday first', () => {
    // October 2026 starts on a Thursday and has 31 days.
    const weeks = monthWeeks('2026-10')
    expect(weeks[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    expect(weeks.at(-1)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', null])
    expect(monthWeeks('2027-02').flat().filter(Boolean)).toHaveLength(28)
  })
  it('steps months across years', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-10', -14)).toBe('2025-08')
  })
  it('links game nights and strikes nights that are off', () => {
    const days = byDate([
      { date: '2026-10-22', code: 'TNL', status: 'scheduled', note: '', games: 5 },
      { date: '2026-10-22', code: 'FNL', status: 'scheduled', note: '', games: 2 },
      { date: '2026-10-29', code: 'TNL', status: 'cancelled', note: 'Venue unavailable', games: 5 },
    ])
    expect(dayLabel(days.get('2026-10-22')!)).toBe('TNL, FNL · 7 games')
    expect(dayLabel(days.get('2026-10-29')!)).toBe('TNL cancelled: Venue unavailable')
    const html = monthBodyHtml('2026-10', days, '2026-10-20', (d) => `/leagues/fixtures?date=${d}`)
    expect(html).toContain('href="/leagues/fixtures?date=2026-10-22"')
    expect(html).toContain('class="cal-off"')
    expect(html).toContain('aria-current="date"')
    expect(html).not.toContain('date=2026-10-29')
  })
})
