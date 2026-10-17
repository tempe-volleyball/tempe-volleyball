import { and, asc, inArray, ne } from 'drizzle-orm'
import { tags } from '../cache'
import { runBatch, type AppDb } from '../db'
import { categories, menuItems, pages, programmes } from '../db/schema'
import { buildMenuTree, checkMenu, type MenuCategory, type MenuNode, type MenuProgramme, type MenuRow } from '../../lib/content/menu'
import { atLeast, type UserRole } from '../../lib/roles'
import { HttpError } from '../http'
import { audit, invalid, type Changed, type Editor } from './common'

// The menu is saved whole: the admin sends the tree, and one batch replaces every menu_items row (plus any
// "show in menus" switches changed on programmes from the menu editor), with its audit row.

export const menuRowColumns = {
  id: menuItems.id,
  parentId: menuItems.parentId,
  label: menuItems.label,
  kind: menuItems.kind,
  pageId: menuItems.pageId,
  leagueId: menuItems.leagueId,
  categoryId: menuItems.categoryId,
  url: menuItems.url,
  sort: menuItems.sort,
  placement: menuItems.placement,
  hidden: menuItems.hidden,
}

/** What the menu needs of every programme (public and admin). */
export const menuProgrammeColumns = {
  id: programmes.id,
  kind: programmes.kind,
  name: programmes.name,
  code: programmes.code,
  slug: programmes.slug,
  status: programmes.status,
  menuVisible: programmes.menuVisible,
  categoryId: programmes.categoryId,
  sort: programmes.sort,
}

export const menuCategoryColumns = { id: categories.id, name: categories.name, slug: categories.slug, status: categories.status }

export type MenuChoices = {
  pages: { id: string; title: string; path: string; status: string }[]
  /** Leagues only (kind 'league'), for the old ladder/fixtures items. */
  leagues: { id: string; code: string; name: string; slug: string }[]
  /** Every programme, any kind and status, in category order. */
  programmes: MenuProgramme[]
  categories: (MenuCategory & { sort: number })[]
}

async function choices(db: AppDb): Promise<MenuChoices> {
  const [p, progs, cats] = (await runBatch(db, [
    db.select({ id: pages.id, title: pages.title, path: pages.path, status: pages.status }).from(pages).orderBy(pages.path),
    db.select(menuProgrammeColumns).from(programmes).orderBy(asc(programmes.sort), asc(programmes.name)),
    db
      .select({ ...menuCategoryColumns, sort: categories.sort })
      .from(categories)
      .orderBy(asc(categories.sort), asc(categories.name)),
  ])) as unknown as [MenuChoices['pages'], MenuProgramme[], MenuChoices['categories']]
  const leagues = progs.filter((x) => x.kind === 'league').map(({ id, code, name, slug }) => ({ id, code, name, slug }))
  return { pages: p, leagues, programmes: progs, categories: cats }
}

/**
 * The menu as a tree (admin view: every item, unpublished pages and hidden items included, category items NOT
 * expanded; the editor previews the automatic links itself from `programmes`) plus what items can point at.
 */
export async function getMenu(db: AppDb): Promise<{ tree: MenuNode[] } & MenuChoices> {
  const [rows, c] = await Promise.all([db.select(menuRowColumns).from(menuItems).all(), choices(db)])
  const pagePath = new Map(c.pages.map((p) => [p.id, p.path]))
  const tree = buildMenuTree(rows as MenuRow[], {
    pagePath: (id) => pagePath.get(id) ?? null,
    programmes: c.programmes,
    categories: c.categories,
  })
  return { tree, ...c }
}

