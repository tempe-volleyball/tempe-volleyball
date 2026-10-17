import { sql } from 'drizzle-orm'
import { integer, text } from 'drizzle-orm/sqlite-core'
import { user } from './auth'

// Column helpers shared by our tables, so the conventions in PLAN.md ("Data model") stay uniform.

/** Now as a UTC ISO-8601 string with milliseconds, e.g. 2026-10-18T03:04:05.678Z (same as Date#toISOString). */
export const nowIso = () => new Date().toISOString()

/** SQL default matching nowIso(), so rows inserted by raw SQL (importer, wrangler d1 execute) get it too. */
export const SQL_NOW_ISO = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`

/** A text primary key filled with crypto.randomUUID() when the insert doesn't set one. */
export const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())

/** created_at / updated_at as UTC ISO text. updated_at is refreshed by Drizzle on every update builder call. */
export const timestamps = () => ({
  createdAt: text('created_at').notNull().default(SQL_NOW_ISO),
  updatedAt: text('updated_at').notNull().default(SQL_NOW_ISO).$onUpdateFn(nowIso),
})

/** The WordPress post/term id an imported row came from (unique per table), so the importer can re-run. */
export const wpId = () => integer('wp_id')

/** The admin user who last changed a row. Becomes null if that user is deleted. */
export const updatedBy = () => text('updated_by').references(() => user.id, { onDelete: 'set null' })
