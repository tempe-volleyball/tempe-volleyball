// iCalendar (RFC 5545) feeds for fixtures: a league's or a team's games, subscribed to with a webcal:// link.
// Pure text building. Times are written in UTC (…Z), converted from Sydney local time by the caller, so no
// VTIMEZONE is needed and every client shows them in its own zone; X-WR-TIMEZONE hints Sydney for display.

export type CalendarEvent = {
  /** Stable across regenerations (a match id), so clients update events instead of duplicating them. */
  uid: string
  /** UTC ISO instants. */
  start: string
  end: string
  summary: string
  location?: string
  description?: string
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED'
  /** Absolute URL of the page the event comes from. */
  url?: string
}

export type Calendar = {
  name: string
  description?: string
  events: CalendarEvent[]
  /** DTSTAMP for every event: when the feed was generated. */
  now: Date
  /** How often clients should re-fetch (hours). */
  refreshHours?: number
}

export const ICAL_CONTENT_TYPE = 'text/calendar; charset=utf-8'

/** RFC 5545 TEXT escaping: backslash, semicolon, comma and newlines. */
export const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')

/** "2026-10-22T09:00:00.000Z" -> "20261022T090000Z". */
export function icalUtc(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new Error(`Not an instant: ${iso}`)
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

const encoder = new TextEncoder()

/** Folds a content line at 75 octets (continuation lines start with a space), never splitting a UTF-8 character. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= 75) return line
  const out: string[] = []
  let current = ''
  let size = 0
  for (const ch of line) {
    const n = encoder.encode(ch).length
    // The first line holds 75 octets; continuations hold 74 after their leading space.
    if (size + n > (out.length === 0 ? 75 : 74)) {
      out.push(current)
      current = ''
      size = 0
    }
    current += ch
    size += n
  }
  out.push(current)
  return out.join('\r\n ')
}

/** The whole feed, CRLF line endings, folded. */
export function buildCalendar(cal: Calendar): string {
  const stamp = icalUtc(cal.now.toISOString())
  const refresh = `PT${Math.max(1, Math.round(cal.refreshHours ?? 6))}H`
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tempe Volleyball//Fixtures//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(cal.name)}`,
    ...(cal.description ? [`X-WR-CALDESC:${escapeText(cal.description)}`] : []),
    'X-WR-TIMEZONE:Australia/Sydney',
    `REFRESH-INTERVAL;VALUE=DURATION:${refresh}`,
    `X-PUBLISHED-TTL:${refresh}`,
  ]
  for (const e of cal.events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icalUtc(e.start)}`,
      `DTEND:${icalUtc(e.end)}`,
      `SUMMARY:${escapeText(e.summary)}`,
    )
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`)
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`)
    if (e.url) lines.push(`URL:${e.url}`)
    lines.push(`STATUS:${e.status ?? 'CONFIRMED'}`, 'TRANSP:OPAQUE', 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(foldLine).join('\r\n') + '\r\n'
}

/** webcal://host/path for an https URL (calendar apps subscribe instead of downloading). */
export const webcalUrl = (url: URL | string) => String(url).replace(/^https?:/, 'webcal:')
