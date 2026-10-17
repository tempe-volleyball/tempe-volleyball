import { eq } from 'drizzle-orm'
import { tags } from '../cache'
import { runBatch, type AppDb } from '../db'
import { leagues, menuItems, pages } from '../db/schema'
import { buildMenuTree, checkMenu, type MenuNode, type MenuRow } from '../../lib/content/menu'
import { audit, invalid, type Changed, type Editor } from './common'

// The menu is saved whole: the admin sends the tree, and one batch replaces every menu_items row.

const rowColumns = {
  id: menuItems.id,
  parentId: menuItems.parentId,
  label: menuItems.label,
  kind: menuItems.kind,
  pageId: menuItems.pageId,
  leagueId: menuItems.leagueId,
  url: menuItems.url,
  sort: menuItems.sort,
}

export type MenuChoices = {
  pages: { id: string; title: string; path: string; status: string }[]
  leagues: { id: string; code: string; name: string; slug: string }[]
}

async function choices(db: AppDb): Promise<MenuChoices> {
  const [p, l] = await Promise.all([
    db.select({ id: pages.id, title: pages.title, path: pages.path, status: pages.status }).from(pages).orderBy(pages.path).all(),
    db
      .select({ id: leagues.id, code: leagues.code, name: leagues.name, slug: leagues.slug })
      .from(leagues)
      .where(eq(leagues.kind, 'league'))
      .orderBy(leagues.sort)
      .all(),
  ])
  return { pages: p, leagues: l }
}

/** The menu as a tree (admin view: every item, unpublished pages included) plus what items can point at. */
export async function getMenu(db: AppDb): Promise<{ tree: MenuNode[] } & MenuChoices> {
  const [rows, c] = await Promise.all([db.select(rowColumns).from(menuItems).all(), choices(db)])
  const pagePath = new Map(c.pages.map((p) => [p.id, p.path]))
  const slugs = new Map(c.leagues.map((l) => [l.id, l.slug]))
  const tree = buildMenuTree(rows as MenuRow[], { pagePath: (id) => pagePath.get(id) ?? null, leagueSlug: (id) => slugs.get(id) ?? null })
  return { tree, ...c }
}

const chunks = <T>(list: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** Replaces the whole menu. Audited as menu.update (before/after item counts and labels). */
export async function saveMenu(db: AppDb, actor: Editor, input: unknown, now = new Date()): Promise<Changed<{ items: number }>> {
  const [existing, p, l] = await Promise.all([
    db.select(rowColumns).from(menuItems).all(),
    db.select({ id: pages.id }).from(pages).all(),
    db.select({ id: leagues.id }).from(leagues).where(eq(leagues.kind, 'league')).all(),
  ])
  const checked = checkMenu(input, { pageIds: new Set(p.map((x) => x.id)), leagueIds: new Set(l.map((x) => x.id)) })
  if (!checked.ok) throw invalid(checked.message)
  const rows = checked.rows
  const at = now.toISOString()
  // Parents come before children in checkMenu's output, so the self-reference is satisfied row by row.
  await runBatch(db, [
    db.delete(menuItems),
    // D1 allows 100 bound parameters per statement: 9 columns x 10 rows.
    ...chunks(rows, 10).map((chunk) => db.insert(menuItems).values(chunk.map((r) => ({ ...r, updatedBy: actor.id })))),
    audit(
      db,
      actor,
      'menu.update',
      { type: 'menu', id: 'main' },
      { items: existing.length, labels: existing.filter((r) => !r.parentId).map((r) => r.label) },
      { items: rows.length, labels: rows.filter((r) => !r.parentId).map((r) => r.label) },
      at,
    ),
  ])
  return { result: { items: rows.length }, purge: { tags: [tags.site] } }
}
