import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { EMPTY_BODY, id, timestamps, updatedBy, wpId, type ContentBody } from './columns'
import {
  categoryStatuses,
  leagueFormats,
  matchDayKinds,
  matchDayStatuses,
  matchOutcomes,
  matchResultKinds,
  matchStatuses,
  programmeKinds,
  programmeStatuses,
  seasonStatuses,
  type TieBreakRule,
} from './enums'
import { enrolmentForms } from './forms'
import { media } from './media'

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
  /**
   * Ladder order after ladder points, first rule first; `name` is appended if missing. Missing = DEFAULT_TIE_BREAKS
   * (set difference, points difference, wins, name), which is what seasons saved before Phase 6 use.
   */
  tieBreaks?: TieBreakRule[]
  /** How withdrawn teams (season_teams.withdrawn_at) show. Missing = { ladder: 'mark', results: 'keep' }. */
  withdrawn?: WithdrawnPolicy
}

/**
 * `ladder`: `mark` keeps the row, flagged "Withdrawn" and sorted last; `hide` drops it. `results`: `keep` counts the
 * games they played; `void` drops every game involving them from the ladder (both sides). `fixtures` (added with the
 * fixtures-parity work, JSON only): how their cancelled games show publicly, `bye` for the opponent or `cancelled`
 * (missing = cancelled).
 */
export type WithdrawnPolicy = { ladder: 'mark' | 'hide'; results: 'keep' | 'void'; fixtures?: 'bye' | 'cancelled' }

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

/**
 * Programme categories (docs/admin.md §3.2): Mixed Leagues, Super League, Juniors, Adult Training. Each has a landing
 * page at `/<slug>` and can be a `category` menu item. The four are seeded by migration 0003 (ids `cat_<slug>`).
 */
export const categories = sqliteTable(
  'categories',
  {
    id: id(),
    name: text('name').notNull(),
    /** The landing page URL without the slash: "mixed-leagues" → /mixed-leagues. Unique. */
    slug: text('slug').notNull(),
    /** Editable intro shown above the programme list on the landing page. */
    intro: text('intro', { mode: 'json' }).$type<ContentBody>().notNull().default(EMPTY_BODY),
    sort: integer('sort').notNull().default(0),
    status: text('status', { enum: categoryStatuses }).notNull().default('active'),
    /** Null = the name, and a description generated from the intro. */
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    ogImageId: text('og_image_id').references(() => media.id, { onDelete: 'set null' }),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    uniqueIndex('categories_slug_unique').on(t.slug),
    index('categories_og_image_id_idx').on(t.ogImageId),
    index('categories_status_sort_idx').on(t.status, t.sort),
  ],
)

/**
 * Programmes: leagues, training, development programmes and events (docs/admin.md §3.1). The SQL table is still
 * `leagues` (a rename can come in a later release); new code should use the `programmes` alias and filter by `kind`.
 * Code that means "competition leagues" (seasons, ladders, league menu items) must filter `kind = 'league'`.
 */
