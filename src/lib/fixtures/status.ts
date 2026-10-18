import { publishProblem, weekResultsState, type WeekResultsState } from './results'
import type { Game, LevelSetsRule, Week } from './types'

// Cancelled games. The lib's Game doesn't carry a status (matches.status does: scheduled, played, forfeit,
// cancelled), so these take the ids of the day's cancelled games. A cancelled game needs no result to publish its
// match day, and publishing drops any result it had. A forfeit is an ordinary result (the score the organiser
// records) with a label, so it needs nothing here.

/** The match day without its cancelled games. */
export const withoutCancelled = (w: Week, cancelled: ReadonlySet<string>): Week =>
  cancelled.size === 0 ? w : { ...w, games: w.games.filter((g) => !cancelled.has(g.id)) }

/** weekResultsState(), with cancelled games left out. */
export function dayResultsState(w: Week, cancelled: ReadonlySet<string>): WeekResultsState {
  const playing = withoutCancelled(w, cancelled)
  // A cancelled game that still has a published result loses it on the next publish.
  const dropping = w.games.some((g) => cancelled.has(g.id) && g.publishedResult)
  if (playing.games.length === 0) return w.resultsPublishedAt && !dropping ? 'published' : w.games.length > 0 ? 'ready' : 'empty'
  const state = weekResultsState(playing)
  return state === 'published' && dropping ? 'changed' : state
}

/** publishProblem(), with cancelled games left out (a night where every game was cancelled can be published). */
export const dayPublishProblem = (w: Week, cancelled: ReadonlySet<string>, levelSets: LevelSetsRule = 'draw'): string | null => {
  const playing = withoutCancelled(w, cancelled)
  return playing.games.length === 0 ? null : publishProblem(playing, levelSets)
}

/**
 * Games that aren't being played as scheduled: cancelled (never played), postponed (to be replayed) and tbd (date
 * or time to be decided). They take no result and don't hold up publishing their match day, like cancelled games.
 */
export const OFF_STATUSES = ['cancelled', 'postponed', 'tbd'] as const
export type OffStatus = (typeof OFF_STATUSES)[number]

export const isOffStatus = (status: string | null | undefined): status is OffStatus =>
  !!status && (OFF_STATUSES as readonly string[]).includes(status)

/** The game's own status (Game.status) is off. */
export const isOff = (g: Pick<Game, 'status'>) => isOffStatus(g.status)

/** Ids of a week's off games, for withoutCancelled / dayResultsState / dayPublishProblem. */
export const offGameIds = (
  w: Week,
  statusOf: (gameId: string) => string | null | undefined = (id) => w.games.find((g) => g.id === id)?.status,
) => new Set(w.games.filter((g) => isOffStatus(statusOf(g.id))).map((g) => g.id))

/** How a status reads in the admin and on the public fixtures. */
export const MATCH_STATUS_LABEL: Record<string, string> = {
  scheduled: 'Scheduled',
  played: 'Played',
  forfeit: 'Forfeit',
  cancelled: 'Cancelled',
  postponed: 'Postponed',
  tbd: 'TBD',
}
