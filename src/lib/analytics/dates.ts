// Plain YYYY-MM-DD arithmetic (on UTC midnights, so no DST surprises) and a source's "today".

export const addDays = (date: string, days: number): string => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

export const isIsoDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const t = Date.parse(`${s}T00:00:00Z`)
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(s)
}

/** The calendar date of an instant in a time zone. */
export function dateIn(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at)
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** Every date from..to inclusive (capped at ~11 years). */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to && out.length < 4000; d = addDays(d, 1)) out.push(d)
  return out
}

/** "20261017" (GA4) -> "2026-10-17". */
export const compactDate = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s)
