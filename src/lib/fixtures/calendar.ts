import { addDays } from './dates'
import { isComplete } from './results'
import type { SkipDate, Week } from './types'

// Moving a whole night: "postpone this Thursday and push the rest of the season back a week". Pure, so the admin
// previews exactly what the server will save (the server runs the same function on its own copy of the season).
//
// The postponed night's date becomes a week off. That night and every later playing night move at least a week
// later, keep their order and their match day numbers, and step over weeks off and skip dates (public holidays),
// which stay where they are. Games keep their ids, so results, duty and courts stay attached.

export type NightMove = { weekId: string; from: string; to: string }

export type PushBackPlan = {
  /** The new week off on the postponed night's old date. */
  skipDate: string
  /** Every playing night that moves, in date order, with its old and new date. */
  moves: NightMove[]
  /** Skip dates the moved nights now step over that had no week of their own yet (they get one, as assignDates does). */
  newSkipWeeks: SkipDate[]
  /** The season's weeks afterwards, sorted by date (the new week off has id `skipId`). */
  weeks: Week[]
}

/** Why a night can't be postponed with the season pushed back, or null. */
export function pushBackProblem(weeks: Week[], weekId: string): string | null {
  const night = weeks.find((w) => w.id === weekId)
  if (!night) return 'That match day isn’t in this season.'
  if (night.kind === 'skip') return 'That’s already a week off.'
  const published = weeks.find(
    (w) => w.kind !== 'skip' && w.date >= night.date && (!!w.resultsPublishedAt || w.games.some((g) => isComplete(g.publishedResult))),
  )
  if (published)
    return `Match day ${published.matchDay} (${published.date}) already has published results, so the nights from ${night.date} on can’t move.`
  return null
}

/**
 * The season with one night postponed and everything after it pushed back. `skipDates` are the season's
 * (settings.skipDates): nights never land on them. The new week off gets `skipId`, `note` and `status`.
 */
export function pushBack(
  weeks: Week[],
  weekId: string,
  opts: { skipId: string; note: string; status: 'postponed' | 'cancelled'; skipDates?: SkipDate[]; newId?: () => string },
): PushBackPlan {
  const problem = pushBackProblem(weeks, weekId)
  if (problem) throw new Error(problem)
  const sorted = weeks.toSorted((a, b) => a.date.localeCompare(b.date))
  const night = sorted.find((w) => w.id === weekId)!
  const skipReasons = new Map((opts.skipDates ?? []).map((d) => [d.date, d.reason]))
  // Dates nothing may move onto: weeks off already in the season, the season's skip dates and the postponed night.
  const fixed = new Set([...sorted.filter((w) => w.kind === 'skip').map((w) => w.date), ...skipReasons.keys(), night.date])

  const moves: NightMove[] = []
  let prev = night.date
  for (const w of sorted) {
    if (w.kind === 'skip' || w.date < night.date) continue
    // At least a week after its old date and after the night before it; never on a week off.
    let to = addDays(w.date > prev ? w.date : prev, 7)
    while (fixed.has(to)) to = addDays(to, 7)
    moves.push({ weekId: w.id, from: w.date, to })
    prev = to
  }

  const last = moves.at(-1)?.to ?? night.date
  const existing = new Set(sorted.map((w) => w.date))
  const newSkipWeeks = [...skipReasons]
    .filter(([date]) => date > night.date && date < last && !existing.has(date))
    .map(([date, reason]) => ({ date, reason }))
    .toSorted((a, b) => a.date.localeCompare(b.date))

  const newId = opts.newId ?? (() => crypto.randomUUID())
  const to = new Map(moves.map((m) => [m.weekId, m]))
  const out: Week[] = sorted.map((w) => {
    const m = to.get(w.id)
    return m ? { ...w, date: m.to, originalDate: w.originalDate ?? m.from } : w
  })
  out.push({ id: opts.skipId, kind: 'skip', date: night.date, matchDay: 0, games: [], note: opts.note, status: opts.status })
  for (const d of newSkipWeeks) out.push({ id: newId(), kind: 'skip', date: d.date, matchDay: 0, games: [], note: d.reason || 'No games' })
  return { skipDate: night.date, moves, newSkipWeeks, weeks: out.toSorted((a, b) => a.date.localeCompare(b.date)) }
}

/** "Postponed – Venue unavailable" (or just "Postponed"), the public note on a night off. */
export const nightNote = (status: 'postponed' | 'cancelled', reason: string) =>
  `${status === 'postponed' ? 'Postponed' : 'Cancelled'}${reason.trim() ? ` – ${reason.trim()}` : ''}`
