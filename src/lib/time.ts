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

/** Formats integer cents as AUD, e.g. 12500 -> "$125.00". Store money as integer cents everywhere. */
export function formatAud(cents: number): string {
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY }).format(cents / 100)
}
