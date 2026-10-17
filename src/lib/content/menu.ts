import { menuItemKinds, type MenuItemKind } from '../../server/db/schema/enums'
import { leagueFixturesRoute, leagueLadderRoute } from '../wp-import/routes'
import { safeHref } from './render'

// The site menu: two levels, saved as a whole. The admin sends the tree; checkMenu() validates it and flattens it
// into menu_items rows (parent_id + sort). buildMenuTree() turns stored rows back into the tree with real links,
// for the admin and the public header.

export { menuItemKinds, type MenuItemKind }

export type MenuInput = {
  id?: string
  label: string
  kind: MenuItemKind
  pageId?: string | null
  leagueId?: string | null
  url?: string | null
  children?: MenuInput[]
}

export type MenuRow = {
  id: string
  parentId: string | null
  label: string
  kind: MenuItemKind
  pageId: string | null
  leagueId: string | null
  url: string | null
  sort: number
}

/** total keeps a save within D1's per-request query limit (the rows go in 10 per statement). */
export const MENU_LIMITS = { topLevel: 20, children: 30, total: 120, label: 60 } as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type MenuCheck = { ok: true; rows: MenuRow[] } | { ok: false; message: string }

/**
 * Validates a menu tree and flattens it to rows. `known` lists the page and league ids that exist; `newId` makes
 * ids for new items (crypto.randomUUID in the Worker).
 */
export function checkMenu(
  input: unknown,
  known: { pageIds: ReadonlySet<string>; leagueIds: ReadonlySet<string> },
  newId: () => string = () => crypto.randomUUID(),
): MenuCheck {
  if (!Array.isArray(input)) return { ok: false, message: 'The menu is malformed.' }
  if (input.length > MENU_LIMITS.topLevel)
    return { ok: false, message: `The menu can have at most ${MENU_LIMITS.topLevel} top-level items.` }
  const rows: MenuRow[] = []
  const ids = new Set<string>()
  try {
    const walk = (items: unknown[], parentId: string | null, depth: number) => {
      items.forEach((raw, sort) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('The menu is malformed.')
        const item = raw as Record<string, unknown>
        const label = typeof item.label === 'string' ? item.label.trim().replace(/\s+/g, ' ') : ''
        const where = label ? `“${label}”` : `Item ${sort + 1}`
        if (!label) throw new Error(`${where} needs a label.`)
        if (label.length > MENU_LIMITS.label) throw new Error(`${where}: keep labels under ${MENU_LIMITS.label} characters.`)
        const kind = item.kind
        if (typeof kind !== 'string' || !(menuItemKinds as readonly string[]).includes(kind))
          throw new Error(`${where} has an unknown kind.`)
        // Phase 6 kinds exist in the schema but aren't handled here yet (category_id, placement).
        if (kind === 'category' || kind === 'programme') throw new Error(`${where}: that kind of menu item isn't supported yet.`)
        let id = typeof item.id === 'string' && UUID_RE.test(item.id) ? item.id.toLowerCase() : newId()
        if (ids.has(id)) id = newId()
        ids.add(id)

        const row: MenuRow = { id, parentId, label, kind: kind as MenuItemKind, pageId: null, leagueId: null, url: null, sort }
        if (kind === 'page') {
          if (typeof item.pageId !== 'string' || !known.pageIds.has(item.pageId)) throw new Error(`${where}: choose a page.`)
          row.pageId = item.pageId
        } else if (kind === 'url') {
          const url = typeof item.url === 'string' ? item.url.trim() : ''
          // No URL = a heading that only opens its sub-menu.
          if (url) {
            if (!safeHref(url)) throw new Error(`${where}: the link must start with https://, / or mailto:.`)
            row.url = url
          }
        } else {
          if (typeof item.leagueId !== 'string' || !known.leagueIds.has(item.leagueId)) throw new Error(`${where}: choose a league.`)
          row.leagueId = item.leagueId
        }
        rows.push(row)

        const kids = item.children
        if (kids !== undefined && kids !== null) {
          if (!Array.isArray(kids)) throw new Error('The menu is malformed.')
          if (kids.length && depth >= 1) throw new Error(`${where}: the menu has two levels, so a sub-item can't have its own items.`)
          if (kids.length > MENU_LIMITS.children) throw new Error(`${where} can have at most ${MENU_LIMITS.children} items.`)
          walk(kids, id, depth + 1)
        }
        if (rows.length > MENU_LIMITS.total) throw new Error(`The menu can have at most ${MENU_LIMITS.total} items.`)
      })
    }
    walk(input, null, 0)
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
  return { ok: true, rows }
}

export type MenuNode = MenuRow & { href: string | null; children: MenuNode[] }

/**
 * Rows -> tree, sorted, with each item's link (null for a heading, an unpublished page or an unknown league). With
 * `publicOnly`, items without a link are dropped unless they still have children (then they show as a heading).
 */
export function buildMenuTree(
  rows: readonly MenuRow[],
  lookups: { pagePath: (pageId: string) => string | null; leagueSlug: (leagueId: string) => string | null },
  opts: { publicOnly?: boolean } = {},
): MenuNode[] {
  const href = (r: MenuRow): string | null => {
    if (r.kind === 'page') return r.pageId ? lookups.pagePath(r.pageId) : null
    if (r.kind === 'url') return r.url
    const slug = r.leagueId ? lookups.leagueSlug(r.leagueId) : null
    if (!slug) return null
    return r.kind === 'league_ladder' ? leagueLadderRoute(slug) : leagueFixturesRoute(slug)
  }
  const bySort = (a: MenuRow, b: MenuRow) => a.sort - b.sort || a.label.localeCompare(b.label)
  const top = rows.filter((r) => !r.parentId).toSorted(bySort)
  const kidsOf = new Map<string, MenuRow[]>()
  for (const r of rows) if (r.parentId) kidsOf.set(r.parentId, [...(kidsOf.get(r.parentId) ?? []), r])

  const keep = (n: MenuNode) => !opts.publicOnly || n.href !== null || n.children.length > 0
  return top
    .map((r): MenuNode => {
      const children = (kidsOf.get(r.id) ?? [])
        .toSorted(bySort)
        .map((c): MenuNode => ({ ...c, href: href(c), children: [] }))
        .filter(keep)
      return { ...r, href: href(r), children }
    })
    .filter(keep)
}

/** The tree back to the admin's input shape. */
export const menuToInput = (tree: readonly MenuNode[]): MenuInput[] =>
  tree.map((n) => ({
    id: n.id,
    label: n.label,
    kind: n.kind,
    pageId: n.pageId,
    leagueId: n.leagueId,
    url: n.url,
    children: menuToInput(n.children),
  }))