export const leagues = sqliteTable(
  'leagues',
  {
    id: id(),
    /** Short upper-case code, unique across all programmes: TNL, TVSL, ADP, JDP (PROGRAMME_CODE_PATTERN). */
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** URL slug, unique across all programmes. Page: /leagues/<slug>, /training/<slug>, /programs/<slug> or /events/<slug> by kind. */
    slug: text('slug').notNull(),
    /**
     * The usual day, 0 = Sunday … 6 = Saturday (as Date#getDay in Sydney time). NOT NULL since 0001: for leagues it's
     * the game night; for programmes without a regular day (events) store the first date's weekday.
     */
    weekday: integer('weekday').notNull(),
    defaultVenueId: text('default_venue_id').references(() => venues.id, { onDelete: 'set null' }),
    /** Leagues only. */
    format: text('format', { enum: leagueFormats }).notNull().default('social'),
    sort: integer('sort').notNull().default(0),
    /** Superseded by `status`. Writers keep active = (status = 'active') until a later release drops it. */
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    /** The SportsPress league term id. */
    wpId: wpId(),
    ...timestamps(),
    updatedBy: updatedBy(),
    // ── Phase 6: programme basics ──
    kind: text('kind', { enum: programmeKinds }).notNull().default('league'),
    /** Every programme should have one (the admin requires it); nullable only because SQLite can't add a NOT NULL FK. */
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'restrict' }),
    status: text('status', { enum: programmeStatuses }).notNull().default('active'),
    /** UTC ISO, set when retired, cleared on reactivation. */
    retiredAt: text('retired_at'),
    /** HH:MM Sydney local: the usual start and finish. Null = not shown (leagues can fall back to their season's sessions). */
    startTime: text('start_time'),
    endTime: text('end_time'),
    /** Hand-written "day and times" text ("Thursdays, 6:30–10pm"). Null = generated from weekday/start/end. */
    scheduleLabel: text('schedule_label'),
    description: text('description', { mode: 'json' }).$type<ContentBody>().notNull().default(EMPTY_BODY),
    /** The one-line description used wherever the programme is listed. Null = generated (docs/admin.md §3.1). */
    summaryLine: text('summary_line'),
    /** "More info" link: internal path or https URL. */
    moreInfoUrl: text('more_info_url'),
    /** False hides it from automatic menu dropdowns without retiring it. */
    menuVisible: integer('menu_visible', { mode: 'boolean' }).notNull().default(true),
    /** Optional age limits in years (juniors), checked against the form's birth_year. */
    ageMin: integer('age_min'),
    ageMax: integer('age_max'),
    seoTitle: text('seo_title'),
    seoDescription: text('seo_description'),
    imageId: text('image_id').references(() => media.id, { onDelete: 'set null' }),
    // ── Phase 6: enrolment defaults (each instance's product can override) ──
    /** The switch. Open = enrolment_open AND now within [opens_at, closes_at) where those are set. */
    enrolmentOpen: integer('enrolment_open', { mode: 'boolean' }).notNull().default(false),
    /** UTC ISO; null = no limit on that side. */
    enrolmentOpensAt: text('enrolment_opens_at'),
    enrolmentClosesAt: text('enrolment_closes_at'),
    /** Manual "Next season starts …" override. Text wins over date; both null = from the next season/session/term/event. */
    nextStartsOn: text('next_starts_on'),
    nextStartsText: text('next_starts_text'),
    enrolmentFormId: text('enrolment_form_id').references(() => enrolmentForms.id, { onDelete: 'set null' }),
    /** Default caps for each instance; null = unlimited. Leagues may cap teams, players or both. */
    capTeams: integer('cap_teams'),
    capPlayers: integer('cap_players'),
    /** Default price per player (AUD cents), shown on enrolment and owed until marked paid. Null = no fee shown. */
    priceCents: integer('price_cents'),
    /** Leagues and events: whether whole teams can enter, and whether individuals can enter as free agents. */
    allowTeamEntries: integer('allow_team_entries', { mode: 'boolean' }).notNull().default(true),
    allowFreeAgents: integer('allow_free_agents', { mode: 'boolean' }).notNull().default(true),
    /** When full, new enrolments join a waitlist (otherwise they're refused). */
    waitlistEnabled: integer('waitlist_enabled', { mode: 'boolean' }).notNull().default(true),
    /** How long a waitlist offer stays open before it passes to the next person. */
    waitlistOfferHours: integer('waitlist_offer_hours').notNull().default(48),
    /**
     * Public entries wait for the person to click a link emailed to them before they hold a spot (status
     * pending_email). Null = automatic: on when the instance has a player or team cap. products.email_confirm overrides.
     */
    enrolmentEmailConfirm: integer('enrolment_email_confirm', { mode: 'boolean' }),
  },
  (t) => [
    uniqueIndex('leagues_code_unique').on(t.code),
    uniqueIndex('leagues_slug_unique').on(t.slug),
    index('leagues_default_venue_id_idx').on(t.defaultVenueId),
    uniqueIndex('leagues_wp_id_unique').on(t.wpId),
    index('leagues_category_id_idx').on(t.categoryId),
    index('leagues_kind_status_idx').on(t.kind, t.status),
    index('leagues_image_id_idx').on(t.imageId),
    index('leagues_enrolment_form_id_idx').on(t.enrolmentFormId),
  ],
)

/** Programmes are the `leagues` table (see above). Prefer this name in new code. */
export const programmes = leagues

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
    /** UTC ISO when the team withdrew; null = still in. How it shows is seasons.settings.withdrawn. */
    withdrawnAt: text('withdrawn_at'),
    withdrawnReason: text('withdrawn_reason'),
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
    /** The whole night. The public reason goes in `note`. */
    status: text('status', { enum: matchDayStatuses }).notNull().default('scheduled'),
    /** YYYY-MM-DD the night was first scheduled for, once it has been moved ("push the season back a week"). */
    originalDate: text('original_date'),
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
    /** Public reason for postponed / cancelled / tbd ("Venue unavailable"). */
    statusNote: text('status_note'),
    /** When a postponed game is replayed on another night: the match day it was first scheduled on. */
    originalMatchDayId: text('original_match_day_id').references(() => matchDays.id, { onDelete: 'set null' }),
    /** Referee name(s), e.g. the Volleyball NSW referee for TVSL. */
    referee: text('referee'),
  },
  (t) => [
    index('matches_season_id_idx').on(t.seasonId),
    index('matches_original_match_day_id_idx').on(t.originalMatchDayId),
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
    /** Manual outcome override (forfeit, walkover): who won regardless of the scores. Null = from the sets. */
    outcome: text('outcome', { enum: matchOutcomes }),
    /** Why the outcome was overridden, shown with the result. */
    note: text('note'),
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
export type Category = typeof categories.$inferSelect
export type NewCategory = typeof categories.$inferInsert
export type League = typeof leagues.$inferSelect
export type NewLeague = typeof leagues.$inferInsert
export type Programme = League
export type NewProgramme = NewLeague
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
