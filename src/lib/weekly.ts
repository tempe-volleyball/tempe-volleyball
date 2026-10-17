import { addDays, parseISO } from './fixtures/dates'

// Weekly date runs for "add weekly sessions from X to Y" (training sessions and development-term sessions). Pure:
// dates are YYYY-MM-DD strings handled in UTC, so there's no time-zone drift.

export const weekdayOf = (date: string) => parseISO(date).getUTCDay()

/**
 * Every `everyWeeks`-th `weekday` (0 = Sunday) from `from` to `to` inclusive, starting at the first such day on or
 * after `from`, minus `skip`. At most `max` dates (the caller refuses longer runs).
 */
export function weeklyDates(
  from: string,
  to: string,
  weekday: number,
  opts: { everyWeeks?: number; skip?: Iterable<string>; max?: number } = {},
): string[] {
  const every = Math.max(1, Math.floor(opts.everyWeeks ?? 1))
  const skip = new Set(opts.skip ?? [])
  const max = opts.max ?? 200
  const out: string[] = []
  if (to < from) return out
  let d = addDays(from, (weekday - weekdayOf(from) + 7) % 7)
  for (let guard = 0; d <= to && guard < 1000; guard++, d = addDays(d, 7 * every)) {
    if (skip.has(d)) continue
    out.push(d)
    if (out.length >= max) break
  }
  return out
}
