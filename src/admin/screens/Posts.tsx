import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation } from 'wouter'
import { checkSlug, slugify } from '../../lib/content/paths'
import { api, formatWhen, statusLabel, type PostRow, type PostSummary, type PurgeResult } from '../api'
import { RichText } from '../editor/LazyRichText'
import { ImageField } from '../media/MediaLibrary'
import { Button, Card, Field, Notice, StatusBadge, TextArea, errorMessage, purgeNote } from '../ui'
import { useUnsavedWarning } from './Pages'

// News posts: list and editor. Posts live at /news/<slug>.

export function PostList() {
  const [q, setQ] = useState('')
  const [posts, setPosts] = useState<PostSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const t = setTimeout(
      () =>
        void api<{ posts: PostSummary[] }>(`/api/admin/posts?q=${encodeURIComponent(q)}`)
          .then((r) => setPosts(r.posts))
          .catch((e) => setError(errorMessage(e))),
      q ? 250 : 0,
    )
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">News</h1>
        <Link href="/news/new" className="bg-brand rounded px-4 py-2 text-sm font-semibold text-white">
          New post
        </Link>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <Card>
        <div className="mb-4 max-w-sm">
          <Field label="Search" type="search" placeholder="Title or slug" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {posts === null ? (
          <p className="text-sm text-black/60">Loading…</p>
        ) : posts.length === 0 ? (
          <p className="text-sm text-black/60">{q ? 'No posts match.' : 'No posts yet.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-black/60 uppercase">
                  <th className="pr-3 pb-2 font-semibold">Title</th>
                  <th className="pr-3 pb-2 font-semibold">Status</th>
                  <th className="pb-2 font-semibold">Published</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((p) => (
                  <tr key={p.id} className="border-t border-black/10">
                    <td className="py-2 pr-3">
                      <Link href={`/news/${p.id}`} className="text-brand font-semibold underline">
                        {p.title}
                      </Link>
                      {p.category && <span className="ml-2 text-xs text-black/60">{p.category}</span>}
                    </td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={p.status} />
                    </td>
                    <td className="py-2 whitespace-nowrap">{p.publishedAt ? formatWhen(p.publishedAt) : '—'}</td>
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

type Form = { title: string; slug: string; excerpt: string; category: string; coverMediaId: string | null; publishedAt: string }

const pad = (n: number) => String(n).padStart(2, '0')

/** ISO -> the value of a datetime-local input, in the browser's zone (the admin is used from Sydney). */
const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const formOf = (p: PostRow): Form => ({
  title: p.title,
  slug: p.slug,
  excerpt: p.excerpt ?? '',
  category: p.category ?? '',
  coverMediaId: p.coverMediaId,
  publishedAt: toLocalInput(p.publishedAt),
})

export function PostEditor({ id }: { id: string | null }) {
  const [, navigate] = useLocation()
  const [post, setPost] = useState<PostRow | null>(null)
  const [form, setForm] = useState<Form>({ title: '', slug: '', excerpt: '', category: '', coverMediaId: null, publishedAt: '' })
  const [slugEdited, setSlugEdited] = useState(false)
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
        ? api<{ post: PostRow }>(`/api/admin/posts/${id}`)
            .then((r) => {
              setPost(r.post)
              setForm(formOf(r.post))
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
  const slugCheck = form.slug ? checkSlug(form.slug) : null

  const payload = () => {
    const body: Record<string, unknown> = {
      title: form.title,
      slug: form.slug,
      excerpt: form.excerpt,
      category: form.category,
      coverMediaId: form.coverMediaId,
      baseUpdatedAt: post?.updatedAt,
    }
    if (form.publishedAt && post?.publishedAt) body.publishedAt = new Date(form.publishedAt).toISOString()
    if (blocks.current !== undefined) body.blocks = blocks.current
    return body
  }

  const save = async (): Promise<boolean> => {
    setError(null)
    setMessage(null)
    try {
      if (!id) {
        const r = await api<{ post: PostRow }>('/api/admin/posts', { body: { ...payload(), blocks: blocks.current ?? [] } })
        setDirty(false)
        navigate(`/news/${r.post.id}`, { replace: true })
        return true
      }
      const r = await api<{ post: PostRow; cache: PurgeResult }>(`/api/admin/posts/${id}`, { method: 'PATCH', body: payload() })
      setMessage(`Saved${r.post.status === 'published' ? ' and updated the live post' : ''}.${purgeNote(r.cache)}`)
      await load()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
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
      const r = await api<{ post: PostRow; cache: PurgeResult }>(`/api/admin/posts/${id}/status`, { body: { status } })
      setMessage(`${status === 'published' ? 'Published' : status === 'draft' ? 'Unpublished' : 'Archived'}.${purgeNote(r.cache)}`)
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!id || !post || !window.confirm(`Delete “${post.title}”? This can't be undone.`)) return
    setBusy('delete')
    try {
      await api(`/api/admin/posts/${id}`, { method: 'DELETE' })
      setDirty(false)
      navigate('/news')
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  if (id && !post && !error) return <p className="text-sm text-black/60">Loading…</p>

  return (
    <form className="space-y-6" onSubmit={(e) => void submit(e)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/news" className="text-brand text-sm underline">
            ← News
          </Link>
          <h1 className="text-2xl font-bold">{id ? form.title || 'Untitled post' : 'New post'}</h1>
        </div>
        <div className="flex items-center gap-2">
          {post && <StatusBadge status={post.status} />}
          {post?.status === 'published' && (
            <a href={`/news/${post.slug}`} target="_blank" rel="noopener" className="text-brand text-sm underline">
              View live post
            </a>
          )}
        </div>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
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
                  if (!id && !slugEdited) set('slug', slugify(e.target.value))
                }}
              />
              <Field
                label="Slug"
                required
                value={form.slug}
                onChange={(e) => {
                  setSlugEdited(true)
                  set('slug', e.target.value)
                }}
                hint={
                  slugCheck && !slugCheck.ok
                    ? slugCheck.message
                    : `The post’s address: /news/${form.slug || '…'}${post?.publishedAt && form.slug !== post.slug ? ` (the old /news/${post.slug} will redirect here)` : ''}`
                }
              />
              <RichText
                key={editorKey}
                keepsRevisions={false}
                initial={post?.body ?? { blocks: [], html: '' }}
                onChange={(b) => {
                  blocks.current = b
                  setDirty(true)
                }}
              />
            </div>
          </Card>
          <Card title="Summary">
            <div className="space-y-4">
              <TextArea
                label="Excerpt"
                rows={3}
                maxLength={300}
                value={form.excerpt}
                onChange={(e) => set('excerpt', e.target.value)}
                hint="Shown in the news list and to search engines. Left empty, the start of the post is used."
              />
              <Field label="Category" maxLength={60} value={form.category} onChange={(e) => set('category', e.target.value)} />
              <ImageField label="Cover image" mediaId={form.coverMediaId} onChange={(v) => set('coverMediaId', v)} />
              {post?.publishedAt && (
                <Field
                  label="Publish date"
                  type="datetime-local"
                  value={form.publishedAt}
                  onChange={(e) => set('publishedAt', e.target.value)}
                  hint="Posts are listed newest first by this date."
                />
              )}
            </div>
          </Card>
        </div>
        <div className="space-y-6">
          <Card title={post ? statusLabel[post.status] : 'Draft'}>
            <div className="space-y-2">
              <Button type="submit" className="w-full" busy={busy === 'save'} disabled={!!busy || (slugCheck !== null && !slugCheck.ok)}>
                {post?.status === 'published' ? 'Save and update live post' : id ? 'Save draft' : 'Create draft'}
              </Button>
              {post && post.status !== 'published' && (
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
              {post?.status === 'published' && (
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
              {post && post.status !== 'archived' && (
                <Button variant="link" busy={busy === 'archived'} disabled={!!busy} onClick={() => void setStatus('archived')}>
                  Archive
                </Button>
              )}
              {dirty && <p className="text-xs text-black/60">You have unsaved changes.</p>}
            </div>
          </Card>
          {post && (
            <Card>
              <Button variant="danger" className="w-full" busy={busy === 'delete'} disabled={!!busy} onClick={() => void remove()}>
                Delete post
              </Button>
            </Card>
          )}
        </div>
      </div>
    </form>
  )
}
