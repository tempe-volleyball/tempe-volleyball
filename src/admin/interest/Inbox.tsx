import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useSearch } from 'wouter'
import { api, formatWhen } from '../api'
import type { InterestList, InterestListItem } from '../../server/interest/admin'
import { formatAud } from '../../lib/time'
import { Button, Card, Checkbox, EmptyState, Field, LoadError, Skeleton, confirmAction, errorMessage, toast } from '../ui'
import { AddInterestDialog } from './AddInterestDialog'
import { interestChanged } from './events'
import {
  KeepPlayersChoice,
  KindChip,
  LEVEL_LABEL,
  POSITION_LABEL,
  PaidChip,
  STATUSES,
  STATUS_LABEL,
  StatusChip,
  personName,
  shortDate,
} from './labels'

// Admin → Interest (docs/admin.md §3.16): every expression of interest, newest first. The filters live in the URL
// (programme, status, kind, since, archived, q), so the dashboard and Admin → Enrolments can link to a programme's
// open EOIs and a view survives a reload. Admins and owners only (personal data).

const FILTER_KEYS = ['programme', 'status', 'kind', 'since', 'archived', 'q'] as const
type FilterKey = (typeof FILTER_KEYS)[number]

const selectClass = 'w-full rounded border border-black/20 bg-white px-2 py-2 text-sm'

