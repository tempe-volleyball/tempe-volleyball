import { useCallback, useEffect, useRef, useState } from 'react'
import { checkSlug, slugify } from '../../lib/content/paths'
import { api, type CategoryListItem, type Me, type ProgrammeStatus, type PurgeResult } from '../api'
import { RichText } from '../editor/LazyRichText'
import { ImageField } from '../media/MediaLibrary'
import { Button, Card, Dialog, Field, Notice, Select, StatusBadge, TextArea, errorMessage, purgeNote } from '../ui'
import { statusLabel } from './kinds'

// Programme categories (docs/admin.md §3.2): each has a landing page at /<slug> listing its programmes, and the
// order here is the menu order of category dropdowns. Delete only when empty.

export function Categories({ me }: { me: Me }) {
  const isAdmin = me.user.role !== 'editor'
  const [rows, setRows] = useState<CategoryListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [editing, setEditing] = useState<CategoryListItem | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(
    () =>
      api<{ categories: CategoryListItem[] }>('/api/admin/categories')
        .then((r) => setRows(r.categories))
        .catch((e) => setError(errorMessage(e))),
    [],
  )
  useEffect(() => {
    void load()
  }, [load])

  const move = async (index: number, by: -1 | 1) => {
    if (!rows) return
    const ids = rows.map((r) => r.id)
    const [item] = ids.splice(index, 1)
    ids.splice(index + by, 0, item!)
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ categories: CategoryListItem[]; cache: PurgeResult }>('/api/admin/categories/order', {
        method: 'PUT',
        body: { ids },
      })
      setRows(r.categories)
      setMessage(`Order saved.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
      void load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Categories</h1>
          <p className="mt-1 max-w-2xl text-sm text-black/60">
            Every programme belongs to one category. Each category has its own page listing its programmes, and can be a menu dropdown. The
            order here is the order they’re listed in.
          </p>
        </div>
        {isAdmin && <Button onClick={() => setEditing('new')}>New category</Button>}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      <Card>
        {rows === null ? (
          <p className="text-sm text-black/60">Loading…</p>
        ) : (
          <ul className="divide-y divide-black/10">
            {rows.map((c, i) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
                {isAdmin && (
                  <span className="flex flex-col">
                    <button
                      type="button"
                      className="px-1 leading-none text-black/50 hover:text-black disabled:opacity-20"
                      aria-label={`Move ${c.name} up`}
                      disabled={busy || i === 0}
                      onClick={() => void move(i, -1)}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      className="px-1 leading-none text-black/50 hover:text-black disabled:opacity-20"
                      aria-label={`Move ${c.name} down`}
                      disabled={busy || i === rows.length - 1}
                      onClick={() => void move(i, 1)}
                    >
                      ▼
                    </button>
                  </span>
                )}
                <span className="min-w-48">
                  {isAdmin ? (
                    <Button variant="link" className="font-semibold" onClick={() => setEditing(c)}>
                      {c.name}
                    </Button>
                  ) : (
                    <span className="font-semibold">{c.name}</span>
                  )}
                  <span className="block font-mono text-xs text-black/50">{c.path}</span>
                </span>
                <StatusBadge status={c.status} />
                <span className="ml-auto text-xs text-black/60">
                  {c.programmes.active} active
                  {c.programmes.draft ? `, ${c.programmes.draft} draft` : ''}
                  {c.programmes.retired ? `, ${c.programmes.retired} retired` : ''}
                  {c.menuItems ? ' · in the menu' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && (
        <CategoryDialog
          category={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null)
            setMessage(text)
            void load()
          }}
        />
      )}
    </div>
  )
}

function CategoryDialog({
  category,
  onCancel,
  onDone,
}: {
  category: CategoryListItem | null
  onCancel: () => void
  onDone: (message: string) => void
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [slug, setSlug] = useState(category?.slug ?? '')
  const [status, setStatus] = useState<ProgrammeStatus>(category?.status ?? 'draft')
  const [seoTitle, setSeoTitle] = useState(category?.seoTitle ?? '')
  const [seoDescription, setSeoDescription] = useState(category?.seoDescription ?? '')
  const [ogImageId, setOgImageId] = useState<string | null>(category?.ogImageId ?? null)
  const intro = useRef<unknown[] | undefined>(undefined)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const effectiveSlug = slug || slugify(name)
  const check = effectiveSlug ? checkSlug(effectiveSlug) : null
  const empty = !category || category.programmes.active + category.programmes.draft + category.programmes.retired === 0

  const save = async () => {
    setBusy('save')
    setError(null)
    const body: Record<string, unknown> = {
      name,
      slug: effectiveSlug,
      status,
      seoTitle: seoTitle || null,
      seoDescription: seoDescription || null,
      ogImageId,
    }
    if (intro.current !== undefined) body.intro = intro.current
    try {
      const r = category
        ? await api<{ cache: PurgeResult }>(`/api/admin/categories/${category.id}`, {
            method: 'PATCH',
            body: { ...body, baseUpdatedAt: category.updatedAt },
          })
        : await api<{ cache: PurgeResult }>('/api/admin/categories', { body })
      onDone(`${category ? 'Saved' : 'Added'} ${name}.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }
  const remove = async () => {
    if (!category || !window.confirm(`Delete the category ${category.name}?`)) return
    setBusy('delete')
    try {
      const r = await api<{ cache: PurgeResult }>(`/api/admin/categories/${category.id}`, { method: 'DELETE' })
      onDone(`Deleted ${category.name}.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  return (
    <Dialog title={category ? category.name : 'New category'} onCancel={onCancel} wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <Field
            label="URL name"
            value={slug}
            placeholder={slugify(name)}
            onChange={(e) => setSlug(e.target.value)}
            hint={
              check && !check.ok
                ? check.message
                : category && effectiveSlug !== category.slug && category.status !== 'draft'
                  ? `/${category.slug} will redirect to /${effectiveSlug}.`
                  : `The page is /${effectiveSlug}.`
            }
          />
          <Select
            label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as ProgrammeStatus)}
            hint="Retire only once its programmes are retired or moved."
          >
            {(['draft', 'active', 'retired'] as const).map((s) => (
              <option key={s} value={s}>
                {statusLabel[s]}
              </option>
            ))}
          </Select>
        </div>
        <RichText
          label="Intro"
          initial={category?.intro ?? { blocks: [], html: '' }}
          onChange={(b) => {
            intro.current = b
          }}
        />
        <p className="-mt-2 text-xs text-black/60">Shown above the list of programmes on the category page.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Search title" maxLength={120} value={seoTitle} placeholder={name} onChange={(e) => setSeoTitle(e.target.value)} />
          <ImageField label="Social image" mediaId={ogImageId} onChange={setOgImageId} />
        </div>
        <TextArea
          label="Search description"
          rows={2}
          maxLength={300}
          value={seoDescription}
          onChange={(e) => setSeoDescription(e.target.value)}
          hint="Leave blank to use the start of the intro."
        />
        <div className="flex flex-wrap justify-between gap-2">
          {category ? (
            <Button
              variant="danger"
              busy={busy === 'delete'}
              disabled={!!busy || !empty}
              onClick={() => void remove()}
              title={empty ? undefined : 'Move its programmes to another category first.'}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" busy={busy === 'save'} disabled={!!busy || (check !== null && !check.ok)}>
              {category ? 'Save' : 'Add category'}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
