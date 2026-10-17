import { publishProblem, weekResultsState, type WeekResultsState } from './results'
import type { Week } from './types'

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
export const dayPublishProblem = (w: Week, cancelled: ReadonlySet<string>): string | null => {
  const playing = withoutCancelled(w, cancelled)
  return playing.games.length === 0 ? null : publishProblem(playing)
}
