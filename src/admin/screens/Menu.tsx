import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { MenuInput, MenuItemKind, MenuNode } from '../../lib/content/menu'
import { api, type PurgeResult } from '../api'
import { Button, Card, Notice, errorMessage, purgeNote } from '../ui'
import { useUnsavedWarning } from './Pages'

// The menu editor: two levels, drag (or keyboard) to reorder within a level, "Move to" to change level. Saved as
// a whole with one PUT.

type Choices = {
  pages: { id: string; title: string; path: string; status: string }[]
  leagues: { id: string; code: string; name: string }[]
}
type Item = { key: string; id?: string; label: string; kind: MenuItemKind; pageId: string; leagueId: string; url: string; children: Item[] }

// `category` and `programme` items (Phase 6 schema) aren't editable here yet; checkMenu refuses them until they are.
const KINDS: Partial<Record<MenuItemKind, string>> = {
  page: 'Page',
  url: 'Link or heading',
  league_ladder: 'League ladder',
  league_fixtures: 'League fixtures',
}

let seq = 0
const key = () => `k${++seq}`

const fromTree = (nodes: MenuNode[]): Item[] =>
  nodes.map((n) => ({
    key: key(),
    id: n.id,
    label: n.label,
    kind: n.kind,
    pageId: n.pageId ?? '',
    leagueId: n.leagueId ?? '',
    url: n.url ?? '',
    children: fromTree(n.children),
  }))

const toInput = (items: Item[]): MenuInput[] =>
  items.map((i) => ({
    id: i.id,
    label: i.label,
    kind: i.kind,
    pageId: i.kind === 'page' ? i.pageId : null,
    leagueId: i.kind === 'league_ladder' || i.kind === 'league_fixtures' ? i.leagueId : null,
    url: i.kind === 'url' ? i.url : null,
    children: toInput(i.children),
  }))

const blank = (): Item => ({ key: key(), label: '', kind: 'page', pageId: '', leagueId: '', url: '', children: [] })

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

function ItemRow({
  item,
  choices,
  handle,
  parents,
  parentKey,
  onChange,
  onRemove,
  onMove,
}: {
  item: Item
  choices: Choices
  handle: ReactNode
  parents: Item[]
  parentKey: string | null
  onChange: (patch: Partial<Item>) => void
  onRemove: () => void
  onMove: (to: string | null) => void
}) {
  const input = 'rounded border border-black/20 bg-white px-2 py-1 text-sm'
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-black/10 bg-white p-2">
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
        {Object.entries(KINDS).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
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
      <span className="ml-auto flex items-center gap-2">
        {item.children.length === 0 && (
          <select className={input} aria-label="Move to" value={parentKey ?? ''} onChange={(e) => onMove(e.target.value || null)}>
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

export function Menu() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [choices, setChoices] = useState<Choices>({ pages: [], leagues: [] })
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useUnsavedWarning(dirty)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const apply = useCallback((r: { tree: MenuNode[] } & Choices) => {
    setItems(fromTree(r.tree))
    setChoices({ pages: r.pages, leagues: r.leagues })
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

  const save = async () => {
    if (!items) return
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ tree: MenuNode[]; cache: PurgeResult } & Choices>('/api/admin/menu', {
        method: 'PUT',
        body: { items: toInput(items) },
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
          Drag ⠿ to reorder (or focus it and use the arrow keys). Use “Move to” to put an item under a heading. League items always point at
          that league’s current season. Draft pages are hidden from the public menu until they’re published.
        </p>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
            <ul className="space-y-3">
              {items.map((item) => (
                <Sortable key={item.key} id={item.key}>
                  {(handle) => (
                    <div className="space-y-2">
                      <ItemRow
                        item={item}
                        choices={choices}
                        handle={handle}
                        parents={items}
                        parentKey={null}
                        onChange={(p) => patch(item.key, p)}
                        onRemove={() => remove(item.key)}
                        onMove={(to) => move(item.key, to)}
                      />
                      <div className="ml-8 space-y-2">
                        <SortableContext items={item.children.map((c) => c.key)} strategy={verticalListSortingStrategy}>
                          <ul className="space-y-2">
                            {item.children.map((child) => (
                              <Sortable key={child.key} id={child.key}>
                                {(h) => (
                                  <ItemRow
                                    item={child}
                                    choices={choices}
                                    handle={h}
                                    parents={items}
                                    parentKey={item.key}
                                    onChange={(p) => patch(child.key, p)}
                                    onRemove={() => remove(child.key)}
                                    onMove={(to) => move(child.key, to)}
                                  />
                                )}
                              </Sortable>
                            ))}
                          </ul>
                        </SortableContext>
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
              ))}
            </ul>
          </SortableContext>
        </DndContext>
        <Button variant="secondary" className="mt-4" onClick={() => update((cur) => [...cur, blank()])}>
          Add menu item
        </Button>
      </Card>
    </div>
  )
}
