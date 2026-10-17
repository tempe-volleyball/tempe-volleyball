import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { id, SQL_NOW_ISO, timestamps, updatedBy, wpId } from './columns'
import { leagues, seasons, teams } from './competition'
import {
  emailStatuses,
  groupKinds,
  groupStatuses,
  paymentProviders,
  paymentStatuses,
  productKinds,
  registrationSources,
  registrationStatuses,
} from './enums'
import type { PaymentProviderId } from './enums'
import { enrolmentForms } from './forms'
import { developmentTerms, events, programmeSessions } from './programmes'

// Registrations, payments and the email outbox. See PLAN.md "Registrations and payments" and, for Phase 6 enrolment,
// docs/data-model-phase6.md. Money is integer cents (AUD). One payment covers one player and one product; there are
// no team fees.

/** Live = not cancelled, expired or refunded (closedRegistrationStatuses). Used by the partial unique indexes. */
const LIVE_REGISTRATION = sql`status NOT IN ('cancelled', 'expired', 'refunded')`

/**
 * Something a player can enrol in. Phase 6: exactly one product per enrolment target, so it's where that instance's
 * enrolment settings live: one of season_id / session_id / term_id / event_id is set (unique), plus programme_id.
 * Null caps, prices, forms and windows fall back to the programme (leagues.cap_* etc.).
 */
export const products = sqliteTable(
  'products',
  {
    id: id(),
    kind: text('kind', { enum: productKinds }).notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    priceCents: integer('price_cents').notNull(),
    /** Player cap: max registrations holding a spot (spotHoldingStatuses). Null = the programme's cap_players (null there = unlimited). */
    capacity: integer('capacity'),
    /** YYYY-MM-DD Sydney local: when the thing itself runs. */
    startsOn: text('starts_on'),
    endsOn: text('ends_on'),
    /** UTC ISO: when registration opens and closes. */
    opensAt: text('opens_at'),
    closesAt: text('closes_at'),
    seasonId: text('season_id').references(() => seasons.id, { onDelete: 'set null' }),
    paymentMethods: text('payment_methods', { mode: 'json' }).$type<PaymentProviderId[]>().notNull().default(['stripe', 'payid']),
    /** False stops new enrolments for this instance even while the programme is open. */
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    wpId: wpId(),
    ...timestamps(),
    updatedBy: updatedBy(),
    // ── Phase 6: enrolment targets and per-instance overrides ──
    programmeId: text('programme_id').references(() => leagues.id, { onDelete: 'restrict' }),
    /** Deleting the session/term/event deletes its product, unless registrations reference it (then the delete fails). */
    sessionId: text('session_id').references(() => programmeSessions.id, { onDelete: 'cascade' }),
    termId: text('term_id').references(() => developmentTerms.id, { onDelete: 'cascade' }),
    eventId: text('event_id').references(() => events.id, { onDelete: 'cascade' }),
    /** Team cap: max team entries (groups) holding a spot. Null = the programme's cap_teams (null there = unlimited). */
    capacityTeams: integer('capacity_teams'),
    /** Overrides the programme's enrolment form. */
    formId: text('form_id').references(() => enrolmentForms.id, { onDelete: 'set null' }),
    /** Null = the programme's waitlist_enabled / waitlist_offer_hours / allow_* settings. */
    waitlistEnabled: integer('waitlist_enabled', { mode: 'boolean' }),
    waitlistOfferHours: integer('waitlist_offer_hours'),
    allowTeamEntries: integer('allow_team_entries', { mode: 'boolean' }),
    allowFreeAgents: integer('allow_free_agents', { mode: 'boolean' }),
  },
  (t) => [
    uniqueIndex('products_slug_unique').on(t.slug),
    index('products_season_id_idx').on(t.seasonId),
    index('products_kind_active_idx').on(t.kind, t.active),
    index('products_programme_id_idx').on(t.programmeId),
    // One product per target. (SQLite unique indexes allow many NULLs.)
    uniqueIndex('products_season_id_unique').on(t.seasonId),
    uniqueIndex('products_session_id_unique').on(t.sessionId),
    uniqueIndex('products_term_id_unique').on(t.termId),
    uniqueIndex('products_event_id_unique').on(t.eventId),
    index('products_form_id_idx').on(t.formId),
  ],
)

