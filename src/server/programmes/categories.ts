import { and, asc, count, eq, inArray, ne } from 'drizzle-orm'
import { slugify } from '../../lib/content/paths'
import { categoryPath } from '../../lib/programmes'
import { tags } from '../cache'
import { runBatch, type AppDb } from '../db'
import { categories, menuItems, programmes, categoryStatuses, type Category, type CategoryStatus } from '../db/schema'
import {
  assertMedia,
  audit,
  conflict,
  isUniqueFailure,
  notFound,
  optionalText,
  requiredText,
  type Changed,
  type Editor,
} from '../content/common'
import { assertNoPageAt, categorySlug, has, idOrNull, invalid, moveTreeStatements, purgeOf, richText } from './common'

// Programme categories (docs/admin.md §3.2): Mixed Leagues, Super League, Juniors, Adult Training. Each has a landing
// page at /<slug> listing its programmes, and can be a `category` menu item that expands into a dropdown.
//
// Rules: slugs are unique, valid page paths and not used by a page. Changing the slug of a category that has been
// public leaves a 301. Retiring is refused while it has active programmes (move or retire them first). Delete only
// when no programme (of any status) is in it and the menu doesn't link to it.

export const CATEGORY_LIMITS = { name: 80, seoTitle: 120, seoDescription: 300 } as const

export type CategoryListItem = Category & {
  path: string
  /** Programmes in it by status. */
  programmes: { draft: number; active: number; retired: number }
  /** Menu items pointing at it. */
  menuItems: number
}

export async function listCategories(db: AppDb): Promise<CategoryListItem[]> {
  const [rows, counts, menu] = (await runBatch(db, [
    db.select().from(categories).orderBy(asc(categories.sort), asc(categories.name)),
    db
      .select({ categoryId: programmes.categoryId, status: programmes.status, n: count() })
      .from(programmes)
      .groupBy(programmes.categoryId, programmes.status),
    db.select({ categoryId: menuItems.categoryId, n: count() }).from(menuItems).groupBy(menuItems.categoryId),
  ])) as unknown as [
    Category[],
    { categoryId: string | null; status: CategoryStatus; n: number }[],
    { categoryId: string | null; n: number }[],
  ]
  return rows.map((c) => {
    const by = { draft: 0, active: 0, retired: 0 }
    for (const r of counts) if (r.categoryId === c.id) by[r.status] += r.n
    return { ...c, path: categoryPath(c.slug), programmes: by, menuItems: menu.find((m) => m.categoryId === c.id)?.n ?? 0 }
  })
}

const loadRow = async (db: AppDb, id: string) => {
  const c = await db.select().from(categories).where(eq(categories.id, id)).get()
  if (!c) throw notFound('category')
  return c
}

const getItem = async (db: AppDb, id: string) => {
  const item = (await listCategories(db)).find((c) => c.id === id)
  if (!item) throw notFound('category')
  return item
}

type Patch = Partial<Pick<Category, 'name' | 'slug' | 'intro' | 'seoTitle' | 'seoDescription' | 'ogImageId' | 'status'>>

function parse(input: Record<string, unknown>): Patch {
  const out: Patch = {}
  if (has(input, 'name')) out.name = requiredText(input.name, 'Name', CATEGORY_LIMITS.name)
  if (has(input, 'slug')) out.slug = categorySlug(input.slug)
  if (has(input, 'intro')) out.intro = richText(input.intro)
  if (has(input, 'seoTitle')) out.seoTitle = optionalText(input.seoTitle, 'Search title', CATEGORY_LIMITS.seoTitle)
  if (has(input, 'seoDescription'))
    out.seoDescription = optionalText(input.seoDescription, 'Search description', CATEGORY_LIMITS.seoDescription)
  if (has(input, 'ogImageId')) out.ogImageId = idOrNull(input.ogImageId, 'Social image')
  if (has(input, 'status')) {
    if (typeof input.status !== 'string' || !(categoryStatuses as readonly string[]).includes(input.status))
      throw invalid('Unknown status.')
    out.status = input.status as CategoryStatus
  }
  return out
}

