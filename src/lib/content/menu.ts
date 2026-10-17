import {
  menuItemKinds,
  menuPlacements,
  type MenuItemKind,
  type MenuPlacement,
  type ProgrammeKind,
  type ProgrammeStatus,
} from '../../server/db/schema/enums'
import { categoryPath, isListedStatus, programmePath } from '../programmes'
import { leagueFixturesRoute, leagueLadderRoute } from '../wp-import/routes'
import { safeHref } from './render'

// The site menu (docs/admin.md §3.5): two levels, saved as a whole. The admin sends the tree; checkMenu() validates
// it and flattens it into menu_items rows (parent_id + sort). buildMenuTree() turns stored rows back into the tree
// with real links, for the admin and the public header, and publicMenu() is what the header renders.
//
// Kinds:
//  - page: a content page (shown publicly while it's published).
//  - url: a link, or with no URL a heading that only opens its sub-menu.
//  - category: the category's landing page; at the top level it EXPANDS on its own into a dropdown of the landing page
//    and one link per active, menu-visible programme in it (category order: programme sort, then name). Its
//    hand-made children are pinned `before` or `after` those automatic links. A hand-made `programme` child for a
//    programme the dropdown would list anyway replaces that automatic link (so it can be renamed or moved).
//  - programme: one programme's page (any kind), shown while the programme is active.
//  - league_ladder / league_fixtures: the old SportsPress-style links (/leagues/<slug>#ladder, #fixtures). They still
//    resolve, but the editor no longer offers them: one link per league, and the league page has the tabs.
// `hidden` items stay in the admin but never show on the site (nor do their children).

export { menuItemKinds, menuPlacements, type MenuItemKind, type MenuPlacement }

/** Kinds the editor offers for new items (the league_* kinds are kept for old items only). */
export const EDITABLE_MENU_KINDS = ['page', 'url', 'category', 'programme'] as const satisfies readonly MenuItemKind[]

export type MenuInput = {
  id?: string
  label: string
  kind: MenuItemKind
  pageId?: string | null
  leagueId?: string | null
  categoryId?: string | null
  url?: string | null
  /** Children of a category item: before or after the automatic programme links (null = after). */
  placement?: MenuPlacement | null
  hidden?: boolean
  children?: MenuInput[]
}

export type MenuRow = {
  id: string
  parentId: string | null
  label: string
  kind: MenuItemKind
  pageId: string | null
  leagueId: string | null
  categoryId: string | null
  url: string | null
  sort: number
  placement: MenuPlacement | null
  hidden: boolean
}

/** total keeps a save within D1's per-request query limit (the rows go in 6 per statement, 12 columns each). */
export const MENU_LIMITS = { topLevel: 20, children: 30, total: 120, label: 60 } as const

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type MenuCheck = { ok: true; rows: MenuRow[] } | { ok: false; message: string }

export type MenuKnown = {
  pageIds: ReadonlySet<string>
  /** Leagues (kind 'league'), for league_ladder / league_fixtures. */
  leagueIds: ReadonlySet<string>
  /** Every programme, any kind, for `programme` items. */
  programmeIds: ReadonlySet<string>
  categoryIds: ReadonlySet<string>
}

/**
 * Validates a menu tree and flattens it to rows. `known` lists the ids that exist; `newId` makes ids for new items
 * (crypto.randomUUID in the Worker).
 */
