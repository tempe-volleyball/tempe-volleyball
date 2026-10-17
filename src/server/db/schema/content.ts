import { index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { id, SQL_NOW_ISO, timestamps, updatedBy, wpId } from './columns'
import { leagues } from './competition'
import { contentStatuses, menuItemKinds, pageTemplates, redirectSources } from './enums'

// Content: pages, revisions, news posts, the menu, media and redirects. See PLAN.md "Content".

/**
 * A page or post body: the editor's JSON blocks plus the sanitised HTML rendered from them (what the public site
 * serves). `blocks` is opaque to the database; the editor module owns its shape.
 */
export type ContentBody = { blocks: unknown[]; html: string }

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
    /** Widths available as WebP variants, e.g. [400, 800, 1600]. */
    variants: text('variants', { mode: 'json' }).$type<number[]>().notNull().default([]),
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

/** Editable pages. Ladder and fixture pages are routes driven by league data, not pages. */
export const pages = sqliteTable(
  'pages',
  {
    id: id(),
    /** Unique URL path with a leading slash and no trailing slash, e.g. "/about"; "/" for the home page. */
    path: text('path').notNull(),
    title: text('title').notNull(),
    metaDescription: text('meta_description'),
    ogImageId: text('og_image_id').references(() => media.id, { onDelete: 'set null' }),
    template: text('template', { enum: pageTemplates }).notNull().default('content'),
    body: text('body', { mode: 'json' }).$type<ContentBody>().notNull(),
    status: text('status', { enum: contentStatuses }).notNull().default('draft'),
    publishedAt: text('published_at'),
    wpId: wpId(),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    uniqueIndex('pages_path_unique').on(t.path),
    index('pages_og_image_id_idx').on(t.ogImageId),
    uniqueIndex('pages_wp_id_unique').on(t.wpId),
  ],
)

/** Earlier versions of a page (keep the last ~20 per page). Immutable, so no updated_at. */
export const pageRevisions = sqliteTable(
  'page_revisions',
  {
    id: id(),
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body', { mode: 'json' }).$type<ContentBody>().notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: text('created_at').notNull().default(SQL_NOW_ISO),
  },
  (t) => [index('page_revisions_page_id_created_at_idx').on(t.pageId, t.createdAt), index('page_revisions_created_by_idx').on(t.createdBy)],
)

/** News posts. */
export const posts = sqliteTable(
  'posts',
  {
    id: id(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    excerpt: text('excerpt'),
    body: text('body', { mode: 'json' }).$type<ContentBody>().notNull(),
    coverMediaId: text('cover_media_id').references(() => media.id, { onDelete: 'set null' }),
    category: text('category'),
    status: text('status', { enum: contentStatuses }).notNull().default('draft'),
    publishedAt: text('published_at'),
    wpId: wpId(),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    uniqueIndex('posts_slug_unique').on(t.slug),
    index('posts_status_published_at_idx').on(t.status, t.publishedAt),
    index('posts_cover_media_id_idx').on(t.coverMediaId),
    uniqueIndex('posts_wp_id_unique').on(t.wpId),
  ],
)

/**
 * The site menu, two levels (parent_id null = top level). By kind: `page` uses page_id, `url` uses url,
 * `league_ladder` / `league_fixtures` use league_id and always point at that league's current season.
 */
export const menuItems = sqliteTable(
  'menu_items',
  {
    id: id(),
    parentId: text('parent_id').references((): AnySQLiteColumn => menuItems.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    kind: text('kind', { enum: menuItemKinds }).notNull(),
    pageId: text('page_id').references(() => pages.id, { onDelete: 'cascade' }),
    leagueId: text('league_id').references(() => leagues.id, { onDelete: 'cascade' }),
    url: text('url'),
    sort: integer('sort').notNull().default(0),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [
    index('menu_items_parent_id_sort_idx').on(t.parentId, t.sort),
    index('menu_items_page_id_idx').on(t.pageId),
    index('menu_items_league_id_idx').on(t.leagueId),
  ],
)

/** Old URLs to new. Checked only when no route matches. */
export const redirects = sqliteTable(
  'redirects',
  {
    id: id(),
    /** Path as requested, leading slash, no query string, e.g. "/sp_event/foo-vs-bar". */
    fromPath: text('from_path').notNull(),
    toPath: text('to_path').notNull(),
    status: integer('status').notNull().default(301),
    source: text('source', { enum: redirectSources }).notNull().default('manual'),
    hits: integer('hits').notNull().default(0),
    lastHitAt: text('last_hit_at'),
    ...timestamps(),
    updatedBy: updatedBy(),
  },
  (t) => [uniqueIndex('redirects_from_path_unique').on(t.fromPath)],
)

export type Media = typeof media.$inferSelect
export type NewMedia = typeof media.$inferInsert
export type Page = typeof pages.$inferSelect
export type NewPage = typeof pages.$inferInsert
export type PageRevision = typeof pageRevisions.$inferSelect
export type NewPageRevision = typeof pageRevisions.$inferInsert
export type Post = typeof posts.$inferSelect
export type NewPost = typeof posts.$inferInsert
export type MenuItem = typeof menuItems.$inferSelect
export type NewMenuItem = typeof menuItems.$inferInsert
export type Redirect = typeof redirects.$inferSelect
export type NewRedirect = typeof redirects.$inferInsert
