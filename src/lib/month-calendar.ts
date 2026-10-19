// The home page calendar (docs/public-site.md "Calendar"): a month of game nights, Monday first. Pure, so the
// server renders the first month and the browser re-renders others instantly from the same function, with no
// requests. Dates are YYYY-MM-DD in Sydney time.

export type MonthNight = { date: string; code: string; status: string; note: string; games: number }

export const WEEKDAYS = [
  ['M', 'Monday'],
  ['T', 'Tuesday'],
  ['W', 'Wednesday'],
  ['T', 'Thursday'],
  ['F', 'Friday'],
  ['S', 'Saturday'],
  ['S', 'Sunday'],
] as const

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`

/** "2026-10" plus `delta` months. */
export function addMonths(ym: string, delta: number): string {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7)) - 1 + delta
  const year = y + Math.floor(m / 12)
  const month = ((m % 12) + 12) % 12
  return `${year}-${String(month + 1).padStart(2, '0')}`
}

/** The month's weeks, Monday to Sunday: each cell a YYYY-MM-DD in the month, or null for padding. */
export function monthWeeks(ym: string): (string | null)[][] {
  const y = Number(ym.slice(0, 4))
  const m = Number(ym.slice(5, 7))
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`),
  ]
  while (cells.length % 7) cells.push(null)
  return Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7))
}

export type DayInfo = { leagues: string[]; games: number; off: { code: string; status: string; note: string }[] }

/** The nights grouped by date. */
export function byDate(nights: readonly MonthNight[]): Map<string, DayInfo> {
  const out = new Map<string, DayInfo>()
  for (const n of nights) {
    const d = out.get(n.date) ?? { leagues: [], games: 0, off: [] }
    if (n.status === 'scheduled') {
      if (!d.leagues.includes(n.code)) d.leagues.push(n.code)
      d.games += n.games
    } else d.off.push({ code: n.code, status: n.status, note: n.note })
    out.set(n.date, d)
  }
  return out
}

/** The tooltip and accessible label for a day: "TNL, FNL · 7 games", "TNL cancelled: venue unavailable". */
export function dayLabel(d: DayInfo): string {
  const parts: string[] = []
  if (d.leagues.length) parts.push(`${d.leagues.join(', ')} · ${d.games} ${d.games === 1 ? 'game' : 'games'}`)
  for (const o of d.off) parts.push(`${o.code} ${o.status}${o.note ? `: ${o.note}` : ''}`)
  return parts.join('; ')
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * The month's <tbody> rows as HTML. A day with games links to that night's games (`dayHref`); a night that's off
 * (every league on it cancelled or postponed) is struck through, with the reason as its title.
 */
export function monthBodyHtml(ym: string, days: Map<string, DayInfo>, today: string, dayHref: (date: string) => string): string {
  return monthWeeks(ym)
    .map(
      (week) =>
        `<tr>${week
          .map((date) => {
            if (!date) return '<td class="cal-pad"></td>'
            const n = Number(date.slice(8))
            const d = days.get(date)
            const now = date === today ? ' aria-current="date"' : ''
            const cls = [date === today ? 'cal-today' : '', d && !d.leagues.length ? 'cal-off' : ''].filter(Boolean).join(' ')
            const attrs = `${cls ? ` class="${cls}"` : ''}${now}`
            if (!d) return `<td${attrs}><span class="cal-day">${n}</span></td>`
            const label = esc(dayLabel(d))
            return d.leagues.length
              ? `<td${attrs}><a class="cal-day cal-games" href="${esc(dayHref(date))}" title="${label}"><span class="sr-only">${esc(dateLong(date))}: </span><span aria-hidden="true">${n}</span><span class="sr-only">, ${label}</span></a></td>`
              : `<td${attrs}><span class="cal-day" title="${label}"><span aria-hidden="true">${n}</span><span class="sr-only">${esc(dateLong(date))}: ${label}</span></span></td>`
          })
          .join('')}</tr>`,
    )
    .join('')
}

const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const dateLong = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`)
  return `${LONG_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}