export function checkMenu(input: unknown, known: MenuKnown, newId: () => string = () => crypto.randomUUID()): MenuCheck {
  if (!Array.isArray(input)) return { ok: false, message: 'The menu is malformed.' }
  if (input.length > MENU_LIMITS.topLevel)
    return { ok: false, message: `The menu can have at most ${MENU_LIMITS.topLevel} top-level items.` }
  const rows: MenuRow[] = []
  const ids = new Set<string>()
  try {
    const walk = (items: unknown[], parent: MenuRow | null, depth: number) => {
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
        let id = typeof item.id === 'string' && UUID_RE.test(item.id) ? item.id.toLowerCase() : newId()
        if (ids.has(id)) id = newId()
        ids.add(id)

        const placement = item.placement === undefined || item.placement === null ? null : item.placement
        if (placement !== null && !(menuPlacements as readonly unknown[]).includes(placement))
          throw new Error(`${where}: placement must be before or after.`)
        const row: MenuRow = {
          id,
          parentId: parent?.id ?? null,
          label,
          kind: kind as MenuItemKind,
          pageId: null,
          leagueId: null,
          categoryId: null,
          url: null,
          sort,
          // Only meaningful under a category item; anywhere else it's dropped rather than refused.
          placement: parent?.kind === 'category' ? (placement as MenuPlacement | null) : null,
          hidden: item.hidden === true,
        }
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
        } else if (kind === 'category') {
          if (typeof item.categoryId !== 'string' || !known.categoryIds.has(item.categoryId))
            throw new Error(`${where}: choose a category.`)
          row.categoryId = item.categoryId
        } else if (kind === 'programme') {
          if (typeof item.leagueId !== 'string' || !known.programmeIds.has(item.leagueId)) throw new Error(`${where}: choose a programme.`)
          row.leagueId = item.leagueId
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
          walk(kids, row, depth + 1)
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

// ── Building the tree ─────────────────────────────────────────────────────────

/** What the menu needs to know about a programme. */
export type MenuProgramme = {
  id: string
  kind: ProgrammeKind
  name: string
  code: string
  slug: string
  status: ProgrammeStatus
  menuVisible: boolean
  categoryId: string | null
  sort: number
}

export type MenuCategory = { id: string; name: string; slug: string; status: ProgrammeStatus }

export type MenuData = {
  /** Page id -> path. The public menu passes only published pages. */
  pagePath: (pageId: string) => string | null
  programmes: readonly MenuProgramme[]
  categories: readonly MenuCategory[]
}

export type MenuNode = MenuRow & {
  href: string | null
  children: MenuNode[]
  /** An automatic link from a category item (never saved). */
  auto?: boolean
}

const bySort = (a: { sort: number; label: string }, b: { sort: number; label: string }) => a.sort - b.sort || a.label.localeCompare(b.label)

const byProgrammeOrder = (a: MenuProgramme, b: MenuProgramme) => a.sort - b.sort || a.name.localeCompare(b.name)

/** The programmes a category dropdown lists on its own: active, menu-visible, in category order. */
export function autoProgrammes(categoryId: string, programmes: readonly MenuProgramme[]): MenuProgramme[] {
  return programmes.filter((p) => p.categoryId === categoryId && isListedStatus(p.status) && p.menuVisible).toSorted(byProgrammeOrder)
}

/**
 * Rows -> tree, sorted, with each item's link (null for a heading, an unpublished page, a missing or unlisted
 * programme or category). Options:
 *  - publicOnly: drop hidden items and items without a link (unless they still have children, as a heading), and
 *    programmes/categories that aren't active.
 *  - expand: fill top-level category items with their automatic programme links (marked `auto`).
 */
export function buildMenuTree(rows: readonly MenuRow[], data: MenuData, opts: { publicOnly?: boolean; expand?: boolean } = {}): MenuNode[] {
  const programmes = new Map(data.programmes.map((p) => [p.id, p]))
  const categories = new Map(data.categories.map((c) => [c.id, c]))
  const listed = (status: ProgrammeStatus) => !opts.publicOnly || isListedStatus(status)
  const href = (r: MenuRow): string | null => {
    switch (r.kind) {
      case 'page':
        return r.pageId ? data.pagePath(r.pageId) : null
      case 'url':
        return r.url
      case 'category': {
        const c = r.categoryId ? categories.get(r.categoryId) : undefined
        return c && listed(c.status) ? categoryPath(c.slug) : null
      }
      case 'programme': {
        const p = r.leagueId ? programmes.get(r.leagueId) : undefined
        return p && listed(p.status) ? programmePath(p.kind, p.slug) : null
      }
      case 'league_ladder':
      case 'league_fixtures': {
        const p = r.leagueId ? programmes.get(r.leagueId) : undefined
        if (!p || p.kind !== 'league' || !listed(p.status)) return null
        return r.kind === 'league_ladder' ? leagueLadderRoute(p.slug) : leagueFixturesRoute(p.slug)
      }
    }
  }
  const visible = (r: MenuRow) => !opts.publicOnly || !r.hidden
  const keep = (n: MenuNode) => !opts.publicOnly || n.href !== null || n.children.length > 0
  const kidsOf = new Map<string, MenuRow[]>()
  for (const r of rows) if (r.parentId) kidsOf.set(r.parentId, [...(kidsOf.get(r.parentId) ?? []), r])
  const leaf = (r: MenuRow): MenuNode => ({ ...r, href: href(r), children: [] })

  return rows
    .filter((r) => !r.parentId && visible(r))
    .toSorted(bySort)
    .map((r): MenuNode => {
      const hand = (kidsOf.get(r.id) ?? []).filter(visible).toSorted(bySort).map(leaf)
      let children = hand
      if (opts.expand && r.kind === 'category' && r.categoryId && href(r) !== null) {
        // A hand-made programme child stands in for the automatic link to the same programme.
        const pinned = new Set(hand.filter((c) => c.kind === 'programme').map((c) => c.leagueId))
        const auto = autoProgrammes(r.categoryId, data.programmes)
          .filter((p) => !pinned.has(p.id))
          .map((p, i): MenuNode => ({
            id: `auto:${r.id}:${p.id}`,
            parentId: r.id,
            label: p.name,
            kind: 'programme',
            pageId: null,
            leagueId: p.id,
            categoryId: null,
            url: null,
            sort: i,
            placement: null,
            hidden: false,
            href: programmePath(p.kind, p.slug),
            children: [],
            auto: true,
          }))
        children = [...hand.filter((c) => c.placement === 'before'), ...auto, ...hand.filter((c) => c.placement !== 'before')]
      }
      return { ...r, href: href(r), children: children.filter(keep) }
    })
    .filter(keep)
}

/** The tree back to the admin's input shape (automatic links are left out: they're never saved). */
export const menuToInput = (tree: readonly MenuNode[]): MenuInput[] =>
  tree
    .filter((n) => !n.auto)
    .map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      pageId: n.pageId,
      leagueId: n.leagueId,
      categoryId: n.categoryId,
      url: n.url,
      placement: n.placement,
      hidden: n.hidden,
      children: menuToInput(n.children),
    }))

