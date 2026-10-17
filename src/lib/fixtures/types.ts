export type Team = { id: string; name: string }

/** A slot participant: either a real team or a finals placeholder like "1st" or "Winner SF1". */
export type Ref = { team: string } | { label: string }

export type Game = {
  id: string
  session: number
  /** Position within the session; the court name comes from courtName(). */
  court: number
  home: Ref
  away: Ref
  duty: Ref | null
  /** e.g. "Semi Final 1", "Grand Final" */
  title?: string
  /** The result as being entered. Blank until the organiser types it in. */
  result?: Result
  /**
   * The result as last published for the match day. Only this counts on the
   * ladder and the website, so edits stay private until they're republished.
   */
  publishedResult?: Result
}

/** Rally points in one set: [home, away]. */
export type SetScore = [home: number, away: number]

/** The most sets in a match (TVSL plays best of 5). */
export const MAX_SETS = 5

/**
 * Sets and (rally) points won by the home and away team. null = not entered
 * yet. Points may be missing on results saved before they were recorded.
 *
 * `sets` holds the score of each set (up to MAX_SETS). When it's present and
 * not empty, sets won and point totals are derived from it (see
 * effectiveResult in results.ts) and the four totals are only a fallback.
 */
export type Result = {
  home: number | null
  away: number | null
  homePoints?: number | null
  awayPoints?: number | null
  sets?: SetScore[]
}

/** Ladder points for each outcome. */
export type Points = { win: number; draw: number; loss: number }

/** As used on tempevb.com: 3 for a win, 2 for a draw, 1 for turning up. */
export const DEFAULT_POINTS: Points = { win: 3, draw: 2, loss: 1 }

export type WeekKind = 'regular' | 'semi' | 'final' | 'skip'

export type Week = {
  id: string
  kind: WeekKind
  date: string // YYYY-MM-DD
  /** Match day number (1-based); 0 for skipped weeks. */
  matchDay: number
  games: Game[]
  /** Reason shown for skipped weeks. */
  note?: string
  /**
   * Court names that differ from the season default, keyed by slotKey().
   * They belong to the slot, so a game dragged into a slot plays on its court.
   */
  courtOverrides?: Record<string, string>
  /** When this match day's results were last published (UTC ISO). match_days.results_published_at. */
  resultsPublishedAt?: string
}

export type SkipDate = { date: string; reason: string }

export type Settings = {
  name: string
  startDate: string // YYYY-MM-DD; weekday is the game night
  skipDates: SkipDate[]
  courts: string[]
  sessions: string[] // start times "HH:MM"
  sessionMinutes: number
  teams: Team[]
  meetings: number // times each pair plays
  includeFinals: boolean
  /** Missing in seasons saved before results existed; use DEFAULT_POINTS. */
  points?: Points
  /**
   * Teams referee each other. Social leagues do (the default when missing);
   * the Super League (TVSL) has Volleyball NSW referees, so no duty at all.
   */
  duty?: boolean
  seed: number
}

/** Whether a season assigns team duty. Missing means yes (social leagues). */
export const dutyEnabled = (s: Settings): boolean => s.duty !== false

export type Competition = {
  id: string
  settings: Settings
  weeks: Week[] | null
  /** True once the organiser has hand-edited the generated fixtures. */
  edited: boolean
  /** shapeKey() of the settings the fixtures were generated from. */
  generatedFrom?: string
  /** Published seasons take results; the draw itself is then locked. Missing = draft. */
  status?: 'draft' | 'published'
  publishedAt?: number
  updatedAt: number
}

export const isPublished = (c: Competition) => c.status === 'published' && !!c.weeks

export const isTeam = (r: Ref | null | undefined): r is { team: string } => !!r && 'team' in r

/**
 * A slot is a session plus a position in that session (Game.court). The
 * season's courts list gives each position its default court name.
 */
export const slotKey = (session: number, position: number) => `${session}:${position}`

export const defaultCourt = (s: Settings, position: number): string => s.courts[position] ?? ''

/** The court a slot is played on that week: its override, else the season default. */
export const courtName = (s: Settings, w: Week, session: number, position: number): string =>
  w.courtOverrides?.[slotKey(session, position)] ?? defaultCourt(s, position)

export const refKey = (r: Ref | null): string => (r === null ? '' : isTeam(r) ? `t:${r.team}` : `l:${r.label}`)
