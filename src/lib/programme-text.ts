import type { ProgrammeLineSource } from './content/blocks'
import { parseISO } from './fixtures/dates'
import type { ProgrammeKind } from '../server/db/schema/enums'

// The generated text for a programme wherever it's listed (docs/admin.md §3.1, §3.4): its day and times, venue,
// "next starts" line and one-line summary. Pure and shared, so the admin preview, the public pages and the
// Programme list block all say the same thing. Every generated string can be replaced by hand on the programme
// (schedule_label, summary_line, next_starts_text); the helpers here only fill the gaps.

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "2027-01-14" -> "Thursday 14 January 2027" (no Intl, so it reads the same in every runtime). */
export function formatDateLong(date: string): string {
  const d = parseISO(date)
  if (Number.isNaN(d.getTime())) return ''
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

/** "20:00" -> { h: 8, m: 0, pm: true }. Null for anything that isn't HH:MM. */
function parts(hhmm: string | null | undefined) {
  const m = hhmm ? TIME.exec(hhmm) : null
  if (!m) return null
  const h = Number(m[1])
  return { h: h % 12 === 0 ? 12 : h % 12, m: Number(m[2]), pm: h >= 12 }
}

const clock = (p: { h: number; m: number }) => (p.m ? `${p.h}:${String(p.m).padStart(2, '0')}` : String(p.h))

/** "20:00" -> "8pm", "18:30" -> "6:30pm", "12:00" -> "12pm". '' for a missing or malformed time. */
export function formatTime(hhmm: string | null | undefined): string {
  const p = parts(hhmm)
  return p ? `${clock(p)}${p.pm ? 'pm' : 'am'}` : ''
}

/**
 * "20:00"–"22:00" -> "8–10pm" (one am/pm when both share it), "11:00"–"13:00" -> "11am–1pm", a start alone -> "8pm".
 * '' when there's no start time.
 */
export function formatTimeRange(start: string | null | undefined, end: string | null | undefined): string {
  const s = parts(start)
  if (!s) return ''
  const e = parts(end)
  if (!e) return formatTime(start)
  if (s.pm === e.pm) return `${clock(s)}–${clock(e)}${e.pm ? 'pm' : 'am'}`
  return `${formatTime(start)}–${formatTime(end)}`
}

/** The fields the generated text reads. A programme row (leagues) satisfies it. */
export type ProgrammeTextInput = {
  kind: ProgrammeKind
  name: string
  code: string
  weekday: number
  startTime: string | null
  endTime: string | null
  /** Hand-written day-and-times text; wins over the generated one. */
  scheduleLabel: string | null
  /** Hand-written summary line; wins over the generated one. */
  summaryLine: string | null
  nextStartsOn: string | null
  nextStartsText: string | null
}

export type VenueTextInput = { name: string; address: string | null } | null | undefined

/**
 * The suburb from an address: "Holbeach Ave, Tempe NSW 2044" -> "Tempe". It's the last comma-separated part with any
 * state and postcode dropped. '' when the address has no comma (we can't tell the street from the suburb).
 */
export function venueSuburb(address: string | null | undefined): string {
  if (!address) return ''
  const segments = address
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (segments.length < 2) return ''
  const last = segments.at(-1)!
  return last
    .replace(/\b(NSW|ACT|VIC|QLD|SA|WA|TAS|NT)\b/i, '')
    .replace(/\b\d{4}\b/, '')
    .replace(/\bAustralia\b/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "Robyn Webster Sports Centre, Tempe": the name plus the suburb when it isn't already in the name. */
export function venueText(venue: VenueTextInput): string {
  if (!venue) return ''
  const suburb = venueSuburb(venue.address)
  return suburb && !venue.name.toLowerCase().includes(suburb.toLowerCase()) ? `${venue.name}, ${suburb}` : venue.name
}

/**
 * The day and times as shown: the hand-written label, else "Thursdays 8–10pm" (events: just the times, since they
 * run on dates, not a weekly day).
 */
export function scheduleText(p: Pick<ProgrammeTextInput, 'kind' | 'weekday' | 'startTime' | 'endTime' | 'scheduleLabel'>): string {
  const label = p.scheduleLabel?.trim()
  if (label) return label
  const times = formatTimeRange(p.startTime, p.endTime)
  if (p.kind === 'event') return times
  const day = WEEKDAYS[p.weekday]
  return day ? `${day}s${times ? ` ${times}` : ''}` : times
}

/**
 * The generated one-line summary: "Thursday Night League (TNL) @ Robyn Webster Sports Centre, Tempe, Thursdays 8–10pm".
 * The code is left out when the name already contains it.
 */
export function generatedSummaryLine(p: ProgrammeTextInput, venue: VenueTextInput): string {
  const code = p.code && !p.name.toUpperCase().includes(p.code.toUpperCase()) ? ` (${p.code})` : ''
  const where = venueText(venue)
  const when = scheduleText(p)
  return `${p.name}${code}${where ? ` @ ${where}` : ''}${when ? `, ${when}` : ''}`
}

/** What's shown: the programme's own summary line, else the generated one. */
export function summaryLine(p: ProgrammeTextInput, venue: VenueTextInput): string {
  return p.summaryLine?.trim() || generatedSummaryLine(p, venue)
}

/** The word for the next instance in "Next … starts": season, session, term or event. */
export const INSTANCE_NOUN = { league: 'season', training: 'session', development: 'term', event: 'event' } as const satisfies Record<
  ProgrammeKind,
  string
>

/**
 * The "Next season starts …" text: the hand-written text, else "Next season starts Thursday 15 January 2026" from the
 * programme's own date or, failing that, `nextInstanceDate` (the start of its next season/session/term/event, which
 * the caller looks up). '' when there's nothing to say.
 */
export function nextStartsLine(
  p: Pick<ProgrammeTextInput, 'kind' | 'nextStartsOn' | 'nextStartsText'>,
  nextInstanceDate: string | null | undefined,
): string {
  const text = p.nextStartsText?.trim()
  if (text) return text
  const date = p.nextStartsOn ?? nextInstanceDate
  return date ? `Next ${INSTANCE_NOUN[p.kind]} starts ${formatDateLong(date)}` : ''
}

/**
 * The details a Programme list block line is generated from (ProgrammeLineSource), so an override can be compared
 * with the programme as it is now (changedSourceFields in src/lib/content/blocks.ts).
 */
export function programmeLineSource(
  p: ProgrammeTextInput,
  venue: VenueTextInput,
  nextInstanceDate: string | null | undefined,
): ProgrammeLineSource {
  return {
    name: p.name,
    code: p.code,
    venue: venueText(venue),
    times: scheduleText(p),
    nextStarts: nextStartsLine(p, nextInstanceDate),
    summaryLine: p.summaryLine?.trim() ?? '',
  }
}
