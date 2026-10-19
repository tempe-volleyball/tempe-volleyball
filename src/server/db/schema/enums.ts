// Allowed values for enum-like text columns. Drizzle's text({ enum }) types the columns with these; there are no
// CHECK constraints in SQL, so adding a value is a code change, not a migration. Validate input against these
// arrays at the edges (API handlers, the importer).

// ── Competition ───────────────────────────────────────────────────────────────

/** The five imported leagues. Programme codes are free text now (`leagues.code`); these are the known league ones. */
export const leagueCodes = ['TNL', 'FNL', 'SNL', 'SAL', 'TVSL'] as const
export type LeagueCode = (typeof leagueCodes)[number]

// ── Programmes (docs/admin.md §3, docs/data-model-phase6.md) ────────────────────

/** What a programme is. Fixed in code: each kind has its own admin section. `leagues.kind`. */
export const programmeKinds = ['league', 'training', 'development', 'event'] as const
export type ProgrammeKind = (typeof programmeKinds)[number]

/** Lifecycle of a programme or category: draft = hidden while set up, active = listed, retired = unlisted, page kept. */
export const programmeStatuses = ['draft', 'active', 'retired'] as const
export type ProgrammeStatus = (typeof programmeStatuses)[number]

export const categoryStatuses = programmeStatuses
export type CategoryStatus = ProgrammeStatus

/** A training session, development term or event occurrence. Postponed rows keep their original date. */
export const occurrenceStatuses = ['scheduled', 'postponed', 'cancelled'] as const
export type OccurrenceStatus = (typeof occurrenceStatuses)[number]

/** Codes are short, upper-case and URL-safe: TNL, TVSL, ADP, JDP, SCT. */
export const PROGRAMME_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,15}$/

/** `social`: 2 sets, draws, team duty. `super` (TVSL): best of 5, 90-minute slots, VNSW referees, no duty. */
export const leagueFormats = ['social', 'super'] as const
export type LeagueFormat = (typeof leagueFormats)[number]

export const seasonStatuses = ['draft', 'published', 'archived'] as const
export type SeasonStatus = (typeof seasonStatuses)[number]

export const matchDayKinds = ['regular', 'semi', 'final', 'skip'] as const
export type MatchDayKind = (typeof matchDayKinds)[number]

/** `postponed`: not played on its night, to be rescheduled (matches.original_match_day_id once moved). `tbd`: date/time to be decided. */
export const matchStatuses = ['scheduled', 'played', 'forfeit', 'cancelled', 'postponed', 'tbd'] as const
export type MatchStatus = (typeof matchStatuses)[number]

/** A whole game night. `postponed`/`cancelled` cover every match that night; match_days.original_date keeps where it was. */
export const matchDayStatuses = ['scheduled', 'postponed', 'cancelled'] as const
export type MatchDayStatus = (typeof matchDayStatuses)[number]

/** A manual result override (match_results.outcome), e.g. a forfeit or walkover decided by the organiser. */
export const matchOutcomes = ['home', 'away', 'draw'] as const
export type MatchOutcome = (typeof matchOutcomes)[number]

/** Ladder ordering after ladder points (seasons.settings.tieBreaks). `name` is always applied last for stability. */
export const tieBreakRules = [
  'setDiff',
  'setRatio',
  'setsFor',
  'pointDiff',
  'pointRatio',
  'pointsFor',
  'wins',
  'headToHead',
  'name',
] as const
export type TieBreakRule = (typeof tieBreakRules)[number]
/** What the ladder uses today (src/lib/fixtures/results.ts standings()). */
export const DEFAULT_TIE_BREAKS: readonly TieBreakRule[] = ['setDiff', 'pointDiff', 'wins', 'name']

/** `draft` is what's being typed in; `published` is what counts (ladder, website, exports). */
export const matchResultKinds = ['draft', 'published'] as const
export type MatchResultKind = (typeof matchResultKinds)[number]

// ── Content ───────────────────────────────────────────────────────────────────

export const contentStatuses = ['draft', 'published', 'archived'] as const
export type ContentStatus = (typeof contentStatuses)[number]

export const pageTemplates = ['content', 'home', 'contact'] as const
export type PageTemplate = (typeof pageTemplates)[number]

/**
 * `category` (category_id) expands into a dropdown on its own: the landing page, then each active, menu-visible
 * programme. `programme` (league_id) links one programme's page. league_ladder/league_fixtures are the legacy kinds.
 */
