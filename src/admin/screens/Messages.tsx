import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { replyMailto } from '../../lib/contact'
import { api, formatWhen } from '../api'
import type { MessageDetail, MessageFilter, MessageList, MessageListItem } from '../../server/contact/messages'
import { useUnsavedWarning } from '../unsaved'
import {
  Breadcrumbs,
  Button,
  Card,
  EmailText,
  EmptyState,
  Field,
  LoadError,
  Notice,
  Select,
  Skeleton,
  TextArea,
  confirmAction,
  errorMessage,
  toast,
} from '../ui'

// Admin → Messages (docs/admin.md §3.15): what people sent with the contact form. Admins and owners only (it's
// personal data). The list shows open messages first (new and read); opening one marks it read. Each can be replied
// to (a mailto: link that quotes it), noted, marked handled, or deleted for good; several at once can be marked
// handled or deleted (spam). Handled messages are deleted automatically after Settings → Contact form's retention
// period. The CSV export is audited.

/** Tells the nav's unread badge to look again (App.tsx). */
export const messagesChanged = () => window.dispatchEvent(new Event('tvb:messages-changed'))

const FILTERS: [MessageFilter, string][] = [
  ['open', 'Open'],
  ['new', 'Unread'],
  ['handled', 'Handled'],
  ['all', 'All'],
]

const STATUS_LABEL: Record<string, string> = { new: 'Unread', read: 'Read', handled: 'Handled' }

function StatusChip({ status }: { status: string }) {
  const cls = status === 'new' ? 'bg-accent text-ink' : status === 'handled' ? 'bg-green-100 text-green-900' : 'bg-black/5 text-black/70'
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{STATUS_LABEL[status] ?? status}</span>
}

