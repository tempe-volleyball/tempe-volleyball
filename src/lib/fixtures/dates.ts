// Dates are handled as YYYY-MM-DD strings in UTC to avoid timezone drift.

export function parseISO(d: string): Date {
  const [y = NaN, m = NaN, day = NaN] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, day))
}

export function toISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(d: string, days: number): string {
  const dt = parseISO(d)
  dt.setUTCDate(dt.getUTCDate() + days)
  return toISO(dt)
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function weekdayName(d: string): string {
  return WEEKDAYS[parseISO(d).getUTCDay()] ?? ''
}

/** dd/mm/yyyy */
export function formatAU(d: string): string {
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

export function formatLong(d: string): string {
  return parseISO(d).toLocaleDateString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function addMinutes(time: string, minutes: number): string {
  const [h = 0, m = 0] = time.split(':').map(Number)
  const total = (h * 60 + m + minutes) % (24 * 60)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Minutes since midnight for "HH:MM". */
export function minutesOf(time: string): number {
  const [h = 0, m = 0] = time.split(':').map(Number)
  return h * 60 + m
}
