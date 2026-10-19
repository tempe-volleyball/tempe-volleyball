// Competition player groups (docs/interest.md "Players"): New interest, Last season, Past players and Retired,
// worked out from rosters and EOIs when shown, never stored. Pure: the server loads the rows (players/directory.ts)
// and the admin's player picker and Players screen show the result.

export const playerGroups = ['interest', 'last', 'past', 'retired', 'other'] as const
export type PlayerGroup = (typeof playerGroups)[number]

export const PLAYER_GROUP_LABELS: Record<PlayerGroup, string> = {
  interest: 'New interest',
  last: 'Last season',
  past: 'Past players',
  retired: 'Retired',
  other: 'Everyone else',
}

/** A season of the league being looked at, oldest to newest is not assumed: callers pass any order. */
export type SeasonRef = { id: string; startDate: string }

/**
 * Which season counts as "last season" and when "new interest" starts, for a league.
 *
 * - Building season `targetId`: last season is the latest season that starts before it; EOIs count from that
 *   season's start (no earlier season = any time).
 * - No target (the Players screen): last season is the latest season that has started by `today`; EOIs count from
 *   its start.
 */
export function leagueWindow(
  seasons: readonly SeasonRef[],
  opts: { targetId?: string | null; today: string },
): { lastSeasonId: string | null; interestSince: string | null } {
  const target = opts.targetId ? seasons.find((s) => s.id === opts.targetId) : undefined
  const before = target
    ? (s: SeasonRef) => s.id !== target.id && s.startDate < target.startDate
    : (s: SeasonRef) => s.startDate <= opts.today
  const last = seasons
    .filter(before)
    .sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : a.id < b.id ? 1 : -1))[0]
  return { lastSeasonId: last?.id ?? null, interestSince: last?.startDate ?? null }
}

export type GroupInput = {
  retiredAt: string | null
  /** Seasons of this league the player was on a roster for (ids). */
  leagueSeasonIds: readonly string[]
  /** Played in another league (any roster outside this league). */
  playedElsewhere: boolean
  /** Their open EOIs for this league: the YYYY-MM-DD (Sydney) or ISO each was sent. */
  openInterestDates: readonly string[]
}

/**
 * The group a competition player is in for a league. Retired wins; then a new EOI (sent on or after the window's
 * start; no window = any open EOI); then last season's roster; then any earlier roster (this league or another).
 * The target season's own roster doesn't count (a player placed this season keeps the group they came from).
 */
export function groupOf(
  p: GroupInput,
  w: { lastSeasonId: string | null; interestSince: string | null },
  targetId?: string | null,
): PlayerGroup {
  if (p.retiredAt) return 'retired'
  const since = w.interestSince
  if (p.openInterestDates.some((d) => !since || d.slice(0, 10) >= since)) return 'interest'
  const seasons = p.leagueSeasonIds.filter((id) => id !== targetId)
  if (w.lastSeasonId && seasons.includes(w.lastSeasonId)) return 'last'
  if (seasons.length > 0 || p.playedElsewhere) return 'past'
  return 'other'
}

/** A display name: "Sam Lee". */
export const playerName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim()

/** Case- and accent-insensitive search over name, email and phone ("sam l", "0412"). Every word must match. */
export function matchesSearch(
  p: { firstName: string; lastName: string; email?: string | null; phone?: string | null },
  q: string,
): boolean {
  const words = fold(q).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = fold(`${p.firstName} ${p.lastName} ${p.email ?? ''} ${(p.phone ?? '').replace(/\s+/g, '')}`)
  return words.every((w) => hay.includes(w))
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
