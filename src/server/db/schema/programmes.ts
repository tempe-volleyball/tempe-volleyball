import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { id, timestamps, updatedBy } from './columns'
import { courts, leagues, venues } from './competition'
import { occurrenceStatuses } from './enums'

// What non-league programmes run (docs/admin.md §3.1): training sessions, development terms (with their sessions) and
// event occurrences. Leagues run seasons instead (competition.ts). See docs/data-model-phase6.md.
//
// Schedule only. Enrolment for any of these (price, caps, open/close, form) is its product row (registrations.ts:
// products.session_id / term_id / event_id, one product per target). Dates YYYY-MM-DD and times HH:MM, Sydney local.
// Null venue/times fall back to the term, then the programme.

/** A development term (ADP, JDP): a run of weekly sessions people enrol in as a whole. */
export const developmentTerms = sqliteTable(
  'development_terms',
  {
    id: id(),
    programmeId: text('programme_id')
      .notNull()
      .references(() => leagues.id, { onDelete: 'restrict' }),
    /** "Term 4 2026". */
    name: text('name').notNull(),
    /** Unique within the programme: /programs/<programme>/<term slug>. */
    slug: text('slug').notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date'),
    /** The usual day of its sessions, 0 = Sunday … 6 = Saturday. Null = the programme's. */
    weekday: integer('weekday'),
    startTime: text('start_time'),
    endTime: text('end_time'),
    venueId: text('venue_id').references(() => venues.id, { onDelete: 'set null' }),
    courtId: text('court_id').references(() => courts.id, { onDelete: 'set null' }),
    /** e.g. "Under 12s", "Ages 8–11". Free text. */
    ageGroup: text('age_group'),
    status: text('status', { enum: occurrenceStatuses }).notNull().default('scheduled'),
    /** Public reason for postponed / cancelled, or a general note. */
    note: text('note'),
    sort: integer('sort').notNull().default(0),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    uniqueIndex('development_terms_programme_id_slug_unique').on(t.programmeId, t.slug),
    index('development_terms_programme_id_start_date_idx').on(t.programmeId, t.startDate),
    index('development_terms_venue_id_idx').on(t.venueId),
    index('development_terms_court_id_idx').on(t.courtId),
  ],
)

/**
 * One session on one date: a training session (enrolled per session) or one week of a development term (term_id set;
 * people enrol in the term, not the session).
 */
export const programmeSessions = sqliteTable(
  'programme_sessions',
  {
    id: id(),
    programmeId: text('programme_id')
      .notNull()
      .references(() => leagues.id, { onDelete: 'restrict' }),
    /** Set for development-term sessions; deleting the term deletes them. */
    termId: text('term_id').references(() => developmentTerms.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    startTime: text('start_time'),
    endTime: text('end_time'),
    venueId: text('venue_id').references(() => venues.id, { onDelete: 'set null' }),
    courtId: text('court_id').references(() => courts.id, { onDelete: 'set null' }),
    /** Optional title ("Coached: serving and passing"). */
    title: text('title'),
    status: text('status', { enum: occurrenceStatuses }).notNull().default('scheduled'),
    /** YYYY-MM-DD it was first scheduled for, once moved. */
    originalDate: text('original_date'),
    note: text('note'),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    index('programme_sessions_programme_id_date_idx').on(t.programmeId, t.date),
    index('programme_sessions_term_id_date_idx').on(t.termId, t.date),
    index('programme_sessions_date_idx').on(t.date),
    index('programme_sessions_venue_id_idx').on(t.venueId),
    index('programme_sessions_court_id_idx').on(t.courtId),
  ],
)

/** One occurrence of an event programme (Tempe Cup 2026, rep trials): one date or a short range. */
export const events = sqliteTable(
  'events',
  {
    id: id(),
    programmeId: text('programme_id')
      .notNull()
      .references(() => leagues.id, { onDelete: 'restrict' }),
    /** "Tempe Cup 2026". */
    name: text('name').notNull(),
    /** Unique within the programme: /events/<programme>/<event slug>. */
    slug: text('slug').notNull(),
    startDate: text('start_date').notNull(),
    /** Null = a one-day event. */
    endDate: text('end_date'),
    startTime: text('start_time'),
    endTime: text('end_time'),
    venueId: text('venue_id').references(() => venues.id, { onDelete: 'set null' }),
    status: text('status', { enum: occurrenceStatuses }).notNull().default('scheduled'),
    /** YYYY-MM-DD it was first scheduled to start, once moved. */
    originalStartDate: text('original_start_date'),
    note: text('note'),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    uniqueIndex('events_programme_id_slug_unique').on(t.programmeId, t.slug),
    index('events_programme_id_start_date_idx').on(t.programmeId, t.startDate),
    index('events_start_date_idx').on(t.startDate),
    index('events_venue_id_idx').on(t.venueId),
  ],
)

export type DevelopmentTerm = typeof developmentTerms.$inferSelect
export type NewDevelopmentTerm = typeof developmentTerms.$inferInsert
export type ProgrammeSession = typeof programmeSessions.$inferSelect
export type NewProgrammeSession = typeof programmeSessions.$inferInsert
export type ProgrammeEvent = typeof events.$inferSelect
export type NewProgrammeEvent = typeof events.$inferInsert
