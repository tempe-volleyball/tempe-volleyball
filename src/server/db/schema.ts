import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Phase 1 keeps the schema to one table so the migration pipeline can be proven end to end.
// The full data model is planned in PLAN.md ("Data model") and lands phase by phase.

/** Site-wide settings the admin can edit (contact details, PayID, social links …), one row per key. */
export const siteSettings = sqliteTable('site_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull(),
})
