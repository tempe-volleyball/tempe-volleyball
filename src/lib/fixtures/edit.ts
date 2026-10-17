import { defaultCourt, slotKey, type Game, type Ref, type Result, type Settings, type Week } from './types'

export type SlotAddress = { weekId: string; session: number; court: number }

const sortGames = (games: Game[]) => games.slice().sort((a, b) => a.session - b.session || a.court - b.court)

/**
 * Move a game into a slot (possibly in another week). If the slot is taken,
 * the two games swap places.
 */
export function moveGame(weeks: Week[], from: { weekId: string; gameId: string }, to: SlotAddress): Week[] {
  const src = weeks.find((w) => w.id === from.weekId)
  const game = src?.games.find((g) => g.id === from.gameId)
  if (!src || !game) return weeks
  if (src.id === to.weekId && game.session === to.session && game.court === to.court) return weeks
  const dst = weeks.find((w) => w.id === to.weekId)
  if (!dst || dst.kind === 'skip') return weeks
  const occupant = dst.games.find((g) => g.session === to.session && g.court === to.court)

  // Take both games out first, then put each in the other's slot. src and
  // dst may be the same week.
  return weeks.map((w) => {
    if (w.id !== src.id && w.id !== dst.id) return w
    const games = w.games.filter((g) => g.id !== game.id && g.id !== occupant?.id)
    if (w.id === dst.id) games.push({ ...game, session: to.session, court: to.court })
    if (w.id === src.id && occupant) games.push({ ...occupant, session: game.session, court: game.court })
    return { ...w, games: sortGames(games) }
  })
}

/** Set the court for one slot in one week. The season default (or blank) clears the override. */
export function setCourt(weeks: Week[], s: Settings, weekId: string, session: number, position: number, name: string): Week[] {
  const value = name.trim()
  const key = slotKey(session, position)
  return weeks.map((w) => {
    if (w.id !== weekId) return w
    const courtOverrides = { ...w.courtOverrides }
    delete courtOverrides[key]
    if (value && value !== defaultCourt(s, position)) courtOverrides[key] = value
    return { ...w, courtOverrides }
  })
}

/** Record a game's result as entered (all blank clears it). It isn't on the ladder until published. */
export function setResult(weeks: Week[], weekId: string, gameId: string, result: Result): Week[] {
  const blank =
    [result.home, result.away, result.homePoints, result.awayPoints].every((v) => v === null || v === undefined) && !result.sets?.length
  return weeks.map((w) =>
    w.id !== weekId ? w : { ...w, games: w.games.map((g) => (g.id !== gameId ? g : { ...g, result: blank ? undefined : result })) },
  )
}

/**
 * Publish a match day's entered results, replacing whatever was published
 * before, and stamp the time (it drives the ladder's "Updated" line).
 */
export function publishWeekResults(weeks: Week[], weekId: string, at: Date = new Date()): Week[] {
  return weeks.map((w) =>
    w.id !== weekId ? w : { ...w, resultsPublishedAt: at.toISOString(), games: w.games.map((g) => ({ ...g, publishedResult: g.result })) },
  )
}

/** Throw away edits to a published match day. */
export function undoWeekResultChanges(weeks: Week[], weekId: string): Week[] {
  return weeks.map((w) => (w.id !== weekId ? w : { ...w, games: w.games.map((g) => ({ ...g, result: g.publishedResult })) }))
}

export function setRef(weeks: Week[], weekId: string, gameId: string, field: 'home' | 'away' | 'duty', ref: Ref | null): Week[] {
  return weeks.map((w) =>
    w.id !== weekId
      ? w
      : { ...w, games: w.games.map((g) => (g.id !== gameId ? g : { ...g, [field]: field === 'duty' ? ref : (ref ?? g[field]) })) },
  )
}

/** Swap who's listed first. */
export function flipGame(weeks: Week[], weekId: string, gameId: string): Week[] {
  return weeks.map((w) =>
    w.id !== weekId ? w : { ...w, games: w.games.map((g) => (g.id !== gameId ? g : { ...g, home: g.away, away: g.home })) },
  )
}