async function assertSlugFree(db: AppDb, s: string, exceptId?: string) {
  const taken = await db
    .select({ name: categories.name })
    .from(categories)
    .where(exceptId ? and(eq(categories.slug, s), ne(categories.id, exceptId)) : eq(categories.slug, s))
    .get()
  if (taken) throw conflict(`/${s} is already used by the category “${taken.name}”.`)
  await assertNoPageAt(db, categoryPath(s))
}

const isPublic = (c: Category | null) => !!c && c.status !== 'draft'

/** A category's page, plus SITE when the menu could show the change (name, URL, status, order). */
function purgeFor(before: Category | null, after: Category | null, listing: boolean) {
  if (!isPublic(before) && !isPublic(after)) return {}
  const list = [before, after].filter((c): c is Category => !!c).map((c) => tags.category(c.slug))
  list.push(tags.programmes)
  if (listing) list.push(tags.site)
  return purgeOf(list)
}

const uniqueSlug = (e: unknown, s: string) =>
  isUniqueFailure(e, 'categories.slug') ? conflict(`/${s} is already used by another category.`) : null

export async function createCategory(
  db: AppDb,
  actor: Editor,
  input: Record<string, unknown>,
  now = new Date(),
): Promise<Changed<CategoryListItem>> {
  const patch = parse(input)
  if (!patch.name) throw invalid('Name is required.')
  const s = patch.slug ?? categorySlug(slugify(patch.name))
  if (patch.status === 'retired') throw invalid('A new category starts as a draft or active.')
  await Promise.all([assertSlugFree(db, s), assertMedia(db, patch.ogImageId, 'Social image')])
  const last = await db.select({ sort: categories.sort }).from(categories).orderBy(asc(categories.sort)).all()
  const values = {
    ...patch,
    slug: s,
    name: patch.name,
    status: patch.status ?? 'draft',
    id: crypto.randomUUID(),
    sort: (last.at(-1)?.sort ?? 0) + 1,
    updatedBy: actor.id,
  }
  const at = now.toISOString()
  try {
    await runBatch(db, [
      db.insert(categories).values({ ...values, createdAt: at, updatedAt: at }),
      audit(
        db,
        actor,
        'category.create',
        { type: 'category', id: values.id },
        null,
        { name: values.name, slug: s, status: values.status },
        at,
      ),
    ])
  } catch (e) {
    throw uniqueSlug(e, s) ?? e
  }
  const saved = await loadRow(db, values.id)
  return { result: await getItem(db, values.id), purge: purgeFor(null, saved, true) }
}

export async function updateCategory(
  db: AppDb,
  actor: Editor,
  id: string,
  input: Record<string, unknown> & { baseUpdatedAt?: unknown },
  now = new Date(),
): Promise<Changed<CategoryListItem>> {
  const current = await loadRow(db, id)
  if (typeof input.baseUpdatedAt === 'string' && input.baseUpdatedAt !== current.updatedAt)
    throw conflict('Someone else changed this category while you were working on it. Reload to see their changes.')
  const patch = parse(input)
  const next = { ...current, ...patch }
  if (next.slug !== current.slug) await assertSlugFree(db, next.slug, id)
  if (next.ogImageId !== current.ogImageId) await assertMedia(db, next.ogImageId, 'Social image')
  if (next.status !== current.status) {
    if (next.status === 'retired' || next.status === 'draft') {
      const live = await db
        .select({ name: programmes.name })
        .from(programmes)
        .where(and(eq(programmes.categoryId, id), eq(programmes.status, 'active')))
        .all()
      if (live.length)
        throw conflict(
          `${live.map((p) => p.name).join(', ')} ${live.length === 1 ? 'is' : 'are'} still active in this category. Move or retire ${live.length === 1 ? 'it' : 'them'} first.`,
        )
    }
  }
  const keys = (Object.keys(patch) as (keyof Patch)[]).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]))
  if (keys.length === 0) return { result: await getItem(db, id), purge: {} }
  const at = now.toISOString()
  const moved = next.slug !== current.slug && isPublic(current)
  const pick = (c: Category) => Object.fromEntries(keys.map((k) => [k, k === 'intro' ? '(rich text)' : c[k]]))
  const statusOnly = keys.length === 1 && keys[0] === 'status'
  try {
    await runBatch(db, [
      db
        .update(categories)
        .set({ ...patch, updatedAt: at, updatedBy: actor.id })
        .where(eq(categories.id, id)),
      audit(db, actor, statusOnly ? 'category.status' : 'category.update', { type: 'category', id }, pick(current), pick(next), at),
      ...(moved ? moveTreeStatements(db, { from: categoryPath(current.slug), to: categoryPath(next.slug) }, [], actor, at) : []),
    ])
  } catch (e) {
    throw uniqueSlug(e, next.slug) ?? e
  }
  const saved = await loadRow(db, id)
  const listing = keys.some((k) => k === 'name' || k === 'slug' || k === 'status')
  return { result: await getItem(db, id), purge: purgeFor(current, saved, listing) }
}

