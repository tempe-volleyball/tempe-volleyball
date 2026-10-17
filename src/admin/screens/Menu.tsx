import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  autoProgrammes,
  type MenuCategory,
  type MenuInput,
  type MenuItemKind,
  type MenuNode,
  type MenuPlacement,
  type MenuProgramme,
} from '../../lib/content/menu'
import { atLeast } from '../../lib/roles'
import { programmePath } from '../../lib/programmes'
import { api, type Me, type PurgeResult } from '../api'
import { Button, Card, Notice, errorMessage, purgeNote } from '../ui'
import { useUnsavedWarning } from './Pages'

// The menu editor (docs/admin.md §3.5): two levels, drag (or keyboard) to reorder within a level, "Move to" to
// change level. A category item fills its dropdown on its own (the landing page, then its active programmes); the
// editor previews those automatic links under it, with a "show in menu" switch per programme (admins), and hand-made
// sub-items can be pinned before or after them. Saved as a whole with one PUT.

type Choices = {
  pages: { id: string; title: string; path: string; status: string }[]
  leagues: { id: string; code: string; name: string }[]
  programmes: MenuProgramme[]
  categories: (MenuCategory & { sort: number })[]
}
type Item = {
  key: string
  id?: string
  label: string
  kind: MenuItemKind
  pageId: string
  leagueId: string
  categoryId: string
  url: string
  placement: MenuPlacement
  hidden: boolean
  children: Item[]
}

const KINDS: Record<MenuItemKind, string> = {
  page: 'Page',
  url: 'Link or heading',
  category: 'Category (fills itself)',
  programme: 'Programme',
  league_ladder: 'League ladder (old)',
  league_fixtures: 'League fixtures (old)',
}
/** Offered for new items; the old ladder/fixtures kinds show only on items that already use them. */
const NEW_KINDS: MenuItemKind[] = ['page', 'url', 'category', 'programme']

const KIND_GROUPS: [MenuProgramme['kind'], string][] = [
  ['league', 'Leagues'],
  ['training', 'Training'],
  ['development', 'Development'],
  ['event', 'Events'],
]

let seq = 0
const key = () => `k${++seq}`

const fromTree = (nodes: MenuNode[]): Item[] =>
  nodes
    .filter((n) => !n.auto)
    .map((n) => ({
      key: key(),
      id: n.id,
      label: n.label,
      kind: n.kind,
      pageId: n.pageId ?? '',
      leagueId: n.leagueId ?? '',
      categoryId: n.categoryId ?? '',
      url: n.url ?? '',
      placement: n.placement ?? 'after',
      hidden: n.hidden,
      children: fromTree(n.children),
    }))

const usesLeague = (k: MenuItemKind) => k === 'programme' || k === 'league_ladder' || k === 'league_fixtures'

const toInput = (items: Item[], parent?: Item): MenuInput[] =>
  items.map((i) => ({
    id: i.id,
    label: i.label,
    kind: i.kind,
    pageId: i.kind === 'page' ? i.pageId : null,
    leagueId: usesLeague(i.kind) ? i.leagueId : null,
    categoryId: i.kind === 'category' ? i.categoryId : null,
    url: i.kind === 'url' ? i.url : null,
    placement: parent?.kind === 'category' ? i.placement : null,
    hidden: i.hidden,
    children: toInput(i.children, i),
  }))

const blank = (): Item => ({
  key: key(),
  label: '',
  kind: 'page',
  pageId: '',
  leagueId: '',
  categoryId: '',
  url: '',
  placement: 'after',
  hidden: false,
  children: [],
})

function Sortable({ id, children }: { id: string; children: (handle: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const handle = (
    <button
      type="button"
      className="cursor-grab touch-none px-1 text-lg leading-none text-black/50"
      aria-label="Drag to reorder"
      {...attributes}
      {...listeners}
    >
      ⠿
    </button>
  )
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'relative z-10 opacity-80' : ''}
    >
      {children(handle)}
    </li>
  )
}

const input = 'rounded border border-black/20 bg-white px-2 py-1 text-sm'

