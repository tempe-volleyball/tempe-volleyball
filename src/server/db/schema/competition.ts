import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { id, timestamps, updatedBy, wpId } from './columns'
import { leagueCodes, leagueFormats, matchDayKinds, matchResultKinds, matchStatuses, seasonStatuses } from './enums'

// Competition: places, courts, leagues, seasons, teams, the draw and results. See PLAN.md "Competition".
// Dates are YYYY-MM-DD and times HH:MM, both Sydney local; instants are UTC ISO text.

/** A skipped game night, as in the demo's Settings.skipDates. */
export type SkipDate = { date: string; reason: string }

/**
 * Draw settings for a season: the demo's `Settings` minus teams (season_teams), name/startDate (columns) and points
 * (points_win/draw/loss columns). Keys are camelCase to match the ported src/lib code.
 */
export type SeasonSettings = {
  /** Session start times, "HH:MM" Sydney local. */
  sessions: string[]
  sessionMinutes: number
  /** Times each pair of teams meets. */
  meetings: number
  includeFinals: boolean
  /** mulberry32 seed; a seed reproduces a draw. */
  seed: number
  skipDates: SkipDate[]
  /** Default court for each slot position (index = position), as courts.id. */
  defaultCourtIds: string[]
}

/** Court overrides for one match day, keyed by slotKey() `"<session>:<position>"`, value courts.id. */
export type CourtOverrides = Record<string, string>

/** Points per set, home first: [[25, 21], [19, 25]]. Up to five sets. */
export type SetScores = [number, number][]

/** The places: Robyn Webster Sports Centre (Tempe), MLC School (Burwood), Five Dock Leisure Centre. */
export const venues = sqliteTable(
  'venues',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    address: text('address'),
    mapUrl: text('map_url'),
    directions: text('directions'),
    sort: integer('sort').notNull().default(0),
    wpId: wpId(),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [uniqueIndex('venues_slug_unique').on(t.slug), uniqueIndex('venues_wp_id_unique').on(t.wpId)],
)

