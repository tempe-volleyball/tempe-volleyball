// The whole D1 schema (PLAN.md "Data model"), split by area under ./schema/ and re-exported here. Import tables,
// row types and enum arrays from this module. drizzle-kit reads this file (drizzle.config.ts).
//
// Conventions: text ids (crypto.randomUUID()) except join tables; money in integer cents (AUD); instants as UTC ISO
// text; dates YYYY-MM-DD and times HH:MM in Sydney local time; wp_id on imported rows; created_at/updated_at on
// every table and updated_by on content tables. Better Auth's own tables (auth.ts) keep its integer-ms timestamps.

export * from './schema/enums'
export { nowIso, EMPTY_BODY } from './schema/columns'
export * from './schema/auth'
export * from './schema/media'
export * from './schema/forms'
export * from './schema/competition'
export * from './schema/programmes'
export * from './schema/content'
export * from './schema/admin'
export * from './schema/registrations'
export * from './schema/analytics'
export * from './schema/contact'
export * from './schema/relations'

import type { account, session, twoFactor, user, verification } from './schema/auth'

export type User = typeof user.$inferSelect
export type NewUser = typeof user.$inferInsert
export type Session = typeof session.$inferSelect
export type Account = typeof account.$inferSelect
export type Verification = typeof verification.$inferSelect
export type TwoFactor = typeof twoFactor.$inferSelect