/** A person who registers. Matched by (lower-cased) email so returning players aren't duplicated. */
export const players = sqliteTable(
  'players',
  {
    id: id(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    /** Lower-cased. Not unique: juniors may share a guardian's address. */
    email: text('email').notNull(),
    phone: text('phone'),
    birthYear: integer('birth_year'),
    /** For juniors (JDP). */
    guardianName: text('guardian_name'),
    guardianEmail: text('guardian_email'),
    guardianPhone: text('guardian_phone'),
    emergencyContact: text('emergency_contact'),
    notes: text('notes'),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [index('players_email_idx').on(t.email)],
)

/**
 * A team or group signing up together. Each member still registers and pays individually (registrations.group_id).
 * Phase 6: a league/event team entry is a `team` group with a status; the team cap counts groups holding a spot.
 */
export const groups = sqliteTable(
  'groups',
  {
    id: id(),
    kind: text('kind', { enum: groupKinds }).notNull(),
    name: text('name').notNull(),
    captainPlayerId: text('captain_player_id').references((): AnySQLiteColumn => players.id, { onDelete: 'set null' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    ...timestamps(),
    updatedBy: updatedBy(),
    // ── Phase 6 ──
    status: text('status', { enum: groupStatuses }).notNull().default('confirmed'),
    /** 1-based place in the waitlist while status = 'waitlist' (gaps allowed; order by it). */
    waitlistPosition: integer('waitlist_position'),
    offeredAt: text('offered_at'),
    offerExpiresAt: text('offer_expires_at'),
    /** The competition team this entry is (or became), for season_teams. */
    teamId: text('team_id').references(() => teams.id, { onDelete: 'set null' }),
    /** Team-level form answers (preferred division …). */
    answers: text('answers', { mode: 'json' }).$type<RegistrationAnswers>().notNull().default({}),
    cancelledAt: text('cancelled_at'),
    notes: text('notes'),
  },
  (t) => [
    index('groups_captain_player_id_idx').on(t.captainPlayerId),
    index('groups_product_id_idx').on(t.productId),
    index('groups_product_id_status_idx').on(t.productId, t.status),
    index('groups_product_id_waitlist_position_idx').on(t.productId, t.waitlistPosition),
    index('groups_team_id_idx').on(t.teamId),
    index('groups_status_offer_expires_at_idx').on(t.status, t.offerExpiresAt),
    // Team names are unique per product among live entries (the app trims and compares case-insensitively first).
    uniqueIndex('groups_product_id_name_live_unique')
      .on(t.productId, t.name)
      .where(sql`status <> 'cancelled'`),
  ],
)

/** Answers on the registration form (skill level, preferred division …). Shape is per product kind. */
export type RegistrationAnswers = Record<string, unknown>

export const registrations = sqliteTable(
  'registrations',
  {
    id: id(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'restrict' }),
    groupId: text('group_id').references(() => groups.id, { onDelete: 'set null' }),
    status: text('status', { enum: registrationStatuses }).notNull().default('pending_payment'),
    /** Short unique reference shown to the player and used as the PayID description, e.g. "TVB-7K3Q". */
    reference: text('reference').notNull(),
    /** UTC ISO; an unpaid hold past this is expired by the cron. */
    holdExpiresAt: text('hold_expires_at'),
    answers: text('answers', { mode: 'json' }).$type<RegistrationAnswers>().notNull().default({}),
    /** The player confirmed they hold a Volleyball NSW membership (paid externally via Revolutionise). */
    vnswConfirmed: integer('vnsw_confirmed', { mode: 'boolean' }).notNull().default(false),
    ...timestamps(),
    updatedBy: updatedBy(),
    // ── Phase 6: manual enrolment ──
    /** A league/event entry by an individual without a team; the organiser places them into a group later. */
    freeAgent: integer('free_agent', { mode: 'boolean' }).notNull().default(false),
    /** 1-based place in the waitlist while status = 'waitlist' (gaps allowed; order by it, then created_at). */
    waitlistPosition: integer('waitlist_position'),
    /** When a freed spot was offered (status 'offered') and when the offer lapses (the cron passes it on). */
    offeredAt: text('offered_at'),
    offerExpiresAt: text('offer_expires_at'),
    /** What they owe (AUD cents), copied from the product/programme price at enrolment. Null = no fee. */
    amountCents: integer('amount_cents'),
    /** UTC ISO; null = unpaid. Set by "mark paid" (manual, PayID/cash) or by a Stripe payment later. */
    paidAt: text('paid_at'),
    paidMarkedBy: text('paid_marked_by').references(() => user.id, { onDelete: 'set null' }),
    /** e.g. "PayID 12/10", "cash". */
    paymentNote: text('payment_note'),
    /** The form and version that was answered. */
    formId: text('form_id').references(() => enrolmentForms.id, { onDelete: 'set null' }),
    formVersion: integer('form_version'),
    source: text('source', { enum: registrationSources }).notNull().default('public'),
    cancelledAt: text('cancelled_at'),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    uniqueIndex('registrations_reference_unique').on(t.reference),
    index('registrations_product_id_status_idx').on(t.productId, t.status),
    index('registrations_player_id_idx').on(t.playerId),
    index('registrations_group_id_idx').on(t.groupId),
    index('registrations_status_hold_expires_at_idx').on(t.status, t.holdExpiresAt),
    index('registrations_product_id_waitlist_position_idx').on(t.productId, t.waitlistPosition),
    index('registrations_status_offer_expires_at_idx').on(t.status, t.offerExpiresAt),
    index('registrations_paid_marked_by_idx').on(t.paidMarkedBy),
    index('registrations_form_id_idx').on(t.formId),
    // One live registration per player per product: a double-submitted form can't take two spots.
    uniqueIndex('registrations_product_id_player_id_live_unique').on(t.productId, t.playerId).where(LIVE_REGISTRATION),
  ],
)

export const payments = sqliteTable(
  'payments',
  {
    id: id(),
    registrationId: text('registration_id')
      .notNull()
      .references(() => registrations.id, { onDelete: 'restrict' }),
    provider: text('provider', { enum: paymentProviders }).notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('AUD'),
    status: text('status', { enum: paymentStatuses }).notNull().default('pending'),
    /** Stripe Checkout Session id (cs_…) or PaymentIntent id (pi_…); null for PayID. */
    providerRef: text('provider_ref'),
    /** The admin who marked a PayID payment paid (audited). */
    markedPaidBy: text('marked_paid_by').references(() => user.id, { onDelete: 'set null' }),
    paidAt: text('paid_at'),
    ...timestamps(),
  },
  (t) => [
    index('payments_registration_id_idx').on(t.registrationId),
    uniqueIndex('payments_provider_provider_ref_unique').on(t.provider, t.providerRef),
    index('payments_marked_paid_by_idx').on(t.markedPaidBy),
    index('payments_status_idx').on(t.status),
  ],
)

/** Stripe webhook events already handled, keyed by Stripe's event id, so redelivery is a no-op. */
export const stripeEvents = sqliteTable('stripe_events', {
  /** Stripe event id (evt_…). */
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: text('received_at').notNull().default(SQL_NOW_ISO),
})

/** Every email goes here first; sendEmail() sends it now if under the daily cap, else the cron drains it later. */
export const emailOutbox = sqliteTable(
  'email_outbox',
  {
    id: id(),
    to: text('to').notNull(),
    /** Template name, e.g. "registration.confirmed", "auth.otp". */
    template: text('template').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    status: text('status', { enum: emailStatuses }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    /** UTC ISO; don't send before this. */
    sendAfter: text('send_after').notNull().default(SQL_NOW_ISO),
    sentAt: text('sent_at'),
    /** Resend's message id. */
    providerId: text('provider_id'),
    error: text('error'),
    ...timestamps(),
  },
  (t) => [
    index('email_outbox_status_send_after_idx').on(t.status, t.sendAfter),
    // Per-recipient limits on sign-in emails (mailer.ts) count recent rows by address and template.
    index('email_outbox_to_template_created_at_idx').on(t.to, t.template, t.createdAt),
  ],
)

/** Emails sent per Sydney calendar day, to stay under Resend's 100/day. */
export const emailDailyCount = sqliteTable('email_daily_count', {
  /** YYYY-MM-DD Sydney local for general mail, "YYYY-MM-DD:auth" for sign-in emails (mailer.ts poolKey). */
  day: text('day').primaryKey(),
  sent: integer('sent').notNull().default(0),
  ...timestamps(),
})

export type Product = typeof products.$inferSelect
export type NewProduct = typeof products.$inferInsert
export type Player = typeof players.$inferSelect
export type NewPlayer = typeof players.$inferInsert
export type Group = typeof groups.$inferSelect
export type NewGroup = typeof groups.$inferInsert
export type Registration = typeof registrations.$inferSelect
export type NewRegistration = typeof registrations.$inferInsert
export type Payment = typeof payments.$inferSelect
export type NewPayment = typeof payments.$inferInsert
export type StripeEvent = typeof stripeEvents.$inferSelect
export type NewStripeEvent = typeof stripeEvents.$inferInsert
export type EmailOutboxRow = typeof emailOutbox.$inferSelect
export type NewEmailOutboxRow = typeof emailOutbox.$inferInsert
export type EmailDailyCount = typeof emailDailyCount.$inferSelect
export type NewEmailDailyCount = typeof emailDailyCount.$inferInsert