export const menuItemKinds = ['page', 'url', 'league_ladder', 'league_fixtures', 'category', 'programme'] as const
export type MenuItemKind = (typeof menuItemKinds)[number]

/** Where a hand-made child of a `category` item sits relative to the automatic programme links. */
export const menuPlacements = ['before', 'after'] as const
export type MenuPlacement = (typeof menuPlacements)[number]

/** Data blocks a page uses (page_data_refs.kind), so a data change purges exactly those pages. */
export const pageDataRefKinds = ['programme_list', 'ladder', 'fixtures'] as const
export type PageDataRefKind = (typeof pageDataRefKinds)[number]

export const redirectSources = ['wp-import', 'manual'] as const
export type RedirectSource = (typeof redirectSources)[number]

// ── Auth and admin ────────────────────────────────────────────────────────────

/** Formats a media item's resized copies can be in (media.variant_ext). */
export const variantExts = ['webp', 'jpg'] as const
export type VariantExt = (typeof variantExts)[number]

/** Admin roles, highest first: owner > admin > editor. */
export const userRoles = ['owner', 'admin', 'editor'] as const
export type UserRole = (typeof userRoles)[number]

/** Known audit actions. The column is plain text, so new actions only need adding here. */
export const auditActions = [
  'role.grant',
  'role.revoke',
  'invite.create',
  'invite.revoke',
  'invite.accept',
  'user.remove',
  'payment.mark_paid',
  'payment.refund',
  'results.publish',
  'match.status',
  'match.update',
  'match.move',
  'match.move_undo',
  'team.merge_undo',
  /** A one-off data script tidied imported rows (scripts/fix-imported-seasons.ts). */
  'import.fix',
  'season.create',
  'season.update',
  'season.draw_save',
  'season.teams',
  'season.publish',
  'season.unpublish',
  'season.archive',
  'season.unarchive',
  'season.delete',
  'ladder.adjust',
  'team.create',
  'team.rename',
  'page.publish',
  'page.unpublish',
  'page.delete',
  'post.publish',
  'post.unpublish',
  'post.delete',
  'media.delete',
  'menu.update',
  'settings.update',
  // Phase 6
  'programme.create',
  'programme.update',
  'programme.status',
  'programme.enrolment',
  'programme.delete',
  'category.create',
  'category.update',
  'category.status',
  'category.delete',
  'venue.create',
  'venue.update',
  'venue.delete',
  'court.create',
  'court.update',
  'court.delete',
  'session.create',
  'session.update',
  'session.status',
  'session.delete',
  'term.create',
  'term.update',
  'term.status',
  'term.delete',
  'event.create',
  'event.update',
  'event.status',
  'event.delete',
  'form.create',
  'form.update',
  'form.delete',
  'product.update',
  'enrolment.create',
  'enrolment.update',
  'enrolment.status',
  'enrolment.mark_paid',
  'enrolment.mark_unpaid',
  'enrolment.offer',
  'enrolment.place',
  'enrolment.delete',
  'enrolment.export',
  // Phase 7: the contact form's inbox (docs/admin.md §3.15)
  'message.delete',
  'message.export',
  'match_day.postpone',
  'match_day.cancel',
  'match_day.restore',
  'season.push_back',
  'team.withdraw',
  'team.reinstate',
  'team.merge',
  'fixtures.import',
  'page.blocks',
  'analytics.fetch',
  'auth.device_trust',
  'auth.devices_revoke',
  // Expressions of interest, players and rosters (docs/interest.md)
  'interest.create',
  'interest.update',
  'interest.delete',
  'interest.export',
  'player.create',
  'player.update',
  'player.merge',
  'player.delete',
  'player.export',
  'roster.update',
  'roster.export',
] as const
export type AuditAction = (typeof auditActions)[number]

// ── Registrations and payments ────────────────────────────────────────────────

/**
 * What a product sells. Phase 6 enrolment uses one product per target (products.season_id / session_id / term_id /
 * event_id): season_entry, training_session, development_term, event_entry. adp_term / jdp_term are Phase 5 names.
 */
export const productKinds = ['season_entry', 'training_session', 'adp_term', 'jdp_term', 'development_term', 'event_entry'] as const
export type ProductKind = (typeof productKinds)[number]

export const paymentProviders = ['stripe', 'payid'] as const
export type PaymentProviderId = (typeof paymentProviders)[number]

export const groupKinds = ['team', 'group'] as const
export type GroupKind = (typeof groupKinds)[number]

