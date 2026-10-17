import { index, integer, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { user } from './auth'
import { id, SQL_NOW_ISO, timestamps, updatedBy, wpId, type ContentBody } from './columns'
import { categories, leagues } from './competition'
import { media } from './media'
import { contentStatuses, menuItemKinds, menuPlacements, pageDataRefKinds, pageTemplates, redirectSources } from './enums'

// Content: pages, revisions, news posts, the menu, page data refs and redirects (media is in media.ts). See PLAN.md "Content".

export type { ContentBody } from './columns'

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
 * Phase 6: `category` uses category_id and expands on its own into the landing page plus one link per active,
 * menu-visible programme in it; its hand-made children sit `before` or `after` those automatic links (placement).
 * `programme` uses league_id (any kind) and links that programme's page.
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
    // ── Phase 6 ──
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'cascade' }),
    /** Children of a `category` item: before or after the automatic programme links. Null = after. */
    placement: text('placement', { enum: menuPlacements }),
    /** Kept in the admin but not shown on the site. */
    hidden: integer('hidden', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('menu_items_parent_id_sort_idx').on(t.parentId, t.sort),
    index('menu_items_page_id_idx').on(t.pageId),
    index('menu_items_league_id_idx').on(t.leagueId),
    index('menu_items_category_id_idx').on(t.categoryId),
  ],
)

/**
 * Which data each page's blocks read (src/lib/content/blocks.ts), rewritten whenever a page is saved, so a data change
 * purges exactly the pages that show it. `programme_list` rows have ref_id '' (any programme change purges them);
 * `ladder` / `fixtures` rows have the league id.
 */
export const pageDataRefs = sqliteTable(
  'page_data_refs',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: pageDataRefKinds }).notNull(),
    /** leagues.id for ladder/fixtures; '' for programme lists. */
    refId: text('ref_id').notNull().default(''),
    createdAt: text('created_at').notNull().default(SQL_NOW_ISO),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.kind, t.refId] }), index('page_data_refs_kind_ref_id_idx').on(t.kind, t.refId)],
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

export type Page = typeof pages.$inferSelect
export type NewPage = typeof pages.$inferInsert
export type PageRevision = typeof pageRevisions.$inferSelect
export type NewPageRevision = typeof pageRevisions.$inferInsert
export type Post = typeof posts.$inferSelect
export type NewPost = typeof posts.$inferInsert
export type MenuItem = typeof menuItems.$inferSelect
export type NewMenuItem = typeof menuItems.$inferInsert
export type PageDataRef = typeof pageDataRefs.$inferSelect
export type NewPageDataRef = typeof pageDataRefs.$inferInsert
export type Redirect = typeof redirects.$inferSelect
export type NewRedirect = typeof redirects.$inferInsert