export function Messages() {
  const [filter, setFilter] = useState<MessageFilter>('open')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [topic, setTopic] = useState('')
  const [data, setData] = useState<MessageList | null>(null)
  const [more, setMore] = useState<MessageListItem[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  const url = useCallback(
    (before?: string | null) => {
      const p = new URLSearchParams({ filter })
      if (query) p.set('q', query)
      if (topic) p.set('topic', topic)
      if (before) p.set('before', before)
      return `/api/admin/messages?${p}`
    },
    [filter, query, topic],
  )

  const load = useCallback(() => {
    const n = ++seq.current
    setError(null)
    api<MessageList>(url()).then(
      (d) => {
        if (n !== seq.current) return
        setData(d)
        setMore([])
        setNext(d.next)
        setSelected(new Set())
      },
      (e: unknown) => n === seq.current && setError(errorMessage(e)),
    )
  }, [url])

  useEffect(() => load(), [load])
  // Search as you type, after a pause.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  const rows = data ? [...data.rows, ...more] : []
  const allChosen = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })

  const loadMore = async () => {
    if (!next) return
    try {
      const d = await api<MessageList>(url(next))
      setMore((m) => [...m, ...d.rows])
      setNext(d.next)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  const bulk = async (action: 'handled' | 'delete') => {
    const ids = [...selected].slice(0, 90)
    if (ids.length === 0) return
    if (
      action === 'delete' &&
      !(await confirmAction({
        title: `Delete ${ids.length === 1 ? 'this message' : `${ids.length} messages`} for good?`,
        body: 'They can’t be brought back. Use this for spam, or once you no longer need them.',
        confirmLabel: ids.length === 1 ? 'Delete message' : `Delete ${ids.length} messages`,
        danger: true,
      }))
    )
      return
    setBusy(true)
    try {
      if (action === 'delete') {
        const r = await api<{ deleted: number }>('/api/admin/messages', { body: { action: 'delete', ids } })
        toast(`Deleted ${r.deleted} ${r.deleted === 1 ? 'message' : 'messages'}.`)
      } else {
        const r = await api<{ changed: number }>('/api/admin/messages', { body: { action: 'status', ids, status: 'handled' } })
        toast(`Marked ${r.changed} as handled.`)
      }
      messagesChanged()
      load()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const counts = data?.counts
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Messages</h1>
          <p className="text-sm text-black/70">
            From the contact form.{' '}
            {counts ? `${counts.new} unread, ${counts.new + counts.read} open. ` : ''}
            Topics, notifications and how long handled messages are kept are in{' '}
            <Link href="/settings#settings-contactForm" className="text-brand underline underline-offset-2">
              Settings → Contact form
            </Link>
            .
          </p>
        </div>
        <a
          href={`/api/admin/messages/export.csv?filter=${filter}`}
          className="border-brand text-brand hover:bg-brand/5 inline-flex rounded border bg-white px-4 py-2 text-sm font-semibold"
          download
        >
          Export CSV
        </a>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              type="button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
              className={`rounded px-3 py-2 text-sm font-semibold ${filter === f ? 'bg-brand text-white' : 'bg-white text-black/80 hover:bg-black/5'}`}
            >
              {label}
              {counts && f !== 'all' && (
                <span className="ml-1 font-normal">
                  ({f === 'open' ? counts.new + counts.read : f === 'new' ? counts.new : counts.handled})
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="min-w-48 flex-1">
          <Field label="Search" type="search" value={q} placeholder="Name, email or words" onChange={(e) => setQ(e.target.value)} />
        </div>
        {data && data.topics.length > 0 && (
          <div className="w-48">
            <Select label="Topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
              <option value="">Any</option>
              {data.topics.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {error && <LoadError message={error} onRetry={load} />}
      {!data && !error && (
        <Card>
          <Skeleton lines={5} label="Loading messages…" />
        </Card>
      )}
      {data && rows.length === 0 && (
        <EmptyState title={query || topic ? 'No messages match.' : filter === 'open' ? 'No open messages.' : 'No messages here.'}>
          {query || topic
            ? 'Try other words, or another topic.'
            : 'Messages sent with a Contact form block (on /contact, or any page you add one to) arrive here.'}
        </EmptyState>
      )}
      {data && rows.length > 0 && (
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-black/10 pb-3">
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                className="accent-brand h-4 w-4"
                checked={allChosen}
                onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
              />
              Select all shown
            </label>
            {selected.size > 0 && (
              <span className="flex flex-wrap gap-2">
                <Button variant="secondary" busy={busy} onClick={() => void bulk('handled')}>
                  Mark {selected.size} handled
                </Button>
                <Button variant="danger" busy={busy} onClick={() => void bulk('delete')}>
                  Delete {selected.size} for good
                </Button>
              </span>
            )}
          </div>
          <ul className="divide-y divide-black/10">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-3 py-3">
                <input
                  type="checkbox"
                  className="accent-brand mt-1.5 h-4 w-4 shrink-0"
                  aria-label={`Select the message from ${r.name}`}
                  checked={selected.has(r.id)}
                  onChange={(e) => toggle(r.id, e.target.checked)}
                />
                <Link href={`/messages/${r.id}`} className="group min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={`text-brand group-hover:underline ${r.status === 'new' ? 'font-bold' : 'font-semibold'}`}>{r.name}</span>
                    {r.topic && <span className="text-sm text-black/70">· {r.topic}</span>}
                    <StatusChip status={r.status} />
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-black/80">{r.preview}</span>
                  <span className="mt-0.5 block text-xs text-black/60">
                    {formatWhen(r.createdAt)} · <EmailText email={r.email} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {next && (
            <div className="mt-3">
              <Button variant="secondary" onClick={() => void loadMore()}>
                Show older messages
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}

export function MessagePage({ id }: { id: string }) {
  const [, navigate] = useLocation()
  const [m, setM] = useState<MessageDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const dirty = !!m && note.trim() !== (m.note ?? '')
  useUnsavedWarning(dirty)

  const load = useCallback(() => {
    setError(null)
    api<MessageDetail>(`/api/admin/messages/${encodeURIComponent(id)}`).then(
      (d) => {
        setM(d)
        setNote(d.note ?? '')
        messagesChanged()
      },
      (e: unknown) => setError(errorMessage(e)),
    )
  }, [id])
  useEffect(() => load(), [load])

  const patch = async (body: { status?: string; note?: string }, what: string, done: string) => {
    setBusy(what)
    try {
      const d = await api<MessageDetail>(`/api/admin/messages/${encodeURIComponent(id)}`, { method: 'PATCH', body })
      setM(d)
      if (body.note !== undefined) setNote(d.note ?? '')
      toast(done)
      messagesChanged()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (
      !(await confirmAction({
        title: 'Delete this message for good?',
        body: 'It can’t be brought back.',
        confirmLabel: 'Delete message',
        danger: true,
      }))
    )
      return
    setBusy('delete')
    try {
      await api(`/api/admin/messages/${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast('Message deleted.')
      messagesChanged()
      navigate('/messages')
    } catch (e) {
      toast(errorMessage(e), 'error')
      setBusy(null)
    }
  }

  const crumbs = [{ label: 'Messages', href: '/messages' }, { label: m ? `From ${m.name}` : 'Message' }]
  if (error)
    return (
      <div className="space-y-4">
        <Breadcrumbs items={crumbs} />
        <LoadError message={error} onRetry={load} />
      </div>
    )
  if (!m)
    return (
      <div className="space-y-4">
        <Breadcrumbs items={crumbs} />
        <Card>
          <Skeleton lines={6} label="Loading the message…" />
        </Card>
      </div>
    )

  const handled = m.status === 'handled'
  return (
    <div className="space-y-5">
      <Breadcrumbs items={crumbs} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">
          {m.topic ? `${m.topic}: ` : ''}
          {m.name}
        </h1>
        <StatusChip status={m.status} />
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <dl className="mb-4 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="font-semibold">From</dt>
              <dd>
                {m.name} &lt;
                <EmailText email={m.email} />
                &gt;
              </dd>
              <dt className="font-semibold">Received</dt>
              <dd>{formatWhen(m.createdAt)}</dd>
              {m.pagePath && (
                <>
                  <dt className="font-semibold">Sent from</dt>
                  <dd>
                    <a href={m.pagePath} className="text-brand underline" target="_blank" rel="noopener">
                      {m.pagePath}
                    </a>
                  </dd>
                </>
              )}
              {handled && m.handledAt && (
                <>
                  <dt className="font-semibold">Handled</dt>
                  <dd>
                    {formatWhen(m.handledAt)}
                    {m.handledByName ? ` by ${m.handledByName}` : ''}
                  </dd>
                </>
              )}
            </dl>
            <div className="rounded border-l-4 border-accent bg-black/[0.02] px-4 py-3 whitespace-pre-wrap [overflow-wrap:anywhere]">{m.message}</div>
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href={replyMailto(m)}
                className="bg-brand hover:bg-brand-dark inline-flex items-center rounded px-4 py-2 text-sm font-semibold text-white"
              >
                Reply by email
              </a>
              {handled ? (
                <Button variant="secondary" busy={busy === 'status'} onClick={() => void patch({ status: 'read' }, 'status', 'Reopened.')}>
                  Reopen
                </Button>
              ) : (
                <Button variant="secondary" busy={busy === 'status'} onClick={() => void patch({ status: 'handled' }, 'status', 'Marked as handled.')}>
                  Mark handled
                </Button>
              )}
              {!handled && (
                <Button variant="link" disabled={busy !== null} onClick={() => void patch({ status: 'new' }, 'status', 'Marked as unread.')}>
                  Mark unread
                </Button>
              )}
            </div>
            <p className="mt-2 text-xs text-black/60">
              “Reply by email” opens your email app with their address and the message quoted. Mark it handled once it’s dealt with.
            </p>
          </Card>
        </div>
        <div className="space-y-5">
          <Card title="Note">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                void patch({ note }, 'note', 'Note saved.')
              }}
            >
              <TextArea
                label="For the admins (never sent)"
                rows={4}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                hint="E.g. “Replied 20/10, placed in TNL B.”"
              />
              <Button type="submit" busy={busy === 'note'} disabled={!dirty}>
                Save note
              </Button>
            </form>
          </Card>
          <Card title="Delete">
            <p className="mb-3 text-sm text-black/70">
              Spam, or no longer needed? Handled messages are also deleted on their own after the period in Settings → Contact form.
            </p>
            <Button variant="danger" busy={busy === 'delete'} onClick={() => void remove()}>
              Delete for good
            </Button>
          </Card>
          {!handled && m.status === 'read' && (
            <Notice kind="info">Opened {m.readAt ? formatWhen(m.readAt) : ''}. It stays in Open until it’s marked handled.</Notice>
          )}
        </div>
      </div>
    </div>
  )
}