function ItemRow({
  item,
  choices,
  handle,
  parents,
  parent,
  onChange,
  onRemove,
  onMove,
}: {
  item: Item
  choices: Choices
  handle: ReactNode
  parents: Item[]
  parent: Item | null
  onChange: (patch: Partial<Item>) => void
  onRemove: () => void
  onMove: (to: string | null) => void
}) {
  const kinds = NEW_KINDS.includes(item.kind) ? NEW_KINDS : [...NEW_KINDS, item.kind]
  const label = (patch: Partial<Item>, name: string | undefined) =>
    // Fill an empty label from what was chosen, so a new category or programme item needs one pick.
    onChange(item.label || !name ? patch : { ...patch, label: name })
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded border border-black/10 bg-white p-2 ${item.hidden ? 'opacity-60' : ''}`}>
      {handle}
      <input
        className={`${input} w-44`}
        aria-label="Label"
        placeholder="Label"
        value={item.label}
        maxLength={60}
        onChange={(e) => onChange({ label: e.target.value })}
      />
      <select className={input} aria-label="Kind" value={item.kind} onChange={(e) => onChange({ kind: e.target.value as MenuItemKind })}>
        {kinds.map((k) => (
          <option key={k} value={k}>
            {KINDS[k]}
          </option>
        ))}
      </select>
      {item.kind === 'page' && (
        <select
          className={`${input} max-w-64`}
          aria-label="Page"
          value={item.pageId}
          onChange={(e) => onChange({ pageId: e.target.value })}
        >
          <option value="">Choose a page…</option>
          {choices.pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title} ({p.path}){p.status !== 'published' ? ` · ${p.status}` : ''}
            </option>
          ))}
        </select>
      )}
      {item.kind === 'url' && (
        <input
          className={`${input} w-64`}
          aria-label="Link"
          placeholder={item.children.length ? 'Optional: heading only' : 'https://… or /path'}
          value={item.url}
          onChange={(e) => onChange({ url: e.target.value })}
        />
      )}
      {item.kind === 'category' && (
        <select
          className={input}
          aria-label="Category"
          value={item.categoryId}
          onChange={(e) => label({ categoryId: e.target.value }, choices.categories.find((c) => c.id === e.target.value)?.name)}
        >
          <option value="">Choose a category…</option>
          {choices.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.status !== 'active' ? ` · ${c.status}` : ''}
            </option>
          ))}
        </select>
      )}
      {item.kind === 'programme' && (
        <select
          className={`${input} max-w-64`}
          aria-label="Programme"
          value={item.leagueId}
          onChange={(e) => label({ leagueId: e.target.value }, choices.programmes.find((p) => p.id === e.target.value)?.name)}
        >
          <option value="">Choose a programme…</option>
          {KIND_GROUPS.map(([k, name]) => (
            <optgroup key={k} label={name}>
              {choices.programmes
                .filter((p) => p.kind === k)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                    {p.status !== 'active' ? ` · ${p.status}` : ''}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      )}
      {(item.kind === 'league_ladder' || item.kind === 'league_fixtures') && (
        <select className={input} aria-label="League" value={item.leagueId} onChange={(e) => onChange({ leagueId: e.target.value })}>
          <option value="">Choose a league…</option>
          {choices.leagues.map((l) => (
            <option key={l.id} value={l.id}>
              {l.code} · {l.name}
            </option>
          ))}
        </select>
      )}
      {parent?.kind === 'category' && (
        <select
          className={input}
          aria-label="Position"
          value={item.placement}
          onChange={(e) => onChange({ placement: e.target.value as MenuPlacement })}
        >
          <option value="before">Before the programmes</option>
          <option value="after">After the programmes</option>
        </select>
      )}
      <span className="ml-auto flex items-center gap-2">
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" className="accent-brand" checked={item.hidden} onChange={(e) => onChange({ hidden: e.target.checked })} />
          Hide
        </label>
        {item.children.length === 0 && (
          <select className={input} aria-label="Move to" value={parent?.key ?? ''} onChange={(e) => onMove(e.target.value || null)}>
            <option value="">Top level</option>
            {parents
              .filter((p) => p.key !== item.key)
              .map((p) => (
                <option key={p.key} value={p.key}>
                  Under {p.label || '(no label)'}
                </option>
              ))}
          </select>
        )}
        <button type="button" className="px-1 text-sm text-red-700 underline" onClick={onRemove}>
          Remove
        </button>
      </span>
    </div>
  )
}

/** The automatic links a category item adds, with "show in menu" switches (programme setting, admins only). */
function AutoLinks({
  item,
  choices,
  visibility,
  canToggle,
  onToggle,
}: {
  item: Item
  choices: Choices
  visibility: Record<string, boolean>
  canToggle: boolean
  onToggle: (id: string, shown: boolean) => void
}) {
  const category = choices.categories.find((c) => c.id === item.categoryId)
  if (!category) return null
  const programmes = choices.programmes.map((p) => (p.id in visibility ? { ...p, menuVisible: visibility[p.id]! } : p))
  const replaced = new Set(item.children.filter((c) => c.kind === 'programme').map((c) => c.leagueId))
  const shown = new Set(autoProgrammes(category.id, programmes).map((p) => p.id))
  // Every active programme in the category, so a hidden one can be shown again.
  const candidates = autoProgrammes(
    category.id,
    programmes.map((p) => ({ ...p, menuVisible: true })),
  )
  return (
    <div className="rounded border border-dashed border-black/20 bg-black/[0.02] p-2 text-sm">
      <p className="mb-1 text-xs text-black/60">
        Automatic: <span className="font-mono">/{category.slug}</span> first, then each active programme in {category.name}
        {category.status !== 'active' ? ` (the category is ${category.status}, so this dropdown is hidden on the site)` : ''}.
      </p>
      {candidates.length === 0 ? (
        <p className="text-xs text-black/60">No active programmes in this category yet.</p>
      ) : (
        <ul className="space-y-1">
          {candidates.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={shown.has(p.id)}
                  disabled={!canToggle}
                  onChange={(e) => onToggle(p.id, e.target.checked)}
                />
                <span className={shown.has(p.id) ? '' : 'line-through opacity-60'}>{p.name}</span>
              </label>
              <span className="font-mono text-xs text-black/50">{programmePath(p.kind, p.slug)}</span>
              {replaced.has(p.id) && <span className="text-xs text-black/60">(replaced by your own item below)</span>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-black/60">
        {canToggle
          ? 'Untick to hide a programme from every menu without retiring it. To rename or move one, add a Programme sub-item for it.'
          : 'Admins can hide programmes from the menu. To rename or move one, add a Programme sub-item for it.'}
      </p>
    </div>
  )
}

export function Menu({ me }: { me: Me }) {
  const [items, setItems] = useState<Item[] | null>(null)
  const [choices, setChoices] = useState<Choices>({ pages: [], leagues: [], programmes: [], categories: [] })
  const [visibility, setVisibility] = useState<Record<string, boolean>>({})
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const canToggle = atLeast(me.user.role, 'admin')
  useUnsavedWarning(dirty)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const apply = useCallback((r: { tree: MenuNode[] } & Choices) => {
    setItems(fromTree(r.tree))
    setChoices({ pages: r.pages, leagues: r.leagues, programmes: r.programmes, categories: r.categories })
    setVisibility({})
    setDirty(false)
  }, [])

  useEffect(() => {
    api<{ tree: MenuNode[] } & Choices>('/api/admin/menu')
      .then(apply)
      .catch((e) => setError(errorMessage(e)))
  }, [apply])

  const update = (fn: (cur: Item[]) => Item[]) => {
    setItems((cur) => (cur ? fn(cur) : cur))
    setDirty(true)
    setMessage(null)
  }

  const patch = (k: string, p: Partial<Item>) =>
    update((cur) =>
      cur.map((i) => (i.key === k ? { ...i, ...p } : { ...i, children: i.children.map((c) => (c.key === k ? { ...c, ...p } : c)) })),
    )

  const remove = (k: string) => {
    const item = items?.find((i) => i.key === k)
    if (item?.children.length && !window.confirm(`Remove “${item.label}” and its ${item.children.length} sub-items?`)) return
    update((cur) => cur.filter((i) => i.key !== k).map((i) => ({ ...i, children: i.children.filter((c) => c.key !== k) })))
  }

  const move = (k: string, to: string | null) =>
    update((cur) => {
      let moving: Item | undefined
      const without = cur
        .filter((i) => {
          if (i.key === k) moving = i
          return i.key !== k
        })
        .map((i) => ({
          ...i,
          children: i.children.filter((c) => {
            if (c.key === k) moving = c
            return c.key !== k
          }),
        }))
      if (!moving) return cur
      if (to === null) return [...without, moving]
      return without.map((i) => (i.key === to ? { ...i, children: [...i.children, moving!] } : i))
    })

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    update((cur) => {
      const a = String(active.id)
      const o = String(over.id)
      const ti = cur.findIndex((i) => i.key === a)
      const to = cur.findIndex((i) => i.key === o)
      if (ti >= 0 && to >= 0) return arrayMove(cur, ti, to)
      return cur.map((p) => {
        const ci = p.children.findIndex((c) => c.key === a)
        const co = p.children.findIndex((c) => c.key === o)
        return ci >= 0 && co >= 0 ? { ...p, children: arrayMove(p.children, ci, co) } : p
      })
    })
  }

  const toggleProgramme = (id: string, shown: boolean) => {
    const original = choices.programmes.find((p) => p.id === id)?.menuVisible
    setVisibility((v) => {
      const next = { ...v }
      if (original === shown) delete next[id]
      else next[id] = shown
      return next
    })
    setDirty(true)
    setMessage(null)
  }

  const save = async () => {
    if (!items) return
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ tree: MenuNode[]; cache: PurgeResult } & Choices>('/api/admin/menu', {
        method: 'PUT',
        body: { items: toInput(items), ...(Object.keys(visibility).length ? { programmeVisibility: visibility } : {}) },
      })
      apply(r)
      setMessage(`Menu saved.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!items) return error ? <Notice kind="error">{error}</Notice> : <p className="text-sm text-black/60">Loading…</p>

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Menu</h1>
        <div className="flex items-center gap-3">
          {dirty && <span className="text-sm text-black/60">Unsaved changes</span>}
          <Button busy={busy} disabled={!dirty} onClick={() => void save()}>
            Save menu
          </Button>
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      <Card>
        <p className="mb-4 text-sm text-black/70">
          Drag ⠿ to reorder (or focus it and use the arrow keys). Use “Move to” to put an item under another. A Category item fills its
          dropdown on its own: its landing page, then each active programme in it, so new programmes join and retired ones leave without
          editing the menu. Pin your own links before or after them. Draft pages, hidden items and programmes that aren’t active stay off
          the public menu.
        </p>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
            <ul className="space-y-3">
              {items.map((item) => {
                const before = item.children.filter((c) => item.kind === 'category' && c.placement === 'before')
                const after = item.children.filter((c) => !before.includes(c))
                const childList = (list: Item[]) => (
                  <SortableContext items={list.map((c) => c.key)} strategy={verticalListSortingStrategy}>
                    <ul className="space-y-2">
                      {list.map((child) => (
                        <Sortable key={child.key} id={child.key}>
                          {(h) => (
                            <ItemRow
                              item={child}
                              choices={choices}
                              handle={h}
                              parents={items}
                              parent={item}
                              onChange={(p) => patch(child.key, p)}
                              onRemove={() => remove(child.key)}
                              onMove={(to) => move(child.key, to)}
                            />
                          )}
                        </Sortable>
                      ))}
                    </ul>
                  </SortableContext>
                )
                return (
                  <Sortable key={item.key} id={item.key}>
                    {(handle) => (
                      <div className="space-y-2">
                        <ItemRow
                          item={item}
                          choices={choices}
                          handle={handle}
                          parents={items}
                          parent={null}
                          onChange={(p) => patch(item.key, p)}
                          onRemove={() => remove(item.key)}
                          onMove={(to) => move(item.key, to)}
                        />
                        <div className="ml-8 space-y-2">
                          {item.kind === 'category' ? (
                            <>
                              {childList(before)}
                              <AutoLinks
                                item={item}
                                choices={choices}
                                visibility={visibility}
                                canToggle={canToggle}
                                onToggle={toggleProgramme}
                              />
                              {childList(after)}
                            </>
                          ) : (
                            childList(item.children)
                          )}
                          <Button
                            variant="link"
                            className="text-xs"
                            onClick={() =>
                              update((cur) => cur.map((i) => (i.key === item.key ? { ...i, children: [...i.children, blank()] } : i)))
                            }
                          >
                            + Add sub-item
                          </Button>
                        </div>
                      </div>
                    )}
                  </Sortable>
                )
              })}
            </ul>
          </SortableContext>
        </DndContext>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => update((cur) => [...cur, blank()])}>
            Add menu item
          </Button>
          <Button variant="secondary" onClick={() => update((cur) => [...cur, { ...blank(), kind: 'category' }])}>
            Add category dropdown
          </Button>
        </div>
      </Card>
    </div>
  )
}