// ── The public menu ───────────────────────────────────────────────────────────

/** What the header renders. */
export type MenuItem = { id: string; label: string; href: string | null; external: boolean; children: MenuItem[] }

const isExternal = (href: string | null) => !!href && /^https?:\/\//i.test(href)

const toItem = (n: MenuNode): MenuItem => ({
  id: n.id,
  label: n.label,
  href: n.href,
  external: isExternal(n.href),
  children: n.children.map(toItem),
})

/**
 * The public menu: hidden items, unpublished pages and programmes or categories that aren't active are dropped,
 * category items are expanded, and a heading with no link of its own is kept only while it has children.
 */
export const publicMenu = (rows: readonly MenuRow[], data: MenuData): MenuItem[] =>
  buildMenuTree(rows, data, { publicOnly: true, expand: true }).map(toItem)

const pathOf = (href: string) => href.replace(/[?#].*$/, '').replace(/\/+$/, '') || '/'

/** Whether a menu item (or one of its children) points at the current path. */
export function isActive(item: MenuItem, pathname: string): boolean {
  const current = pathOf(pathname)
  const matches = (href: string | null) => {
    if (!href || isExternal(href)) return false
    const p = pathOf(href)
    return p === '/' ? current === '/' : current === p || current.startsWith(`${p}/`)
  }
  return matches(item.href) || item.children.some((c) => matches(c.href))
}
