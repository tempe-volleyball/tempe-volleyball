import { addDays, formatAU } from './dates'
import { isComplete } from './results'
import { isOffStatus } from './status'
import { courtName, dutyEnabled, isTeam, type Game, type Ref, type Settings, type Week } from './types'

// Moving one game to another night (docs/admin.md §1 "Matches"): a postponed game replayed on a later night, or any
// game without a published result rescheduled on its own. The target is a night already in the season or a new
// catch-up night on a date of your choosing, and a free slot (session and court position) on it. The admin previews
// the plan with this function and the server runs it again on its own copy before saving, as with pushBack().
//
// The game keeps its id (so its draft result and duty stay attached) and remembers the night it was first scheduled
// on (Game.originalWeekId, matches.original_match_day_id): that night lists it as "moved to …", the new one as
// "moved from …". A postponed or TBD game becomes scheduled again. Court clashes with other leagues are checked by
// the caller with courtClashes() on the plan's weeks.

/**
 * The date a new catch-up night defaults to: the first free week after the game's night (same weekday) that's
 * before the finals, so a round-robin game is played before the finals are seeded. When no week before the finals is
 * free, the first free week after the season (`beforeFinals` false: the dialog says so).
 */
export function suggestCatchUpDate(weeks: Week[], fromDate: string): { date: string; beforeFinals: boolean } {
  const taken = new Set(weeks.map((w) => w.date))
  const finals = weeks.find((w) => w.kind === 'semi' || w.kind === 'final')?.date
  for (let d = addDays(fromDate, 7), i = 0; i < 52 && (!finals || d < finals); d = addDays(d, 7), i++)
    if (!taken.has(d)) return { date: d, beforeFinals: true }
  let d = addDays(weeks.at(-1)?.date ?? fromDate, 7)
  while (taken.has(d)) d = addDays(d, 7)
  return { date: d, beforeFinals: !finals }
}

/** Where to move a game: a night by id, or a date (an existing night on that date, or a new one with `newWeekId`). */
export type MoveTarget = { weekId?: string; date?: string; newWeekId?: string; session: number; position: number }

export type MovePlan = {
  /** The whole draw after the move. */
  weeks: Week[]
  from: Week
  /** The night it moves to, after the move. */
  to: Week
  /** True when `to` is a new night (to insert). */
  created: boolean
  game: Game
  /** Fine to go ahead, but worth knowing: a double header, a duty team that isn't playing that night. */
  warnings: string[]
}

export type MoveResult = { plan: MovePlan; problem: null } | { plan: null; problem: string }

const fail = (problem: string): MoveResult => ({ plan: null, problem })

const teamOf = (r: Ref | null) => (isTeam(r) ? r.team : null)

/** Plans moving `gameId` to `target`, or says why it can't move. Pure. */
export function moveToNight(s: Settings, weeks: Week[], gameId: string, target: MoveTarget): MoveResult {
  const from = weeks.find((w) => w.games.some((g) => g.id === gameId))
  const game = from?.games.find((g) => g.id === gameId)
  if (!from || !game) return fail('That game isn’t in this season’s draw.')
  if (isComplete(game.publishedResult)) return fail('That game already has a published result, so it can’t move.')
  if (!Number.isInteger(target.session) || target.session < 0 || target.session >= s.sessions.length)
    return fail('Pick one of the season’s session times.')
  if (!Number.isInteger(target.position) || target.position < 0 || target.position >= s.courts.length)
    return fail('Pick one of the season’s courts.')

  let to = target.weekId ? weeks.find((w) => w.id === target.weekId) : target.date ? weeks.find((w) => w.date === target.date) : undefined
  let created = false
  if (target.weekId && !to) return fail('That night isn’t in this season.')
  if (!to) {
    if (!target.date || !/^\d{4}-\d{2}-\d{2}$/.test(target.date)) return fail('Pick a night, or a date for a new one.')
    if (!target.newWeekId) return fail('A new night needs an id.')
    // A catch-up night: same kind and match day number as the game's own night.
    to = { id: target.newWeekId, kind: from.kind, date: target.date, matchDay: from.matchDay, games: [] }
    created = true
  }
  if (to.kind === 'skip') return fail(`${formatAU(to.date)} is a week off. Pick a night with games, or another date.`)
  if (to.status) return fail(`The night of ${formatAU(to.date)} is ${to.status}. Pick another night.`)
  if (to.id === from.id) return fail('That’s the night it’s already on. Pick another night.')
  if (to.games.some((g) => g.session === target.session && g.court === target.position)) return fail('That slot is taken. Pick a free one.')
  const court = courtName(s, to, target.session, target.position)
  if (!court.trim()) return fail('That slot has no court. Pick another, or set its court on the Fixtures tab.')
  const sameCourt = to.games.find((g) => g.session === target.session && courtName(s, to, g.session, g.court) === court)
  if (sameCourt) return fail(`${court} is already in use at ${s.sessions[target.session]} that night.`)

  const name = (id: string) => s.teams.find((t) => t.id === id)?.name ?? 'A team'
  const warnings: string[] = []
  const sessionsOf = (team: string) => to.games.filter((g) => teamOf(g.home) === team || teamOf(g.away) === team).map((g) => g.session)
  for (const team of [teamOf(game.home), teamOf(game.away)]) {
    if (!team) continue
    const ss = sessionsOf(team)
    if (ss.includes(target.session)) return fail(`${name(team)} already plays at ${s.sessions[target.session]} that night.`)
    if (ss.length > 0) warnings.push(`${name(team)} also plays at ${ss.map((x) => s.sessions[x]).join(', ')} that night (a double header).`)
  }
  const duty = teamOf(game.duty)
  if (duty && dutyEnabled(s)) {
    const ss = sessionsOf(duty)
    const playsMoved = duty === teamOf(game.home) || duty === teamOf(game.away)
    if (playsMoved || ss.includes(target.session))
      return fail(`${name(duty)} is on duty for this game but plays at the same time there. Pick another slot.`)
    if (ss.length === 0) warnings.push(`${name(duty)} has duty for this game but doesn’t play that night: check they can make it.`)
  }

  const moved: Game = { ...game, session: target.session, court: target.position }
  const original = game.originalWeekId ?? from.id
  if (original === to.id) delete moved.originalWeekId
  else moved.originalWeekId = original
  if (isOffStatus(moved.status)) {
    delete moved.status
    delete moved.statusNote
  }
  const sort = (games: Game[]) => games.toSorted((a, b) => a.session - b.session || a.court - b.court)
  const newTo: Week = { ...to, games: sort([...to.games, moved]) }
  const newFrom: Week = { ...from, games: from.games.filter((g) => g.id !== gameId) }
  const next = (created ? [...weeks, newTo] : weeks)
    .map((w) => (w.id === from.id ? newFrom : w.id === newTo.id ? newTo : w))
    .toSorted((a, b) => a.date.localeCompare(b.date))
  return { plan: { weeks: next, from: newFrom, to: newTo, created, game: moved, warnings }, problem: null }
}

/** Games moved away from this night on their own (shown there as "moved to …"), with the night each is on now. */
export function movedAway(weeks: Week[], weekId: string): { game: Game; to: Week }[] {
  return weeks.flatMap((to) => (to.id === weekId ? [] : to.games.filter((g) => g.originalWeekId === weekId).map((game) => ({ game, to }))))
}
