// Moving items around the menu editor's two-level tree (src/admin/screens/Menu.tsx): by drag and drop between
// levels and by the "Move to" select. Pure, so it's tested without a browser.

export type Placement = 'before' | 'after'
export type TreeItem<T> = { key: string; placement: Placement; children: T[] }

export type MoveTarget = {
  /** The top-level item to move under, or null for the top level. */
  parent: string | null
  /** Insert before this sibling; missing or unknown = at the end. */
  before?: string | null
  /** Under a category: before or after its automatic programme links. */
  placement?: Placement | undefined
}

export type MoveResult<T> = { items: T[]; error?: string }

/**
 * Moves `key` to `to`. Menus have two levels, so an item with sub-items can only stay at the top level, and nothing
 * moves under itself. Returns the items unchanged (with a reason) when the move isn't possible.
 */
export function moveItem<T extends TreeItem<T>>(items: T[], key: string, to: MoveTarget): MoveResult<T> {
  let moving: T | undefined
  const without = items
    .filter((i) => {
      if (i.key === key) moving = i
      return i.key !== key
    })
    .map((i) => {
      const children = i.children.filter((c) => {
        if (c.key === key) moving = c
        return c.key !== key
      })
      return children.length === i.children.length ? i : { ...i, children }
    })
  if (!moving) return { items }
  const insert = (list: T[], item: T) => {
    const at = to.before ? list.findIndex((x) => x.key === to.before) : -1
    return at < 0 ? [...list, item] : [...list.slice(0, at), item, ...list.slice(at)]
  }
  if (to.parent === null) return { items: insert(without, moving) }
  if (to.parent === key) return { items }
  if (moving.children.length)
    return { items, error: 'An item with sub-items can’t go inside a dropdown (menus have two levels). Move its sub-items out first.' }
  if (!without.some((i) => i.key === to.parent)) return { items }
  const placed = to.placement ? { ...moving, placement: to.placement } : moving
  return { items: without.map((i) => (i.key === to.parent ? { ...i, children: insert(i.children, placed) } : i)) }
}

/** Where `key` is: its parent's key (null at the top level) and the item itself. */
export function locate<T extends TreeItem<T>>(items: T[], key: string): { parent: string | null; item: T } | null {
  for (const i of items) {
    if (i.key === key) return { parent: null, item: i }
    const c = i.children.find((x) => x.key === key)
    if (c) return { parent: i.key, item: c }
  }
  return null
}

/** Droppable ids for "into this dropdown" zones: `into:<parent key>` or `into:<parent key>:before|after`. */
export const intoId = (parent: string, placement?: Placement) => `into:${parent}${placement ? `:${placement}` : ''}`

export function parseIntoId(id: string): { parent: string; placement?: Placement } | null {
  const m = /^into:(.+?)(?::(before|after))?$/.exec(id)
  if (!m) return null
  return m[2] ? { parent: m[1]!, placement: m[2] as Placement } : { parent: m[1]! }
}
