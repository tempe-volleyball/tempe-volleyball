import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { id, timestamps, updatedBy } from './columns'
import { leagues, seasons, teams } from './competition'
import { interestKinds, interestSources, interestStatuses, rosterRoles, type Gender } from './enums'
import { enrolmentForms } from './forms'
import { players, type RegistrationAnswers } from './registrations'

// Expressions of interest (EOIs) and season rosters (docs/interest.md). Personal data: admins and owners only,
// never cached, never public.

/** One EOI form sent: from a player (to be placed in a team) or a team. */
export const interests = sqliteTable(
  'interests',
  {
    id: id(),
    kind: text('kind', { enum: interestKinds }).notNull(),
    /** "EOI-7K3Q": in the acknowledgement email and the admin. */
    reference: text('reference').notNull(),
    /** Team EOIs: the team name as typed. */
    teamName: text('team_name'),
    /** The form's answers (playing level, position …), keyed by field key. */
    answers: text('answers', { mode: 'json' }).$type<RegistrationAnswers>().notNull().default({}),
    formId: text('form_id').references(() => enrolmentForms.id, { onDelete: 'set null' }),
    formVersion: integer('form_version'),
    /** The deposit asked (AUD cents) when it was sent: the highest deposit of the programmes picked. Null = none. */
    depositCents: integer('deposit_cents'),
    paidAt: text('paid_at'),
    paidMarkedBy: text('paid_marked_by').references(() => user.id, { onDelete: 'set null' }),
    /** "PayID 12/10", "cash". */
    paymentNote: text('payment_note'),
    /** The admin's own note. */
    note: text('note'),
    source: text('source', { enum: interestSources }).notNull().default('public'),
    /** UTC ISO; archived EOIs leave the inbox and are deleted after Settings → Interest's retention. */
    archivedAt: text('archived_at'),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    uniqueIndex('interests_reference_unique').on(t.reference),
    index('interests_created_at_idx').on(t.createdAt),
    index('interests_archived_at_idx').on(t.archivedAt),
    index('interests_form_id_idx').on(t.formId),
    index('interests_paid_marked_by_idx').on(t.paidMarkedBy),
  ],
)

/** The details a person was sent with, as typed (public forms never overwrite the player row). */
export type MemberDetails = {
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  gender: Gender | null
  birthYear: number | null
  suburb: string | null
  vnswNumber: string | null
  guardianName: string | null
  guardianEmail: string | null
  guardianPhone: string | null
  emergencyContact: string | null
}

/** The people on an EOI: the contact first (sort 0; captain of a team EOI), then team members. */
export const interestMembers = sqliteTable(
  'interest_members',
  {
    id: id(),
    interestId: text('interest_id')
      .notNull()
      .references(() => interests.id, { onDelete: 'cascade' }),
    /** The matched or created player. Null only if that player was deleted. */
    playerId: text('player_id').references(() => players.id, { onDelete: 'set null' }),
    role: text('role', { enum: rosterRoles }).notNull().default('player'),
    sort: integer('sort').notNull().default(0),
    details: text('details', { mode: 'json' }).$type<MemberDetails>().notNull(),
    ...timestamps(),
  },
  (t) => [index('interest_members_interest_id_sort_idx').on(t.interestId, t.sort), index('interest_members_player_id_idx').on(t.playerId)],
)

/** Each programme an EOI picked, with its own status (placed in TNL, declined for FNL). */
export const interestProgrammes = sqliteTable(
  'interest_programmes',
  {
    interestId: text('interest_id')
      .notNull()
      .references(() => interests.id, { onDelete: 'cascade' }),
    programmeId: text('programme_id')
      .notNull()
      .references(() => leagues.id, { onDelete: 'cascade' }),
    status: text('status', { enum: interestStatuses }).notNull().default('new'),
    /** Where they were placed (status placed). */
    seasonId: text('season_id').references(() => seasons.id, { onDelete: 'set null' }),
    teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
    /** Copied from interests.created_at, so "since the last season started" is one indexed range per programme. */
    createdAt: text('created_at').notNull(),
    updatedAt: timestamps().updatedAt,
    updatedBy: updatedBy(),
  },
  (t) => [
    primaryKey({ columns: [t.interestId, t.programmeId] }),
    index('interest_programmes_programme_id_status_idx').on(t.programmeId, t.status, t.createdAt),
    index('interest_programmes_programme_id_created_at_idx').on(t.programmeId, t.createdAt),
    index('interest_programmes_season_id_idx').on(t.seasonId),
    index('interest_programmes_team_id_idx').on(t.teamId),
  ],
)

/** Who played in each team each season. Admin-only; editable after publishing (it doesn't touch the draw). */
export const seasonTeamPlayers = sqliteTable(
  'season_team_players',
  {
    seasonId: text('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    role: text('role', { enum: rosterRoles }).notNull().default('player'),
    sort: integer('sort').notNull().default(0),
    /** Where they came from: an EOI, or the previous season they were copied from. */
    interestId: text('interest_id').references(() => interests.id, { onDelete: 'set null' }),
    fromSeasonId: text('from_season_id').references(() => seasons.id, { onDelete: 'set null' }),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.teamId, t.playerId] }),
    index('season_team_players_player_id_idx').on(t.playerId, t.seasonId),
    index('season_team_players_team_id_idx').on(t.teamId),
    index('season_team_players_interest_id_idx').on(t.interestId),
    index('season_team_players_from_season_id_idx').on(t.fromSeasonId),
  ],
)

export type Interest = typeof interests.$inferSelect
export type NewInterest = typeof interests.$inferInsert
export type InterestMember = typeof interestMembers.$inferSelect
export type NewInterestMember = typeof interestMembers.$inferInsert
export type InterestProgramme = typeof interestProgrammes.$inferSelect
export type NewInterestProgramme = typeof interestProgrammes.$inferInsert
export type SeasonTeamPlayer = typeof seasonTeamPlayers.$inferSelect
export type NewSeasonTeamPlayer = typeof seasonTeamPlayers.$inferInsert
