import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { id, timestamps } from './columns'
import { contactMessageStatuses } from './enums'

// Messages sent with the public contact form (docs/admin.md §3.15, docs/api/contact.md). Every message is stored
// before any email goes, so nothing is lost when Resend isn't set up or the daily cap is reached. Personal data
// (name, email, the message): admins and owners only, never cached, pruned by the hourly cron once handled for
// Settings → Contact form's "days to keep handled messages" (default 365).

export const contactMessages = sqliteTable(
  'contact_messages',
  {
    id: id(),
    name: text('name').notNull(),
    /** As typed (trimmed, lower-cased domain); the reply-to of the notification. */
    email: text('email').notNull(),
    /** One of Settings → Contact form's topics when it was sent ('' when the list is empty). Kept as text. */
    topic: text('topic').notNull().default(''),
    message: text('message').notNull(),
    /** new → read (opened in the admin) → handled. Handled ones are pruned after the retention period. */
    status: text('status', { enum: contactMessageStatuses }).notNull().default('new'),
    /** The page the form was on, e.g. "/contact". */
    pagePath: text('page_path'),
    /** UTC ISO, when it was first opened. */
    readAt: text('read_at'),
    /** UTC ISO, when it was marked handled (the retention clock). */
    handledAt: text('handled_at'),
    handledBy: text('handled_by').references(() => user.id, { onDelete: 'set null' }),
    /** The admin's own note ("Replied 20/10, placed in TNL B"). */
    note: text('note'),
    ...timestamps(),
  },
  (t) => [
    index('contact_messages_status_created_at_idx').on(t.status, t.createdAt),
    index('contact_messages_created_at_idx').on(t.createdAt),
    index('contact_messages_handled_at_idx').on(t.handledAt),
    index('contact_messages_handled_by_idx').on(t.handledBy),
  ],
)

export type ContactMessage = typeof contactMessages.$inferSelect
