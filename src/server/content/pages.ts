import { and, desc, eq, ne, notInArray, or, sql } from 'drizzle-orm'
import { tags } from '../cache'
import { runBatch, type AppDb } from '../db'
import {
  categories,
  menuItems,
  pageRevisions,
  pages,
  pageTemplates,
  user,
  type ContentBody,
  type Page,
  type PageTemplate,
} from '../db/schema'
import { checkPagePath, planMove } from '../../lib/content/paths'
import { checkBlocks, renderBlocks } from '../../lib/content/render'
import {
  assertMedia,
  audit,
  clearRedirectFrom,
  conflict,
  invalid,
  isUniqueFailure,
  likeEscaped,
  likePattern,
  moveRedirectStatements,
  notFound,
  optionalText,
  requiredText,
  type Changed,
  type Editor,
} from './common'

// Editable pages: list, create, edit (with revisions), publish/unpublish, delete, restore a revision.
//
// A page has one body; saving a published page updates the live page (like WordPress's "Update"), and every save
// keeps a revision (the last REVISION_LIMIT per page) so any edit can be undone. When a published page's path
// changes, the old path gets a 301 to the new one in the same batch.

export const REVISION_LIMIT = 20
export const MAX_TITLE = 200
export const MAX_META_DESCRIPTION = 300

export type PageInput = {
  title?: unknown
  path?: unknown
  metaDescription?: unknown
  ogImageId?: unknown
  template?: unknown
  blocks?: unknown
  /** The updatedAt the editor loaded; a save is refused if someone else saved since. */
  baseUpdatedAt?: unknown
}

export type PageSummary = Pick<Page, 'id' | 'path' | 'title' | 'status' | 'template' | 'updatedAt' | 'publishedAt'>

const summary = {
  id: pages.id,
  path: pages.path,
  title: pages.title,
  status: pages.status,
  template: pages.template,
  updatedAt: pages.updatedAt,
  publishedAt: pages.publishedAt,
}

export async function listPages(db: AppDb, opts: { q?: string } = {}): Promise<PageSummary[]> {
  const q = opts.q?.trim()
  const where = q ? or(likeEscaped(pages.title, likePattern(q)), likeEscaped(pages.path, likePattern(q))) : undefined
  return db.select(summary).from(pages).where(where).orderBy(pages.path).limit(500).all()
}

export type RevisionSummary = { id: string; title: string; createdAt: string; createdBy: string | null }

export async function getPage(db: AppDb, id: string) {
  const [page, revisions] = await Promise.all([
    db.select().from(pages).where(eq(pages.id, id)).get(),
    db
      .select({ id: pageRevisions.id, title: pageRevisions.title, createdAt: pageRevisions.createdAt, createdBy: user.email })
      .from(pageRevisions)
      .leftJoin(user, eq(user.id, pageRevisions.createdBy))
      .where(eq(pageRevisions.pageId, id))
      .orderBy(desc(pageRevisions.createdAt), desc(pageRevisions.id))
      .limit(REVISION_LIMIT)
      .all(),
  ])
  if (!page) throw notFound('page')
  return { page, revisions: revisions as RevisionSummary[] }
}

export async function getRevision(db: AppDb, pageId: string, revisionId: string) {
  const rev = await db
    .select()
    .from(pageRevisions)
    .where(and(eq(pageRevisions.id, revisionId), eq(pageRevisions.pageId, pageId)))
    .get()
  if (!rev) throw notFound('revision')
  return rev
}

const body = (blocks: unknown): ContentBody => {
  const checked = checkBlocks(blocks)
  if (!checked.ok) throw invalid(checked.message)
  return { blocks: checked.blocks, html: renderBlocks(checked.blocks) }
}

const template = (v: unknown): PageTemplate => {
  if (v === undefined || v === null) return 'content'
  if (typeof v !== 'string' || !(pageTemplates as readonly string[]).includes(v)) throw invalid('Unknown page template.')
  return v as PageTemplate
}

const path = (v: unknown) => {
  if (typeof v !== 'string') throw invalid('Enter a path, like /about.')
  const checked = checkPagePath(v)
  if (!checked.ok) throw invalid(checked.message)
  return checked.path
}