export function InterestInbox() {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const params = useMemo(() => new URLSearchParams(search), [search])
  const get = (k: FilterKey) => params.get(k) ?? ''
  const set = (patch: Partial<Record<FilterKey, string>>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    const qs = next.toString()
    navigate(qs ? `${location}?${qs}` : location, { replace: true })
  }
  const query = useMemo(() => {
    const q = new URLSearchParams()
    for (const k of FILTER_KEYS) if (params.get(k)) q.set(k, params.get(k)!)
    return q.toString()
  }, [params])

  // Search as you type, after a pause (the latest `set` is kept in a ref so the timer uses the current URL).
  const [qText, setQText] = useState(get('q'))
  const setRef = useRef(set)
  useEffect(() => {
    setRef.current = set
  })
  const urlQ = get('q')
  useEffect(() => {
    if (qText.trim() === urlQ) return
    const t = setTimeout(() => setRef.current({ q: qText.trim() }), 300)
    return () => clearTimeout(t)
  }, [qText, urlQ])

  const [data, setData] = useState<InterestList | null>(null)
  const [more, setMore] = useState<InterestListItem[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const seq = useRef(0)

  const fetchList = useCallback(() => {
    const n = ++seq.current
    api<InterestList>(`/api/admin/interest${query ? `?${query}` : ''}`).then(
      (d) => {
        if (n !== seq.current) return
        setError(null)
        setData(d)
        setMore([])
        setNext(d.next)
        setSelected(new Set())
      },
      (e: unknown) => n === seq.current && setError(errorMessage(e)),
    )
  }, [query])
  useEffect(() => fetchList(), [fetchList])

  const rows = data ? [...data.rows, ...more] : []
  const programme = data?.programmes.find((p) => p.id === get('programme')) ?? null
  const allChosen = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const archivedView = get('archived') === 'archived'
  const secondary = (['status', 'kind', 'archived'] as const).filter((k) => get(k)).length

  const loadMore = async () => {
    if (!next) return
    try {
      const p = new URLSearchParams(query)
      p.set('before', next)
      const d = await api<InterestList>(`/api/admin/interest?${p}`)
      setMore((m) => [...m, ...d.rows])
      setNext(d.next)
    } catch (e) {
      toast(errorMessage(e), 'error')
    }
  }

  const bulk = async (action: 'contacted' | 'archive' | 'unarchive' | 'delete') => {
    const ids = [...selected].slice(0, 90)
    if (ids.length === 0) return
    const what = ids.length === 1 ? 'this EOI' : `${ids.length} EOIs`
    let keepPlayers = false
    if (action === 'delete') {
      const yes = await confirmAction({
        title: `Delete ${what} for good?`,
        body: (
          <>
            <p>
              They can’t be brought back. Use this for spam, or once you no longer need them. Archived EOIs are also deleted on their own
              after the period in Settings → Interest.
            </p>
            <KeepPlayersChoice onChange={(v) => (keepPlayers = v)} />
          </>
        ),
        confirmLabel: ids.length === 1 ? 'Delete EOI' : `Delete ${ids.length} EOIs`,
        danger: true,
      })
      if (!yes) return
    }
    setBusy(true)
    try {
      if (action === 'delete') {
        const r = await api<{ deleted: number; playersDeleted: number }>('/api/admin/interest', {
          body: { action: 'delete', ids, keepPlayers },
        })
        toast(
          `Deleted ${r.deleted} ${r.deleted === 1 ? 'EOI' : 'EOIs'}${r.playersDeleted ? ` and ${r.playersDeleted} ${r.playersDeleted === 1 ? 'player' : 'players'} they added` : ''}.`,
        )
      } else if (action === 'contacted') {
        const r = await api<{ changed: number }>('/api/admin/interest', {
          body: { action: 'status', ids, status: 'contacted', programmeId: get('programme') || null },
        })
        toast(`Marked ${r.changed} as contacted${programme ? ` for ${programme.code}` : ''}.`)
      } else {
        const r = await api<{ changed: number }>('/api/admin/interest', { body: { action, ids } })
        toast(`${action === 'archive' ? 'Archived' : 'Unarchived'} ${r.changed}.`)
      }
      interestChanged()
      fetchList()
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s)
      if (on) n.add(id)
      else n.delete(id)
      return n
    })

  const filtered = !!(get('q') || get('kind') || get('since') || (get('status') && get('status') !== 'open') || get('archived'))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Interest</h1>
          <p className="text-sm text-black/70">
            Expressions of interest from the website’s form and ones you’ve added. {data ? `${data.total} shown by these filters. ` : ''}The
            form’s questions, emails and how long archived EOIs are kept are in{' '}
            <Link href="/settings#settings-interest" className="text-brand underline underline-offset-2">
              Settings → Interest
            </Link>
            .
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setAdding(true)}>Add EOI</Button>
          <a
            href={`/api/admin/interest/export.csv${query ? `?${query}` : ''}`}
            className="border-brand text-brand hover:bg-brand/5 inline-flex items-center rounded border bg-white px-4 py-2 text-sm font-semibold"
            download
          >
            Export CSV
          </a>
        </div>
      </div>

      <Card>
        {data && data.programmes.length > 0 && (
          <div role="group" aria-label="Programme" className="-mx-1 flex flex-wrap gap-1">
            <ChipButton on={!get('programme')} onClick={() => set({ programme: '', since: '' })}>
              All programmes
            </ChipButton>
            {data.programmes.map((p) => (
              <ChipButton key={p.id} on={get('programme') === p.id} onClick={() => set({ programme: p.id })} title={p.name}>
                {p.code}
                {p.counts.new > 0 && <span className="font-normal"> · {p.counts.new} new</span>}
                {p.signupMode === 'interest' && !p.interestOpen && <span className="font-normal"> · closed</span>}
              </ChipButton>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <Checkbox
            label={
              programme
                ? programme.since
                  ? `Only since ${programme.lastSeason?.name ?? 'the last season'} started (${shortDate(programme.since)})`
                  : `Only since the last season started (${programme.code} has none yet, so any time)`
                : 'Only since each programme’s last season started'
            }
            checked={get('since') === 'season'}
            onChange={(v) => set({ since: v ? 'season' : '' })}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <Field
              label="Search"
              type="search"
              value={qText}
              placeholder="Name, email, team or EOI-…"
              onChange={(e) => setQText(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="text-brand py-2 text-sm font-semibold underline underline-offset-2 sm:hidden"
            aria-expanded={showFilters}
            aria-controls="interest-filters"
            onClick={() => setShowFilters((v) => !v)}
          >
            {showFilters ? 'Hide filters' : `Filters${secondary ? ` (${secondary} on)` : ''}`}
          </button>
          <div
            id="interest-filters"
            className={`w-full flex-wrap items-end gap-3 sm:flex sm:w-auto ${showFilters ? 'grid grid-cols-2' : 'hidden'}`}
          >
            <label className="block text-sm sm:w-52">
              <span className="mb-1 block font-semibold">Status</span>
              <select
                className={selectClass}
                value={get('status') || 'open'}
                onChange={(e) => set({ status: e.target.value === 'open' ? '' : e.target.value })}
              >
                <option value="open">Open (new or contacted)</option>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
                <option value="any">Any status</option>
              </select>
            </label>
            <label className="block text-sm sm:w-44">
              <span className="mb-1 block font-semibold">Entry</span>
              <select className={selectClass} value={get('kind')} onChange={(e) => set({ kind: e.target.value })}>
                <option value="">Players and teams</option>
                <option value="player">Players</option>
                <option value="team">Teams</option>
              </select>
            </label>
            <label className="col-span-2 block text-sm sm:w-40">
              <span className="mb-1 block font-semibold">Archived</span>
              <select
                className={selectClass}
                value={get('archived') || 'active'}
                onChange={(e) => set({ archived: e.target.value === 'active' ? '' : e.target.value })}
              >
                <option value="active">Not archived</option>
                <option value="archived">Archived only</option>
                <option value="all">Both</option>
              </select>
            </label>
          </div>
        </div>
      </Card>

      {error && <LoadError message={error} onRetry={fetchList} />}
      {!data && !error && (
        <Card>
          <Skeleton lines={5} label="Loading expressions of interest…" />
        </Card>
      )}
      {data && rows.length === 0 && (
        <EmptyState
          title={
            filtered
              ? 'No expressions of interest match.'
              : programme
                ? `No open expressions of interest for ${programme.code}.`
                : 'No open expressions of interest.'
          }
          action={
            <Button variant="secondary" onClick={() => setAdding(true)}>
              Add EOI
            </Button>
          }
        >
          {filtered
            ? 'Try other words, or loosen the filters.'
            : 'They arrive from the expression of interest form on the website (/interest and each programme’s page). Add one by hand for a phone call or a chat at the venue.'}
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
                {!archivedView && (
                  <Button variant="secondary" busy={busy} onClick={() => void bulk('contacted')}>
                    Mark {selected.size} contacted{programme ? ` for ${programme.code}` : ''}
                  </Button>
                )}
                <Button variant="secondary" busy={busy} onClick={() => void bulk(archivedView ? 'unarchive' : 'archive')}>
                  {archivedView ? 'Unarchive' : 'Archive'} {selected.size}
                </Button>
                <Button variant="danger" busy={busy} onClick={() => void bulk('delete')}>
                  Delete {selected.size} for good
                </Button>
              </span>
            )}
          </div>
          <ul className="divide-y divide-black/10">
            {rows.map((r) => (
              <Row key={r.id} r={r} chosen={selected.has(r.id)} onChoose={(on) => toggle(r.id, on)} highlight={get('programme')} />
            ))}
          </ul>
          {next && (
            <div className="mt-3">
              <Button variant="secondary" onClick={() => void loadMore()}>
                Show older
              </Button>
            </div>
          )}
        </Card>
      )}

      {adding && (
        <AddInterestDialog
          programmeId={get('programme') || undefined}
          onCancel={() => setAdding(false)}
          onSaved={(id) => {
            setAdding(false)
            interestChanged()
            navigate(`/interest/${id}`)
          }}
        />
      )}
    </div>
  )
}

function ChipButton({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={`m-0.5 rounded px-3 py-2 text-sm font-semibold ${on ? 'bg-brand text-white' : 'bg-black/5 text-black/80 hover:bg-black/10'}`}
    >
      {children}
    </button>
  )
}

function Row({
  r,
  chosen,
  onChoose,
  highlight,
}: {
  r: InterestListItem
  chosen: boolean
  onChoose: (on: boolean) => void
  highlight: string
}) {
  const name = personName(r.contact)
  const title = r.kind === 'team' ? (r.teamName ?? 'Team') : name
  const extra = [r.level ? (LEVEL_LABEL[r.level] ?? r.level) : null, r.position ? (POSITION_LABEL[r.position] ?? r.position) : null].filter(
    Boolean,
  )
  return (
    <li className="flex items-start gap-3 py-3">
      <input
        type="checkbox"
        className="accent-brand mt-1.5 h-4 w-4 shrink-0"
        aria-label={`Select ${title} (${r.reference})`}
        checked={chosen}
        onChange={(e) => onChoose(e.target.checked)}
      />
      <Link href={`/interest/${r.id}`} className="group min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-brand font-semibold [overflow-wrap:anywhere] group-hover:underline">{title}</span>
          <KindChip kind={r.kind} />
          {r.programmes.map((p) => (
            <span key={p.programmeId} className={highlight && highlight !== p.programmeId ? 'opacity-60' : ''}>
              <StatusChip status={p.status} code={p.code} />
            </span>
          ))}
          {r.depositCents ? <PaidChip paid={!!r.paidAt} /> : null}
          {r.archivedAt && <span className="text-xs font-semibold text-black/60 uppercase">Archived</span>}
        </span>
        <span className="mt-0.5 block text-sm text-black/80 [overflow-wrap:anywhere]">
          {r.kind === 'team' ? `Captain ${name}` : (r.contact?.email ?? r.contact?.phone ?? '')}
          {r.kind === 'team' && ` · ${r.members} ${r.members === 1 ? 'person' : 'people'}`}
          {extra.length > 0 && ` · ${extra.join(', ')}`}
          {r.depositCents ? ` · ${formatAud(r.depositCents)}` : ''}
        </span>
        <span className="mt-0.5 block text-xs text-black/60">
          {formatWhen(r.createdAt)} · {r.reference}
          {r.source === 'admin' ? ' · added by hand' : ''}
          {r.hasNote ? ' · has a note' : ''}
        </span>
      </Link>
    </li>
  )
}
