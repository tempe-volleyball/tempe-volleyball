import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { id, SQL_NOW_ISO, timestamps, updatedBy, wpId } from './columns'
import { seasons } from './competition'
import { emailStatuses, groupKinds, paymentProviders, paymentStatuses, productKinds, registrationStatuses } from './enums'
import type { PaymentProviderId } from './enums'

// Registrations, payments and the email outbox. See PLAN.md "Registrations and payments".
// Money is integer cents (AUD). One payment covers one player and one product; there are no team fees.

/** Something a player can register and pay for: a season entry, a training session, an ADP or JDP term. */
export const products = sqliteTable(
  'products',
  {
    id: id(),
    kind: text('kind', { enum: productKinds }).notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    priceCents: integer('price_cents').notNull(),
    /** Max paid + held registrations; null = unlimited. Training sessions are 40. */
    capacity: integer('capacity'),
    /** YYYY-MM-DD Sydney local: when the thing itself runs. */
    startsOn: text('starts_on'),
    endsOn: text('ends_on'),
    /** UTC ISO: when registration opens and closes. */
    opensAt: text('opens_at'),
    closesAt: text('closes_at'),
    seasonId: text('season_id').references(() => seasons.id, { onDelete: 'set null' }),
    paymentMethods: text('payment_methods', { mode: 'json' }).$type<PaymentProviderId[]>().notNull().default(['stripe', 'payid']),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    wpId: wpId(),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    uniqueIndex('products_slug_unique').on(t.slug),
    index('products_season_id_idx').on(t.seasonId),
    index('products_kind_active_idx').on(t.kind, t.active),
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

/** A team or group signing up together. Each member still registers and pays individually (registrations.group_id). */
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
  },
  (t) => [index('groups_captain_player_id_idx').on(t.captainPlayerId), index('groups_product_id_idx').on(t.productId)],
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
  },
  (t) => [
    uniqueIndex('registrations_reference_unique').on(t.reference),
    index('registrations_product_id_status_idx').on(t.productId, t.status),
    index('registrations_player_id_idx').on(t.playerId),
    index('registrations_group_id_idx').on(t.groupId),
    index('registrations_status_hold_expires_at_idx').on(t.status, t.holdExpiresAt),
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