async function assertPathFree(db: AppDb, p: string, exceptId?: string) {
  const taken = await db
    .select({ id: pages.id, title: pages.title })
    .from(pages)
    .where(exceptId ? and(eq(pages.path, p), ne(pages.id, exceptId)) : eq(pages.path, p))
    .get()
  if (taken) throw conflict(`${p} is already used by the page “${taken.title}”.`)
  // Category landing pages live at /<slug> too (src/server/programmes/categories.ts).
  const category = /^\/[^/]+$/.test(p)
    ? await db
        .select({ name: categories.name })
        .from(categories)
        .where(eq(categories.slug, p.slice(1)))
        .get()
    : null
  if (category) throw conflict(`${p} is the landing page of the category “${category.name}”.`)
}

const pathTaken = (p: string) => conflict(`${p} is already used by another page.`)

/** Keeps the newest REVISION_LIMIT revisions of a page. */
// A query builder, not db.run(sql``): drizzle's D1 batch() can't bind parameters of raw db.run() statements.
const pruneRevisions = (db: AppDb, pageId: string) =>
  db
    .delete(pageRevisions)
    .where(
      and(
        eq(pageRevisions.pageId, pageId),
        notInArray(
          pageRevisions.id,
          db
            .select({ id: pageRevisions.id })
            .from(pageRevisions)
            .where(eq(pageRevisions.pageId, pageId))
            .orderBy(desc(pageRevisions.createdAt), desc(pageRevisions.id))
            .limit(REVISION_LIMIT),
        ),
      ),
    )

/** Every page change that's live purges the page; path and status changes also purge the layout (menu links). */
const pagePurge = (paths: string[], layout: boolean) => ({
  tags: [...paths.map(tags.page), ...(layout ? [tags.site] : [])],
})

export async function createPage(db: AppDb, actor: Editor, input: PageInput, now = new Date()): Promise<Page> {
  const values = {
    id: crypto.randomUUID(),
    title: requiredText(input.title, 'Title', MAX_TITLE),
    path: path(input.path),
    metaDescription: optionalText(input.metaDescription, 'Meta description', MAX_META_DESCRIPTION),
    ogImageId: typeof input.ogImageId === 'string' && input.ogImageId ? input.ogImageId : null,
    template: template(input.template),
    body: body(input.blocks ?? []),
    status: 'draft' as const,
    updatedBy: actor.id,
  }
  await Promise.all([assertPathFree(db, values.path), assertMedia(db, values.ogImageId, 'Social image')])
  const at = now.toISOString()
  try {
    await runBatch(db, [
      db.insert(pages).values({ ...values, createdAt: at, updatedAt: at }),
      db.insert(pageRevisions).values({ pageId: values.id, title: values.title, body: values.body, createdBy: actor.id, createdAt: at }),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'pages.path')) throw pathTaken(values.path)
    throw e
  }
  return (await db.select().from(pages).where(eq(pages.id, values.id)).get())!
}

/** Saves the editor's changes. Fields left out keep their value. */
export async function updatePage(
  db: AppDb,
  actor: Editor,
  id: string,
  input: PageInput,
  now = new Date(),
  restored?: ContentBody,
): Promise<Changed<Page>> {
  const [page, revs] = await Promise.all([
    db.select().from(pages).where(eq(pages.id, id)).get(),
    db
      .select({ n: sql<number>`count(*)` })
      .from(pageRevisions)
      .where(eq(pageRevisions.pageId, id))
      .get(),
  ])
  if (!page) throw notFound('page')
  if (typeof input.baseUpdatedAt === 'string' && input.baseUpdatedAt !== page.updatedAt)
    throw conflict('Someone else saved this page while you were editing. Reload it to see their changes (copy yours first).')

  const next = {
    title: input.title === undefined ? page.title : requiredText(input.title, 'Title', MAX_TITLE),
    // Only a changed path is re-validated, so imported pages with unusual paths can still be edited.
    path: input.path === undefined || input.path === page.path ? page.path : path(input.path),
    metaDescription:
      input.metaDescription === undefined
        ? page.metaDescription
        : optionalText(input.metaDescription, 'Meta description', MAX_META_DESCRIPTION),
    ogImageId:
      input.ogImageId === undefined ? page.ogImageId : typeof input.ogImageId === 'string' && input.ogImageId ? input.ogImageId : null,
    template: input.template === undefined ? page.template : template(input.template),
    body: restored ?? (input.blocks === undefined ? page.body : body(input.blocks)),
  }
  const moved = next.path !== page.path
  await Promise.all([
    moved ? assertPathFree(db, next.path, id) : null,
    next.ogImageId !== page.ogImageId ? assertMedia(db, next.ogImageId, 'Social image') : null,
  ])
  const at = now.toISOString()
  // Published at least once: the old URL may be bookmarked or indexed, so it redirects.
  const move = moved && page.publishedAt ? planMove(page.path, next.path) : null
  try {
    await runBatch(db, [
      db
        .update(pages)
        .set({ ...next, updatedAt: at, updatedBy: actor.id })
        .where(eq(pages.id, id)),
      // A page with no history yet (imported, or created before revisions) keeps its current version first, so the
      // first edit can be undone too.
      ...(revs?.n
        ? []
        : [
            db.insert(pageRevisions).values({
              pageId: id,
              title: page.title,
              body: page.body,
              createdBy: page.updatedBy,
              createdAt: page.updatedAt < at ? page.updatedAt : new Date(now.getTime() - 1).toISOString(),
            }),
          ]),
      db.insert(pageRevisions).values({ pageId: id, title: next.title, body: next.body, createdBy: actor.id, createdAt: at }),
      pruneRevisions(db, id),
      ...(move ? moveRedirectStatements(db, move, actor, at) : []),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'pages.path')) throw pathTaken(next.path)
    throw e
  }
  const saved = (await db.select().from(pages).where(eq(pages.id, id)).get())!
  return { result: saved, purge: page.status === 'published' ? pagePurge(moved ? [page.path, next.path] : [next.path], moved) : {} }
}