const chunks = <T>(list: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** At most 100 bound parameters per statement: 12 columns x 6 rows (updated_by included; timestamps are SQL defaults). */
const ROWS_PER_INSERT = 6

/** `{ programmeId: shownInMenus }` from the menu editor's "show in menu" switches. */
function parseVisibility(v: unknown, known: Map<string, MenuProgramme>): Map<string, boolean> {
  const out = new Map<string, boolean>()
  if (v === undefined || v === null) return out
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid('The menu is malformed.')
  const entries = Object.entries(v as Record<string, unknown>)
  if (entries.length > 500) throw invalid('The menu is malformed.')
  for (const [id, shown] of entries) {
    if (typeof shown !== 'boolean') throw invalid('The menu is malformed.')
    const p = known.get(id)
    if (!p) throw invalid('One of those programmes no longer exists. Reload the menu.')
    if (p.menuVisible !== shown) out.set(id, shown)
  }
  return out
}

/**
 * Replaces the whole menu, and applies `programmeVisibility` ({ id: boolean }, leagues.menu_visible) for programmes
 * hidden or shown from the editor's dropdown previews (admin+). Audited as menu.update (before/after item counts, labels and
 * the visibility changes).
 */
export async function saveMenu(
  db: AppDb,
  actor: Editor & { role?: UserRole },
  input: unknown,
  now = new Date(),
  programmeVisibility?: unknown,
): Promise<Changed<{ items: number }>> {
  const [existing, p, progs, cats] = (await runBatch(db, [
    db.select(menuRowColumns).from(menuItems),
    db.select({ id: pages.id }).from(pages),
    db.select(menuProgrammeColumns).from(programmes),
    db.select({ id: categories.id }).from(categories),
  ])) as unknown as [MenuRow[], { id: string }[], MenuProgramme[], { id: string }[]]
  const checked = checkMenu(input, {
    pageIds: new Set(p.map((x) => x.id)),
    leagueIds: new Set(progs.filter((x) => x.kind === 'league').map((x) => x.id)),
    programmeIds: new Set(progs.map((x) => x.id)),
    categoryIds: new Set(cats.map((x) => x.id)),
  })
  if (!checked.ok) throw invalid(checked.message)
  const visibility = parseVisibility(programmeVisibility, new Map(progs.map((x) => [x.id, x])))
  // "Show in menus" is a programme setting, and programme changes need admin (editors can still edit the menu).
  if (visibility.size && !(actor.role && atLeast(actor.role, 'admin')))
    throw new HttpError(403, 'forbidden', 'Only admins can hide or show programmes in the menu.')
  const rows = checked.rows
  const at = now.toISOString()
  const ids = (shown: boolean) => [...visibility].filter(([, v]) => v === shown).map(([id]) => id)
  const visibilityStatements = [true, false].flatMap((shown) =>
    chunks(ids(shown), 90).flatMap((chunk) =>
      chunk.length
        ? [
            // 90 ids per statement keeps it under 100 bound parameters.
            db
              .update(programmes)
              .set({ menuVisible: shown, updatedAt: at, updatedBy: actor.id })
              .where(and(inArray(programmes.id, chunk), ne(programmes.menuVisible, shown))),
          ]
        : [],
    ),
  )
  const name = new Map(progs.map((x) => [x.id, x.code]))
  // Parents come before children in checkMenu's output, so the self-reference is satisfied row by row.
  await runBatch(db, [
    db.delete(menuItems),
    ...chunks(rows, ROWS_PER_INSERT).map((chunk) => db.insert(menuItems).values(chunk.map((r) => ({ ...r, updatedBy: actor.id })))),
    ...visibilityStatements,
    audit(
      db,
      actor,
      'menu.update',
      { type: 'menu', id: 'main' },
      { items: existing.length, labels: existing.filter((r) => !r.parentId).map((r) => r.label) },
      {
        items: rows.length,
        labels: rows.filter((r) => !r.parentId).map((r) => r.label),
        ...(visibility.size ? { programmeVisibility: Object.fromEntries([...visibility].map(([id, v]) => [name.get(id) ?? id, v])) } : {}),
      },
      at,
    ),
  ])
  // Category pages list the menu-visible programmes too, so a visibility change purges them and every listing.
  return { result: { items: rows.length }, purge: { tags: [tags.site, ...(visibility.size ? [tags.programmes] : [])] } }
}
