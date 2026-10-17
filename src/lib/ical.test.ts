import { describe, expect, it } from 'vitest'
import { buildCalendar, escapeText, foldLine, icalUtc, webcalUrl } from './ical'

describe('ical text', () => {
  it('escapes TEXT values', () => {
    expect(escapeText('A, B; C\\D\nE')).toBe('A\\, B\\; C\\\\D\\nE')
  })
  it('writes UTC instants', () => {
    expect(icalUtc('2026-10-22T09:00:00.000Z')).toBe('20261022T090000Z')
    expect(() => icalUtc('nope')).toThrow(/Not an instant/)
  })
  it('folds at 75 octets without splitting a character', () => {
    const line = `SUMMARY:${'é'.repeat(60)}`
    const folded = foldLine(line)
    const parts = folded.split('\r\n')
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75)
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true)
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line)
    expect(foldLine('SHORT:1')).toBe('SHORT:1')
  })
  it('turns https into webcal', () => {
    expect(webcalUrl('https://www.tempevb.com/leagues/tnl/calendar.ics')).toBe('webcal://www.tempevb.com/leagues/tnl/calendar.ics')
  })
})

describe('buildCalendar', () => {
  const cal = buildCalendar({
    name: 'Thursday Night League – Tempe Volleyball',
    now: new Date('2026-10-18T00:00:00Z'),
    events: [
      {
        uid: 'm1@tempevb.com',
        start: '2026-10-22T09:00:00.000Z',
        end: '2026-10-22T10:00:00.000Z',
        summary: 'TNL: Aces vs Blockers',
        location: 'Court 1, Robyn Webster Sports Centre',
        description: 'Match day 3\nDuty: Chaos',
        status: 'CANCELLED',
        url: 'https://www.tempevb.com/leagues/tnl',
      },
    ],
  })
  it('is a valid VCALENDAR with CRLF line endings', () => {
    expect(cal.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true)
    expect(cal.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(cal.replace(/\r\n/g, '')).not.toMatch(/\n/)
  })
  it('writes each event with a stable UID and the fields given', () => {
    expect(cal).toContain('UID:m1@tempevb.com\r\n')
    expect(cal).toContain('DTSTART:20261022T090000Z\r\n')
    expect(cal).toContain('DTEND:20261022T100000Z\r\n')
    expect(cal).toContain('DTSTAMP:20261018T000000Z\r\n')
    expect(cal).toContain('LOCATION:Court 1\\, Robyn Webster Sports Centre\r\n')
    expect(cal).toContain('DESCRIPTION:Match day 3\\nDuty: Chaos\r\n')
    expect(cal).toContain('STATUS:CANCELLED\r\n')
    expect(cal).toContain('X-WR-TIMEZONE:Australia/Sydney')
  })
})