/** Saves the order (menu and listing order): every category id, first first. */
export async function reorderCategories(
  db: AppDb,
  actor: Editor,
  input: { ids?: unknown },
  now = new Date(),
): Promise<Changed<CategoryListItem[]>> {
  const ids = input.ids
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw invalid('Send ids: the category ids in order.')
  const rows = await db.select({ id: categories.id, sort: categories.sort, status: categories.status }).from(categories).all()
  const known = new Set(rows.map((r) => r.id))
  if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((x) => !known.has(x as string)))
    throw conflict('The categories changed while you were reordering. Reload and try again.')
  if (rows.length > 30) throw invalid('Too many categories to reorder at once.')
  const at = now.toISOString()
  const changed = (ids as string[])
    .map((cid, i) => ({ id: cid, sort: i + 1 }))
    .filter((r) => rows.find((x) => x.id === r.id)?.sort !== r.sort)
  if (changed.length === 0) return { result: await listCategories(db), purge: {} }
  await runBatch(db, [
    ...changed.map((r) => db.update(categories).set({ sort: r.sort, updatedAt: at, updatedBy: actor.id }).where(eq(categories.id, r.id))),
    audit(db, actor, 'category.update', { type: 'category', id: 'order' }, { order: rows.map((r) => r.id) }, { order: ids }, at),
  ])
  const anyPublic = rows.some((r) => r.status !== 'draft')
  return { result: await listCategories(db), purge: anyPublic ? purgeOf([tags.site, tags.programmes]) : {} }
}

export async function deleteCategory(db: AppDb, actor: Editor, id: string, now = new Date()): Promise<Changed<{ id: string }>> {
  const [current, inUse, menu] = await Promise.all([
    loadRow(db, id),
    db.select({ name: programmes.name }).from(programmes).where(eq(programmes.categoryId, id)).all(),
    db.select({ label: menuItems.label }).from(menuItems).where(eq(menuItems.categoryId, id)).all(),
  ])
  if (inUse.length)
    throw conflict(
      `This category still has ${inUse.length === 1 ? 'a programme' : 'programmes'} (${inUse.map((p) => p.name).join(', ')}). Move them to another category first.`,
    )
  if (menu.length)
    throw conflict(`The menu links to this category (${menu.map((m) => `“${m.label}”`).join(', ')}). Remove it from the menu first.`)
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(categories).where(eq(categories.id, id)),
    audit(
      db,
      actor,
      'category.delete',
      { type: 'category', id },
      { name: current.name, slug: current.slug, status: current.status },
      null,
      at,
    ),
  ])
  return { result: { id }, purge: purgeFor(current, null, true) }
}

/** Ids -> slugs, for purging the category pages of several programmes. */
export const categorySlugs = async (db: AppDb, ids: string[]) =>
  ids.length
    ? (await db.select({ slug: categories.slug }).from(categories).where(inArray(categories.id, ids)).all()).map((c) => c.slug)
    : []
