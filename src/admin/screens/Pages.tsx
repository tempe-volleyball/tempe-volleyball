import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'wouter'
import { checkPagePath, slugify } from '../../lib/content/paths'
import {
  api,
  formatWhen,
  statusLabel,
  type PageViewsResponse,
  type PageRow,
  type PageSummary,
  type PageTemplate,
  type PurgeResult,
  type RevisionRow,
} from '../api'
import { RichText } from '../editor/LazyRichText'
import { ImageField } from '../media/MediaLibrary'
import { Button, Card, Dialog, Field, Notice, Select, StatusBadge, TextArea, errorMessage, purgeNote } from '../ui'

// Pages: the list (with search) and the editor (title, path, SEO fields, body, publish, revisions).

export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
}

export function PageList() {
  const [q, setQ] = useState('')
  const [pages, setPages] = useState<PageSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Views per path over 30 days from the Stats data (null until loaded, or when no source has data).
  const [views, setViews] = useState<PageViewsResponse | null>(null)
  useEffect(() => {
    api<PageViewsResponse>('/api/admin/stats/pages')
      .then((r) => setViews(r.source ? r : null))
      .catch(() => setViews(null))
  }, [])
  useEffect(() => {
    const t = setTimeout(
      () =>
        void api<{ pages: PageSummary[] }>(`/api/admin/pages?q=${encodeURIComponent(q)}`)
          .then((r) => setPages(r.pages))
          .catch((e) => setError(errorMessage(e))),
      q ? 250 : 0,
    )
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Pages</h1>
        <Link href="/pages/new" className="bg-brand rounded px-4 py-2 text-sm font-semibold text-white">
          New page
        </Link>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <Card>
        <div className="mb-4 max-w-sm">
          <Field label="Search" type="search" placeholder="Title or path" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {pages === null ? (
          <p className="text-sm text-black/60">Loading…</p>
        ) : pages.length === 0 ? (
          <p className="text-sm text-black/60">{q ? 'No pages match.' : 'No pages yet.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-black/60 uppercase">
                  <th className="pr-3 pb-2 font-semibold">Title</th>
                  <th className="pr-3 pb-2 font-semibold">Path</th>
                  <th className="pr-3 pb-2 font-semibold">Status</th>
                  {views && (
                    <th className="pr-3 pb-2 text-right font-semibold" title={`Page views in the last ${views.days} days (Stats)`}>
                      Views ({views.days} d)
                    </th>
                  )}
                  <th className="pb-2 font-semibold">Last saved</th>
                </tr>
              </thead>
              <tbody>
                {pages.map((p) => (
                  <tr key={p.id} className="border-t border-black/10">
                    <td className="py-2 pr-3">
                      <Link href={`/pages/${p.id}`} className="text-brand font-semibold underline">
                        {p.title}
                      </Link>
                      {p.template !== 'content' && <span className="ml-2 text-xs text-black/60">({p.template})</span>}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs break-all">{p.path}</td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={p.status} />
                    </td>
                    {views && <td className="py-2 pr-3 text-right tabular-nums">{views.views[p.path]?.toLocaleString('en-AU') ?? '–'}</td>}
                    <td className="py-2 whitespace-nowrap">{formatWhen(p.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

type Form = { title: string; path: string; metaDescription: string; ogImageId: string | null; template: PageTemplate }

const formOf = (p: PageRow): Form => ({
  title: p.title,
  path: p.path,
  metaDescription: p.metaDescription ?? '',
  ogImageId: p.ogImageId,
  template: p.template,
})

function Revisions({ page, revisions, onRestored }: { page: PageRow; revisions: RevisionRow[]; onRestored: (p: PageRow) => void }) {
  const [preview, setPreview] = useState<{ rev: RevisionRow; html: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = async (rev: RevisionRow) => {
    setError(null)
    try {
      const r = await api<{ revision: { body: { html: string } } }>(`/api/admin/pages/${page.id}/revisions/${rev.id}`)
      setPreview({ rev, html: r.revision.body.html })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const restore = async (rev: RevisionRow) => {
    setBusy(true)
    try {
      const r = await api<{ page: PageRow }>(`/api/admin/pages/${page.id}/revisions/${rev.id}`, { method: 'POST' })
      setPreview(null)
      onRestored(r.page)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Revisions">
      {error && <Notice kind="error">{error}</Notice>}
      {revisions.length === 0 ? (
        <p className="text-sm text-black/60">None yet. Every save keeps a copy (the last 20).</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {revisions.map((r, i) => (
            <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                {formatWhen(r.createdAt)} <span className="text-black/60">{r.createdBy ?? ''}</span>
                {i === 0 && <span className="ml-1 text-xs text-black/60">(current)</span>}
              </span>
              {i > 0 && (
                <Button variant="link" onClick={() => void open(r)}>
                  View
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {preview && (
        <Dialog title={`${preview.rev.title} · ${formatWhen(preview.rev.createdAt)}`} onCancel={() => setPreview(null)} wide>
          <div className="space-y-4">
            <div className="rich-text rounded border border-black/10 p-4" dangerouslySetInnerHTML={{ __html: preview.html }} />
            <div className="flex gap-2">
              <Button busy={busy} onClick={() => void restore(preview.rev)}>
                Restore this version
              </Button>
              <Button variant="secondary" onClick={() => setPreview(null)}>
                Cancel
              </Button>
            </div>
            <p className="text-xs text-black/60">
              Restoring replaces the title and content{page.status === 'published' ? ' on the live page' : ''}. It's saved as a new
              revision, so you can undo it.
            </p>
          </div>
        </Dialog>
      )}
    </Card>
  )
}

export function PageEditor({ id }: { id: string | null }) {
  const [, navigate] = useLocation()
  const [page, setPage] = useState<PageRow | null>(null)
  const [revisions, setRevisions] = useState<RevisionRow[]>([])
  const [form, setForm] = useState<Form>({ title: '', path: '', metaDescription: '', ogImageId: null, template: 'content' })
  const [pathEdited, setPathEdited] = useState(false)
  const blocks = useRef<unknown[] | undefined>(undefined)
  const [editorKey, setEditorKey] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  useUnsavedWarning(dirty)

  const load = useCallback(
    () =>
      id
        ? api<{ page: PageRow; revisions: RevisionRow[] }>(`/api/admin/pages/${id}`)
            .then((r) => {
              setPage(r.page)
              setRevisions(r.revisions)
              setForm(formOf(r.page))
              blocks.current = undefined
              setEditorKey((k) => k + 1)
              setDirty(false)
            })
            .catch((e) => setError(errorMessage(e)))
        : Promise.resolve(),
    [id],
  )
  useEffect(() => {
    void load()
  }, [load])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }))
    setDirty(true)
  }

  const pathCheck = form.path ? checkPagePath(form.path) : null
  const pathChanged = !!page && form.path !== page.path

  const save = async (): Promise<PageRow | null> => {
    setError(null)
    setMessage(null)
    try {
      if (!id) {
        const r = await api<{ page: PageRow }>('/api/admin/pages', { body: { ...form, blocks: blocks.current ?? [] } })
        setDirty(false)
        navigate(`/pages/${r.page.id}`, { replace: true })
        return r.page
      }
      const body: Record<string, unknown> = { ...form, baseUpdatedAt: page?.updatedAt }
      if (blocks.current !== undefined) body.blocks = blocks.current
      const r = await api<{ page: PageRow; cache: PurgeResult }>(`/api/admin/pages/${id}`, { method: 'PATCH', body })
      setMessage(`Saved${r.page.status === 'published' ? ' and updated the live page' : ''}.${purgeNote(r.cache)}`)
      await load()
      return r.page
    } catch (e) {
      setError(errorMessage(e))
      return null
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy('save')
    await save()
    setBusy(null)
  }

  const setStatus = async (status: 'published' | 'draft' | 'archived') => {
    if (!id) return
    setBusy(status)
    try {
      if (dirty && !(await save())) return
      const r = await api<{ page: PageRow; cache: PurgeResult }>(`/api/admin/pages/${id}/status`, { body: { status } })
      setMessage(
        `${status === 'published' ? 'Published' : status === 'draft' ? 'Unpublished (now a draft)' : 'Archived'}.${purgeNote(r.cache)}`,
      )
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!id || !page || !window.confirm(`Delete “${page.title}” and its revisions? This can't be undone.`)) return
    setBusy('delete')
    try {
      await api(`/api/admin/pages/${id}`, { method: 'DELETE' })
      setDirty(false)
      navigate('/pages')
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  if (id && !page && !error) return <p className="text-sm text-black/60">Loading…</p>

  return (
    <form className="space-y-6" onSubmit={(e) => void submit(e)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/pages" className="text-brand text-sm underline">
            ← Pages
          </Link>
          <h1 className="text-2xl font-bold">{id ? form.title || 'Untitled page' : 'New page'}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {page && <StatusBadge status={page.status} />}
          {page?.status === 'published' && (
            <a href={page.path} target="_blank" rel="noopener" className="text-brand text-sm underline">
              View live page
            </a>
          )}
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-6">
          <Card>
            <div className="space-y-4">
              <Field
                label="Title"
                required
                maxLength={200}
                value={form.title}
                onChange={(e) => {
                  set('title', e.target.value)
                  if (!id && !pathEdited) set('path', `/${slugify(e.target.value)}`)
                }}
              />
              <Field
                label="Path"
                required
                value={form.path}
                onChange={(e) => {
                  setPathEdited(true)
                  set('path', e.target.value)
                }}
                hint={
                  pathCheck && !pathCheck.ok
                    ? pathCheck.message
                    : pathChanged && page?.publishedAt
                      ? `The old address ${page.path} will redirect here (301).`
                      : 'The page’s address on the site, like /about or /about/rules. “/” is the home page.'
                }
                aria-invalid={pathCheck ? !pathCheck.ok : undefined}
              />
              <RichText
                key={editorKey}
                initial={page?.body ?? { blocks: [], html: '' }}
                onChange={(b) => {
                  blocks.current = b
                  setDirty(true)
                }}
              />
            </div>
          </Card>
          <Card title="Search and sharing">
            <div className="space-y-4">
              <TextArea
                label="Meta description"
                rows={3}
                maxLength={300}
                value={form.metaDescription}
                onChange={(e) => set('metaDescription', e.target.value)}
                hint={`What search engines show under the title. Aim for 120–160 characters (${form.metaDescription.length} now).`}
              />
              <ImageField
                label="Social image"
                mediaId={form.ogImageId}
                onChange={(v) => set('ogImageId', v)}
                hint="Shown when the page is shared on Facebook, WhatsApp and so on."
              />
              <Select label="Template" value={form.template} onChange={(e) => set('template', e.target.value as PageTemplate)}>
                <option value="content">Content page</option>
                <option value="home">Home page</option>
                <option value="contact">Contact page</option>
              </Select>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card title={page ? statusLabel[page.status] : 'Draft'}>
            <div className="space-y-2">
              <Button
                type="submit"
                className="w-full"
                busy={busy === 'save'}
                disabled={!!busy || (pathCheck !== null && !pathCheck.ok && (!id || pathChanged))}
              >
                {page?.status === 'published' ? 'Save and update live page' : id ? 'Save draft' : 'Create draft'}
              </Button>
              {page && page.status !== 'published' && (
                <Button
                  variant="secondary"
                  className="w-full"
                  busy={busy === 'published'}
                  disabled={!!busy}
                  onClick={() => void setStatus('published')}
                >
                  {dirty ? 'Save and publish' : 'Publish'}
                </Button>
              )}
              {page?.status === 'published' && (
                <Button
                  variant="secondary"
                  className="w-full"
                  busy={busy === 'draft'}
                  disabled={!!busy}
                  onClick={() => void setStatus('draft')}
                >
                  Unpublish
                </Button>
              )}
              {page && page.status !== 'archived' && (
                <Button variant="link" busy={busy === 'archived'} disabled={!!busy} onClick={() => void setStatus('archived')}>
                  Archive
                </Button>
              )}
              {dirty && <p className="text-xs text-black/60">You have unsaved changes.</p>}
              {page && (
                <p className="text-xs text-black/60">
                  Last saved {formatWhen(page.updatedAt)}
                  {page.publishedAt ? `. First published ${formatWhen(page.publishedAt)}.` : '.'}
                </p>
              )}
            </div>
          </Card>
          {page && <Revisions page={page} revisions={revisions} onRestored={() => void load()} />}
          {page && (
            <Card>
              <Button variant="danger" className="w-full" busy={busy === 'delete'} disabled={!!busy} onClick={() => void remove()}>
                Delete page
              </Button>
            </Card>
          )}
        </div>
      </div>
    </form>
  )
}
