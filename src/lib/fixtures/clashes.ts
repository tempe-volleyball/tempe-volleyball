import { addMinutes, formatAU, minutesOf } from './dates'
import { courtName, type Settings, type Week } from './types'

/**
 * Several leagues run at once (TNL, FNL, SNL, SAL, TVSL) and can share a
 * venue, so a court can be double-booked across seasons even when each
 * season's own draw is clean (validate() covers clashes within a season).
 */

/** One season's draw, with where it's played. */
export type SeasonDraw = {
  seasonId: string
  /** Shown in messages, e.g. "TNL Q4 2026". */
  label: string
  /** The venue (place) its courts belong to: a venue id or name. "Court 1" at Tempe isn't "Court 1" at Five Dock. */
  venue: string
  settings: Settings
  weeks: Week[]
}

/** A court taken for one game: date, start and end time (Sydney, HH:MM). */
export type Booking = {
  seasonId: string
  label: string
  weekId: string
  gameId: string
  date: string
  start: string
  end: string
  venue: string
  court: string
}

export type CourtClash = { date: string; venue: string; court: string; bookings: [Booking, Booking]; message: string }

const norm = (s: string) => s.trim().toLowerCase()

/** Every court booking in a season. Games without a time or a court can't clash and are left out. */
export function seasonBookings(d: SeasonDraw): Booking[] {
  const out: Booking[] = []
  for (const w of d.weeks) {
    if (w.kind === 'skip') continue
    for (const g of w.games) {
      const start = d.settings.sessions[g.session]
      const court = courtName(d.settings, w, g.session, g.court)
      if (!start || !court.trim()) continue
      out.push({
        seasonId: d.seasonId,
        label: d.label,
        weekId: w.id,
        gameId: g.id,
        date: w.date,
        start,
        end: addMinutes(start, d.settings.sessionMinutes),
        venue: d.venue,
        court,
      })
    }
  }
  return out
}

/** Do two bookings' times overlap? Back to back (one ends as the other starts) is fine. */
export function overlaps(a: Pick<Booking, 'start' | 'end'>, b: Pick<Booking, 'start' | 'end'>): boolean {
  const end = (x: Pick<Booking, 'start' | 'end'>) => {
    const e = minutesOf(x.end)
    return e <= minutesOf(x.start) ? e + 24 * 60 : e // runs past midnight
  }
  return minutesOf(a.start) < end(b) && minutesOf(b.start) < end(a)
}

/**
 * Courts booked by two different seasons at the same venue, on the same date,
 * at overlapping times. Sessions can differ in length (TVSL plays 90 minutes),
 * so times are compared as ranges, not just start times.
 */
export function courtClashes(draws: SeasonDraw[]): CourtClash[] {
  const groups = new Map<string, Booking[]>()
  for (const d of draws)
    for (const b of seasonBookings(d)) {
      const key = `${b.date}|${norm(b.venue)}|${norm(b.court)}`
      const list = groups.get(key)
      if (list) list.push(b)
      else groups.set(key, [b])
    }
  const clashes: CourtClash[] = []
  for (const list of groups.values())
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!
        const b = list[j]!
        if (a.seasonId === b.seasonId || !overlaps(a, b)) continue
        clashes.push({
          date: a.date,
          venue: a.venue,
          court: a.court,
          bookings: [a, b],
          message: `${a.court} on ${formatAU(a.date)}: ${a.label} at ${a.start} and ${b.label} at ${b.start} overlap.`,
        })
      }
  return clashes.sort((x, y) => x.date.localeCompare(y.date) || x.bookings[0].start.localeCompare(y.bookings[0].start))
}