export type PageStatusChange = 'published' | 'draft' | 'archived'

/** Publishes, unpublishes (back to draft) or archives a page. Audited. */
export async function setPageStatus(
  db: AppDb,
  actor: Editor,
  id: string,
  status: PageStatusChange,
  now = new Date(),
): Promise<Changed<Page>> {
  if (!['published', 'draft', 'archived'].includes(status)) throw invalid('Unknown status.')
  const page = await db.select().from(pages).where(eq(pages.id, id)).get()
  if (!page) throw notFound('page')
  if (page.status === status) return { result: page, purge: {} }
  const at = now.toISOString()
  const publishing = status === 'published'
  await runBatch(db, [
    db
      .update(pages)
      .set({ status, publishedAt: publishing ? (page.publishedAt ?? at) : page.publishedAt, updatedAt: at, updatedBy: actor.id })
      .where(eq(pages.id, id)),
    audit(
      db,
      actor,
      publishing ? 'page.publish' : 'page.unpublish',
      { type: 'page', id },
      { status: page.status, path: page.path, title: page.title },
      { status, path: page.path, title: page.title },
      at,
    ),
    ...(publishing ? [clearRedirectFrom(db, page.path)] : []),
  ])
  const saved = (await db.select().from(pages).where(eq(pages.id, id)).get())!
  return { result: saved, purge: pagePurge([page.path], true) }
}

/** Deletes a page and its revisions. Refused while the menu links to it, so the menu never loses items silently. */
export async function deletePage(db: AppDb, actor: Editor, id: string, now = new Date()): Promise<Changed<{ id: string }>> {
  const [page, inMenu] = await Promise.all([
    db.select().from(pages).where(eq(pages.id, id)).get(),
    db.select({ label: menuItems.label }).from(menuItems).where(eq(menuItems.pageId, id)).all(),
  ])
  if (!page) throw notFound('page')
  if (inMenu.length)
    throw conflict(`The menu links to this page (${inMenu.map((m) => `“${m.label}”`).join(', ')}). Remove it from the menu first.`)
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(pages).where(eq(pages.id, id)),
    audit(db, actor, 'page.delete', { type: 'page', id }, { path: page.path, title: page.title, status: page.status }, null, at),
  ])
  return { result: { id }, purge: page.status === 'published' ? pagePurge([page.path], false) : {} }
}

/** Puts a revision's title and body back (as a new save, so the restore itself can be undone). */
export async function restoreRevision(db: AppDb, actor: Editor, pageId: string, revisionId: string, now = new Date()) {
  const rev = await getRevision(db, pageId, revisionId)
  // Re-render from the stored blocks, so a revision saved under older rules comes back sanitised by today's. A
  // revision without blocks (an imported body that was never edited) is put back as it was.
  const blocks = Array.isArray(rev.body.blocks) ? rev.body.blocks : []
  return blocks.length || !rev.body.html
    ? updatePage(db, actor, pageId, { title: rev.title, blocks }, now)
    : updatePage(db, actor, pageId, { title: rev.title }, now, { blocks: [], html: rev.body.html })
}
