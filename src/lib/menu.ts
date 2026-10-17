import type { MenuItemKind } from '../server/db/schema/enums'
import { leagueFixturesRoute, leagueLadderRoute } from './wp-import/routes'

// The site menu: menu_items rows (joined with their page path / league slug) -> a two-level tree with hrefs, plus
// which top-level item is "active" for the current path (the amber one).

export type MenuRow = {
  id: string
  parentId: string | null
  label: string
  kind: MenuItemKind
  url: string | null
  sort: number
  /** pages.path when the item's page is published, else null. */
  pagePath: string | null
  /** leagues.slug for league items. */
  leagueSlug: string | null
}

export type MenuItem = { id: string; label: string; href: string | null; external: boolean; children: MenuItem[] }

export function itemHref(r: MenuRow): string | null {
  switch (r.kind) {
    case 'page':
      return r.pagePath
    case 'url':
      return r.url || null
    case 'league_ladder':
      return r.leagueSlug ? leagueLadderRoute(r.leagueSlug) : null
    case 'league_fixtures':
      return r.leagueSlug ? leagueFixturesRoute(r.leagueSlug) : null
    // Phase 6 kinds (docs/data-model-phase6.md "Menu"); not rendered until the menu work lands, so they're dropped.
    case 'category':
    case 'programme':
      return null
  }
}

const isExternal = (href: string | null) => !!href && /^https?:\/\//i.test(href)

/**
 * Builds the tree. Items whose target is gone (an unpublished page, a deleted league) are dropped; a heading with no
 * link of its own is kept only while it has children.
 */
export function buildMenu(rows: MenuRow[]): MenuItem[] {
  const sorted = rows.toSorted((a, b) => a.sort - b.sort || a.label.localeCompare(b.label))
  const node = (r: MenuRow): MenuItem => {
    const href = itemHref(r)
    return { id: r.id, label: r.label, href, external: isExternal(href), children: [] }
  }
  const linkable = (r: MenuRow) => r.kind === 'url' || itemHref(r) !== null
  const top = sorted.filter((r) => r.parentId === null && linkable(r)).map(node)
  const byId = new Map(top.map((n) => [n.id, n]))
  for (const r of sorted) {
    if (r.parentId === null) continue
    const parent = byId.get(r.parentId)
    if (parent && itemHref(r) !== null) parent.children.push(node(r))
  }
  return top.filter((n) => n.href !== null || n.children.length > 0)
}

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
