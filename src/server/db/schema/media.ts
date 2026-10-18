import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { id, timestamps, updatedBy, wpId } from './columns'
import { variantExts } from './enums'

// Uploaded images (R2). In its own module so competition (programme images) and content can both reference it
// without an import cycle.

export const media = sqliteTable(
  'media',
  {
    id: id(),
    /** R2 key prefix; files live at `<key_base>/<width>.webp` plus the original. Usually `media/<id>`. */
    keyBase: text('key_base').notNull(),
    filename: text('filename').notNull(),
    alt: text('alt').notNull().default(''),
    mime: text('mime').notNull(),
    width: integer('width'),
    height: integer('height'),
    /** Widths available as resized variants, e.g. [400, 800, 1600]. */
    variants: text('variants', { mode: 'json' }).$type<number[]>().notNull().default([]),
    /**
     * The variants' format: WebP, or JPEG from browsers that can't encode WebP (older Safari). Files are
     * `<key_base>/<width>.<variant_ext>`.
     */
    variantExt: text('variant_ext', { enum: variantExts }).notNull().default('webp'),
    /** Size of the original in bytes. */
    bytes: integer('bytes').notNull(),
    uploadedBy: text('uploaded_by').references(() => user.id, { onDelete: 'set null' }),
    wpId: wpId(),
    /** The WordPress URL of the original, so the importer can rewrite old image links in bodies. */
    wpUrl: text('wp_url'),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    index('media_uploaded_by_idx').on(t.uploadedBy),
    uniqueIndex('media_wp_id_unique').on(t.wpId),
    index('media_wp_url_idx').on(t.wpUrl),
  ],
)

export type Media = typeof media.$inferSelect
export type NewMedia = typeof media.$inferInsert
