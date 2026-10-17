import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import type { FormField } from '../../../lib/enrolment/forms'
import { id, timestamps, updatedBy } from './columns'

// Enrolment forms (docs/admin.md §3.7). In its own module because programmes (leagues.enrolment_form_id) and
// products (products.form_id) both point here. Field types are in src/lib/enrolment/forms.ts.

/**
 * A reusable form: the extra questions asked on enrolment. A programme names its default form; a product (one season,
 * session, term or event) can override it. Archive rather than delete once registrations reference it.
 */
export const enrolmentForms = sqliteTable('enrolment_forms', {
  id: id(),
  /** Admin-facing name, e.g. "Junior programmes (with guardian)". */
  name: text('name').notNull(),
  description: text('description'),
  fields: text('fields', { mode: 'json' }).$type<FormField[]>().notNull().default([]),
  /** Bumped on every save; registrations.form_version records which version was answered. */
  version: integer('version').notNull().default(1),
  /** Shown after a successful enrolment (plain text; the email uses it too). Null = the default message. */
  confirmationText: text('confirmation_text'),
  /** Set when archived: hidden from pickers, still readable for old registrations. */
  archivedAt: text('archived_at'),
  ...timestamps(),
  updatedBy: updatedBy(),
})

export type EnrolmentForm = typeof enrolmentForms.$inferSelect
export type NewEnrolmentForm = typeof enrolmentForms.$inferInsert