/** Courts within a place: Court 1, Court 2, Court 3, MLC. (SportsPress "venues" were really these.) */
export const courts = sqliteTable(
  'courts',
  {
    id: id(),
    venueId: text('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    sort: integer('sort').notNull().default(0),
    /** The SportsPress venue term id this court came from. */
    wpId: wpId(),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    index('courts_venue_id_idx').on(t.venueId),
    uniqueIndex('courts_venue_id_name_unique').on(t.venueId, t.name),
    uniqueIndex('courts_wp_id_unique').on(t.wpId),
  ],
)

export const leagues = sqliteTable(
  'leagues',
  {
    id: id(),
    code: text('code', { enum: leagueCodes }).notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Game night, 0 = Sunday … 6 = Saturday (as Date#getDay in Sydney time). */
    weekday: integer('weekday').notNull(),
    defaultVenueId: text('default_venue_id').references(() => venues.id, { onDelete: 'set null' }),
    format: text('format', { enum: leagueFormats }).notNull().default('social'),
    sort: integer('sort').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    /** The SportsPress league term id. */
    wpId: wpId(),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    uniqueIndex('leagues_code_unique').on(t.code),
    uniqueIndex('leagues_slug_unique').on(t.slug),
    index('leagues_default_venue_id_idx').on(t.defaultVenueId),
    uniqueIndex('leagues_wp_id_unique').on(t.wpId),
  ],
)

/** One row per league per quarter, e.g. "TNL Q4 2026". */
export const seasons = sqliteTable(
  'seasons',
  {
    id: id(),
    leagueId: text('league_id')
      .notNull()
      .references(() => leagues.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** Unique across all seasons, e.g. "tnl-q4-2026". */
    slug: text('slug').notNull(),
    year: integer('year').notNull(),
    /** 1–4. */
    quarter: integer('quarter').notNull(),
    /** YYYY-MM-DD, the first game night. */
    startDate: text('start_date').notNull(),
    status: text('status', { enum: seasonStatuses }).notNull().default('draft'),
    settings: text('settings', { mode: 'json' }).$type<SeasonSettings>().notNull(),
    pointsWin: integer('points_win').notNull().default(3),
    pointsDraw: integer('points_draw').notNull().default(2),
    pointsLoss: integer('points_loss').notNull().default(1),
    /** 2 for social leagues, 5 for TVSL (best of 5). */
    setsPerMatch: integer('sets_per_match').notNull().default(2),
    dutyEnabled: integer('duty_enabled', { mode: 'boolean' }).notNull().default(true),
    /** shapeKey() of the settings the draw was generated from. */
    generatedFrom: text('generated_from'),
    /** True once the organiser has hand-edited the generated draw. */
    edited: integer('edited', { mode: 'boolean' }).notNull().default(false),
    publishedAt: text('published_at'),
    wpId: wpId(),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    uniqueIndex('seasons_slug_unique').on(t.slug),
    uniqueIndex('seasons_league_id_year_quarter_unique').on(t.leagueId, t.year, t.quarter),
    index('seasons_status_idx').on(t.status),
    uniqueIndex('seasons_wp_id_unique').on(t.wpId),
  ],
)

/** Teams persist across seasons. */
export const teams = sqliteTable(
  'teams',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    wpId: wpId(),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [uniqueIndex('teams_slug_unique').on(t.slug), uniqueIndex('teams_wp_id_unique').on(t.wpId)],
)

/** Who's in a season. */
export const seasonTeams = sqliteTable(
  'season_teams',
  {
    seasonId: text('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    sort: integer('sort').notNull().default(0),
    ...timestamps(),
  },
  (t) => [primaryKey({ columns: [t.seasonId, t.teamId] }), index('season_teams_team_id_idx').on(t.teamId)],
)

/** A game night (the demo's `Week`). */
export const matchDays = sqliteTable(
  'match_days',
  {
    id: id(),
    seasonId: text('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    /** YYYY-MM-DD Sydney local. */
    date: text('date').notNull(),
    kind: text('kind', { enum: matchDayKinds }).notNull().default('regular'),
    /** Match day number, 1-based; 0 for skipped weeks. */
    number: integer('number').notNull(),
    /** Reason shown for skipped weeks. */
    note: text('note'),
    courtOverrides: text('court_overrides', { mode: 'json' }).$type<CourtOverrides>().notNull().default({}),
    /** When this day's results were last published (UTC ISO). Drives "Updated 16/10/2026". */
    resultsPublishedAt: text('results_published_at'),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [uniqueIndex('match_days_season_id_date_unique').on(t.seasonId, t.date)],
)

/**
 * One game in a slot. Each side (and the duty team) is either a team id or a placeholder label ("2nd", "Loser SF1")
 * that makeResolver turns into a team; set exactly one of *_team_id / *_label. Byes are derived, not stored.
 */
export const matches = sqliteTable(
  'matches',
  {
    id: id(),
    seasonId: text('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    matchDayId: text('match_day_id')
      .notNull()
      .references(() => matchDays.id, { onDelete: 'cascade' }),
    /** Session index within the night, 0-based (the demo's Game.session). */
    session: integer('session').notNull(),
    /** Slot position within the session, 0-based (the demo's Game.court). Not a court name. */
    position: integer('position').notNull(),
    /** HH:MM Sydney local. */
    startTime: text('start_time'),
    /** The resolved court (slot override, else the season default for the position), denormalised for reads. */
    courtId: text('court_id').references(() => courts.id, { onDelete: 'set null' }),
    homeTeamId: text('home_team_id').references(() => teams.id, { onDelete: 'restrict' }),
    homeLabel: text('home_label'),
    awayTeamId: text('away_team_id').references(() => teams.id, { onDelete: 'restrict' }),
    awayLabel: text('away_label'),
    dutyTeamId: text('duty_team_id').references(() => teams.id, { onDelete: 'restrict' }),
    dutyLabel: text('duty_label'),
    /** "Semi Final 1", "Grand Final", "3rd Place Playoff". */
    stageTitle: text('stage_title'),
    status: text('status', { enum: matchStatuses }).notNull().default('scheduled'),
    /** The old SportsPress event slug, kept for redirects. */
    slug: text('slug'),
    wpId: wpId(),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    index('matches_season_id_idx').on(t.seasonId),
    index('matches_match_day_id_session_position_idx').on(t.matchDayId, t.session, t.position),
    index('matches_court_id_idx').on(t.courtId),
    index('matches_home_team_id_idx').on(t.homeTeamId),
    index('matches_away_team_id_idx').on(t.awayTeamId),
    index('matches_duty_team_id_idx').on(t.dutyTeamId),
    uniqueIndex('matches_slug_unique').on(t.slug),
    uniqueIndex('matches_wp_id_unique').on(t.wpId),
  ],
)

/** Two rows per match at most: `draft` (being typed in) and `published` (what counts). */
export const matchResults = sqliteTable(
  'match_results',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: matchResultKinds }).notNull(),
    homeSets: integer('home_sets'),
    awaySets: integer('away_sets'),
    setScores: text('set_scores', { mode: 'json' }).$type<SetScores>(),
    /** Total rally points. Derived from set_scores when those are present. */
    homePoints: integer('home_points'),
    awayPoints: integer('away_points'),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.kind] })],
)

/** Ladder point adjustments: penalties, and reconciling hand-adjusted SportsPress tables. */
export const ladderAdjustments = sqliteTable(
  'ladder_adjustments',
  {
    id: id(),
    seasonId: text('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    /** Added to the team's ladder points; negative for a penalty. */
    points: integer('points').notNull(),
    reason: text('reason').notNull(),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [index('ladder_adjustments_season_id_idx').on(t.seasonId), index('ladder_adjustments_team_id_idx').on(t.teamId)],
)

export type Venue = typeof venues.$inferSelect
export type NewVenue = typeof venues.$inferInsert
export type Court = typeof courts.$inferSelect
export type NewCourt = typeof courts.$inferInsert
export type League = typeof leagues.$inferSelect
export type NewLeague = typeof leagues.$inferInsert
export type Season = typeof seasons.$inferSelect
export type NewSeason = typeof seasons.$inferInsert
export type Team = typeof teams.$inferSelect
export type NewTeam = typeof teams.$inferInsert
export type SeasonTeam = typeof seasonTeams.$inferSelect
export type NewSeasonTeam = typeof seasonTeams.$inferInsert
export type MatchDay = typeof matchDays.$inferSelect
export type NewMatchDay = typeof matchDays.$inferInsert
export type Match = typeof matches.$inferSelect
export type NewMatch = typeof matches.$inferInsert
export type MatchResult = typeof matchResults.$inferSelect
export type NewMatchResult = typeof matchResults.$inferInsert
export type LadderAdjustment = typeof ladderAdjustments.$inferSelect
export type NewLadderAdjustment = typeof ladderAdjustments.$inferInsert