/**
 * Phase 5 (Stripe) used pending_payment → paid. Phase 6 manual enrolment uses `confirmed` (has a spot; paid or not is
 * registrations.paid_at), `waitlist`, and `offered` (a freed spot offered until offer_expires_at). `pending_email`: a public
 * entry waiting for its emailed confirm link to be clicked (until hold_expires_at); it holds no spot and isn't on the
 * waitlist yet (docs/admin.md §3.7).
 */
export const registrationStatuses = [
  'pending_payment',
  'paid',
  'cancelled',
  'expired',
  'refunded',
  'waitlist',
  'confirmed',
  'offered',
  'pending_email',
] as const
export type RegistrationStatus = (typeof registrationStatuses)[number]

/** Statuses that hold a spot and count against a cap. `waitlist` doesn't hold one. */
export const spotHoldingStatuses = ['pending_payment', 'paid', 'confirmed', 'offered'] as const satisfies readonly RegistrationStatus[]
/** Statuses that are finished; anything else is "live" (one live registration per player per product). */
export const closedRegistrationStatuses = ['cancelled', 'expired', 'refunded'] as const satisfies readonly RegistrationStatus[]

/** A team entry (groups.status). Same meanings as for registrations. */
export const groupStatuses = ['confirmed', 'waitlist', 'offered', 'cancelled', 'pending_email'] as const
export type GroupStatus = (typeof groupStatuses)[number]

/** Where a registration came from. */
export const registrationSources = ['public', 'admin', 'import'] as const
export type RegistrationSource = (typeof registrationSources)[number]

export const paymentStatuses = ['pending', 'paid', 'failed', 'cancelled', 'refunded'] as const
export type PaymentStatus = (typeof paymentStatuses)[number]

export const emailStatuses = ['queued', 'sent', 'failed'] as const
export type EmailStatus = (typeof emailStatuses)[number]

// ── Analytics ─────────────────────────────────────────────────────────────────

export const analyticsSources = ['ga4', 'search_console', 'cloudflare'] as const
export type AnalyticsSource = (typeof analyticsSources)[number]

export const analyticsFetchStatuses = ['running', 'ok', 'error', 'skipped'] as const
export type AnalyticsFetchStatus = (typeof analyticsFetchStatuses)[number]

// ── Contact form (Phase 7) ────────────────────────────────────────────────────

/** A contact message: new (unread), read (opened in the admin), handled (done; pruned after the retention period). */
export const contactMessageStatuses = ['new', 'read', 'handled'] as const
export type ContactMessageStatus = (typeof contactMessageStatuses)[number]

// ── Expressions of interest, players and rosters (docs/interest.md) ───────────

/** How a programme takes sign-ups (leagues.signup_mode). Null there = the kind's default (defaultSignupMode). */
export const signupModes = ['interest', 'enrolment'] as const
export type SignupMode = (typeof signupModes)[number]

/** Leagues and events take expressions of interest by default; training and development take enrolments. */
export const defaultSignupMode = (kind: ProgrammeKind): SignupMode => (kind === 'league' || kind === 'event' ? 'interest' : 'enrolment')

/** players.pool: competition players (leagues, events) are kept apart from training players (training, development). */
export const playerPools = ['competition', 'training'] as const
export type PlayerPool = (typeof playerPools)[number]

export const poolOfKind = (kind: ProgrammeKind): PlayerPool => (kind === 'league' || kind === 'event' ? 'competition' : 'training')

/** Where a player row came from (players.source). */
export const playerSources = ['interest', 'enrolment', 'admin', 'import'] as const
export type PlayerSource = (typeof playerSources)[number]

export const genders = ['male', 'female', 'non_binary', 'prefer_not_to_say'] as const
export type Gender = (typeof genders)[number]

/** An EOI is from one player (to be placed in a team) or a whole team. */
export const interestKinds = ['player', 'team'] as const
export type InterestKind = (typeof interestKinds)[number]

/** Per programme on an EOI (interest_programmes.status). Open = new or contacted. */
export const interestStatuses = ['new', 'contacted', 'placed', 'declined', 'withdrawn'] as const
export type InterestStatus = (typeof interestStatuses)[number]
export const openInterestStatuses = ['new', 'contacted'] as const satisfies readonly InterestStatus[]

export const interestSources = ['public', 'admin', 'import'] as const
export type InterestSource = (typeof interestSources)[number]

/** interest_members.role and season_team_players.role. */
export const rosterRoles = ['captain', 'player'] as const
export type RosterRole = (typeof rosterRoles)[number]
