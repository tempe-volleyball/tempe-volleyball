/** Everything the site shows is in Sydney time and AUD. Never rely on the Worker's clock zone (UTC). */
export const TIME_ZONE = 'Australia/Sydney'
export const CURRENCY = 'AUD'
export const LOCALE = 'en-AU'

/** Wall-clock date and time in Sydney for an instant, e.g. "2026-10-17 15:30" (DST aware). */
export function sydneyDateTime(at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** The Sydney calendar date of an instant, "YYYY-MM-DD" (e.g. the day an email counts against the daily cap). */
export const sydneyDate = (at: Date): string => sydneyDateTime(at).slice(0, 10)

/** Whole days from one "YYYY-MM-DD" to another (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

/** "today", "tomorrow", "in 4 days", "yesterday", "3 days ago". */
export function relativeDays(n: number): string {
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n === -1) return 'yesterday'
  return n > 0 ? `in ${n} days` : `${-n} days ago`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** An instant as an RFC 822 date in Sydney time, for RSS: "Mon, 11 Dec 2023 22:30:00 +1100" (DST aware). */
export function rfc822Sydney(at: Date): string {
  const wall = sydneyDateTime(at) // "2023-12-11 22:30"
  const wallMs = Date.parse(`${wall.replace(' ', 'T')}:00Z`)
  const offsetMin = Math.round((wallMs - (at.getTime() - at.getUTCSeconds() * 1000 - at.getUTCMilliseconds())) / 60_000)
  const local = new Date(wallMs + at.getUTCSeconds() * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const sign = offsetMin < 0 ? '-' : '+'
  const abs = Math.abs(offsetMin)
  return (
    `${DAYS[local.getUTCDay()]}, ${pad(local.getUTCDate())} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  )
}

/**
 * A Sydney wall-clock time ("2026-10-18T09:00" or "2026-10-18 09:00", as a datetime-local input gives it) as a UTC
 * ISO instant, DST aware. Null for anything else. In the hour skipped when DST starts it lands an hour later; in the
 * repeated hour when DST ends it picks one of the two.
 */
export function sydneyToUtc(local: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)$/.exec(local.trim())
  if (!m) return null
  const wanted = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`)
  if (Number.isNaN(wanted)) return null
  let t = wanted
  for (let i = 0; i < 3; i++) {
    const wall = Date.parse(`${sydneyDateTime(new Date(t)).replace(' ', 'T')}:00Z`)
    if (wall === wanted) break
    t -= wall - wanted
  }
  return new Date(t).toISOString()
}

/** The datetime-local value ("2026-10-18T09:00") for a UTC instant, in Sydney time. '' for null. */
export const utcToSydneyInput = (iso: string | null | undefined): string => (iso ? sydneyDateTime(new Date(iso)).replace(' ', 'T') : '')

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

/** "20:00" -> { h: 8, m: 0, pm: true }. Null for anything that isn't HH:MM. */
function clockParts(hhmm: string | null | undefined) {
  const m = hhmm ? CLOCK.exec(hhmm) : null
  if (!m) return null
  const h = Number(m[1])
  return { h: h % 12 === 0 ? 12 : h % 12, m: Number(m[2]), pm: h >= 12 }
}

const clock = (p: { h: number; m: number }) => (p.m ? `${p.h}:${String(p.m).padStart(2, '0')}` : String(p.h))

/** A Sydney wall-clock "HH:MM": "20:00" -> "8pm", "18:30" -> "6:30pm", "12:00" -> "12pm". '' for a missing or malformed time. */
export function formatTime(hhmm: string | null | undefined): string {
  const p = clockParts(hhmm)
  return p ? `${clock(p)}${p.pm ? 'pm' : 'am'}` : ''
}

/**
 * The one time-range format used everywhere (tables, form choices, emails): "18:00"–"20:00" -> "6–8pm" (one am/pm
 * when both share it), "11:00"–"13:00" -> "11am–1pm", a start alone -> "6pm". '' when there's no start time.
 */
export function formatTimeRange(start: string | null | undefined, end: string | null | undefined): string {
  const s = clockParts(start)
  if (!s) return ''
  const e = clockParts(end)
  if (!e) return formatTime(start)
  if (s.pm === e.pm) return `${clock(s)}–${clock(e)}${e.pm ? 'pm' : 'am'}`
  return `${formatTime(start)}–${formatTime(end)}`
}

/** Formats integer cents as AUD, e.g. 12500 -> "$125.00". Store money as integer cents everywhere. */
export function formatAud(cents: number): string {
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY }).format(cents / 100)
}
