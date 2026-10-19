import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearch } from 'wouter'
import { api, formatWhen } from '../api'
import type { PlayerList, PlayerListItem } from '../../server/players/admin'
import { Button, Card, EmailText, EmptyState, Field, LoadError, Notice, Select, Skeleton, TabLinks, errorMessage, toast } from '../ui'
import { PlayerDialog } from './PlayerDialog'
import { Chip, GROUP_CHIPS, GroupChip, LEVEL_LABEL, POSITION_LABEL, fullName, genderLabel, shortDate, telHref, type Pool } from './shared'

// Admin → Players (docs/admin.md §3.16, docs/api/players.md): competition and training players, kept apart on
// purpose. Competition players are grouped like the season builder's picker (New interest, Last season, Past
// players, Retired), for one league or across all of them; training players filter by what they enrolled in. The
// filters live in the URL, so a reload or a shared link shows the same list.

const QUERY_KEYS = ['q', 'group', 'league', 'programme', 'retired', 'sort', 'page'] as const
type QueryKey = (typeof QUERY_KEYS)[number]

const TABS = [
  { key: 'competition', label: 'Competition' },
  { key: 'training', label: 'Training' },
]

export function Players({ pool }: { pool: Pool }) {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const params = useMemo(() => new URLSearchParams(search), [search])
  const get = (k: QueryKey) => params.get(k) ?? ''
  const [q, setQ] = useState(get('q'))
  const [adding, setAdding] = useState(false)
  const [loaded, setLoaded] = useState<{ key: string; data: PlayerList | null; error: string | null }>({ key: '', data: null, error: null })
  const [retry, setRetry] = useState(0)

  const set = (patch: Partial<Record<QueryKey, string>>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    // Any filter change starts again at page 1.
    if (patch.page === undefined) next.delete('page')
    const qs = next.toString()
    navigate(qs ? `${location}?${qs}` : location, { replace: true })
  }

  // Search as you type, after a pause.
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim() !== get('q')) set({ q: q.trim() })
    }, 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const query = useMemo(() => {
    const p = new URLSearchParams()
    p.set('pool', pool)
    for (const k of QUERY_KEYS) {
      const v = params.get(k)
      if (!v) continue
      if (pool === 'training' && (k === 'group' || k === 'league')) continue
      if (pool === 'competition' && k === 'programme') continue
      p.set(k, v)
    }
    return p.toString()
  }, [params, pool])

  useEffect(() => {
    let live = true
    api<PlayerList>(`/api/admin/players?${query}`)
      .then((d) => live && setLoaded({ key: query, data: d, error: null }))
      .catch((e: unknown) => live && setLoaded((l) => ({ ...l, key: query, error: errorMessage(e) })))
    return () => {
      live = false
    }
  }, [query, retry])

  const { data, error } = loaded
  const loading = loaded.key !== query
  const group = get('group') || 'all'
  const filtered = !!(get('q') || get('league') || get('programme') || (get('retired') && get('retired') !== 'hide') || group !== 'all')

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Players</h1>
          <p className="text-sm text-black/70">
            Everyone who’s sent a form, enrolled or been added by hand. Competition and training players are kept separate: someone in both
            is two records.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`/api/admin/players/export.csv?${query}`}
            className="border-brand text-brand hover:bg-brand/5 inline-flex rounded border bg-white px-4 py-2 text-sm font-semibold"
            download
          >
            Export CSV
          </a>
          <Button onClick={() => setAdding(true)}>Add player</Button>
        </div>
      </div>

      <TabLinks label="Players" tabs={TABS} active={pool} href={(k) => `/players/${k}`} />

      {pool === 'competition' && (
        <div className="space-y-2">
          <div role="group" aria-label="Group" className="flex flex-wrap gap-1">
            {GROUP_CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                aria-pressed={group === c.key}
                onClick={() => set({ group: c.key === 'all' ? '' : c.key })}
                className={`rounded px-3 py-2 text-sm font-semibold ${group === c.key ? 'bg-brand text-white' : 'bg-white text-black/80 hover:bg-black/5'}`}
              >
                {c.label}
                {data?.groupCounts && <span className="ml-1 font-normal">({data.groupCounts[c.key]})</span>}
              </button>
            ))}
          </div>
          {data && (
            <p className="text-xs text-black/60">
              {data.league
                ? data.lastSeason
                  ? `${data.league.code}: last season ${data.lastSeason.name}; new interest is EOIs sent since ${shortDate(data.lastSeason.startDate)}.`
                  : `${data.league.code} hasn’t had a season yet, so every open EOI counts as new interest.`
                : 'Groups are across all leagues: “Last season” is anyone on a league’s most recent roster. Pick a league to see its own.'}
            </p>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2 lg:col-span-1">
          <Field label="Search" type="search" value={q} placeholder="Name, email or phone" onChange={(e) => setQ(e.target.value)} />
        </div>
        {pool === 'competition' ? (
          <Select label="League" value={get('league')} onChange={(e) => set({ league: e.target.value })}>
            <option value="">All leagues</option>
            {data?.programmes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.code})
              </option>
            ))}
          </Select>
        ) : (
          <Select label="Enrolled in" value={get('programme')} onChange={(e) => set({ programme: e.target.value })}>
            <option value="">Anything</option>
            {data?.programmes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
        {(pool === 'training' || group === 'all') && (
          <Select
            label="Retired players"
            value={get('retired') || 'hide'}
            onChange={(e) => set({ retired: e.target.value === 'hide' ? '' : e.target.value })}
          >
            <option value="hide">Hide</option>
            <option value="any">Show too</option>
            <option value="only">Only retired</option>
          </Select>
        )}
        <Select label="Sort" value={get('sort') || 'name'} onChange={(e) => set({ sort: e.target.value === 'name' ? '' : e.target.value })}>
          <option value="name">By name</option>
          <option value="newest">Newest first</option>
          <option value="updated">Recently changed</option>
        </Select>
      </div>

      {error && !loading && <LoadError message={error} onRetry={() => setRetry((n) => n + 1)} />}
      {data?.truncated && (
        <Notice kind="warning">
          There are more competition players than this screen loads at once; the oldest aren’t listed. Search to find them.
        </Notice>
      )}
      {!data && !error && (
        <Card>
          <Skeleton lines={6} label="Loading players…" />
        </Card>
      )}
      {data && data.rows.length === 0 && (
        <EmptyState title={filtered ? 'No players match.' : `No ${pool} players yet.`}>
          {filtered
            ? 'Try other words, or clear a filter.'
            : pool === 'competition'
              ? 'People who send an expression of interest, are put on a season roster or are added by hand appear here.'
              : 'People who enrol in training or a development programme, or are added by hand, appear here.'}
        </EmptyState>
      )}
      {data && data.rows.length > 0 && (
        <Card>
          <p className="mb-2 text-sm text-black/70" aria-live="polite">
            {loading ? 'Loading…' : `${data.total} ${data.total === 1 ? 'player' : 'players'}`}
          </p>
          <div className="overflow-x-auto">
            <table className={`w-full text-sm ${loading ? 'opacity-60' : ''}`}>
              <thead>
                <tr className="border-b border-black/10 text-left">
                  <th className="py-2 pr-3 font-semibold">Name</th>
                  <th className="hidden py-2 pr-3 font-semibold sm:table-cell">Contact</th>
                  {pool === 'competition' ? (
                    <>
                      <th className="hidden py-2 pr-3 font-semibold sm:table-cell">Last played</th>
                      <th className="hidden py-2 pr-3 font-semibold md:table-cell">Interest</th>
                    </>
                  ) : (
                    <th className="hidden py-2 pr-3 font-semibold sm:table-cell">Enrolments</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {data.rows.map((r) => (
                  <Row key={r.id} r={r} pool={pool} />
                ))}
              </tbody>
            </table>
          </div>
          {data.pages > 1 && (
            <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center gap-3">
              <Button
                variant="secondary"
                disabled={data.page <= 1}
                onClick={() => set({ page: data.page - 1 > 1 ? String(data.page - 1) : '' })}
              >
                Previous
              </Button>
              <span className="text-sm text-black/70">
                Page {data.page} of {data.pages}
              </span>
              <Button variant="secondary" disabled={data.page >= data.pages} onClick={() => set({ page: String(data.page + 1) })}>
                Next
              </Button>
            </nav>
          )}
        </Card>
      )}

      {adding && (
        <PlayerDialog
          pool={pool}
          onCancel={() => setAdding(false)}
          onSaved={(p) => {
            setAdding(false)
            toast(`${fullName(p.player)} added.`)
            navigate(`/players/${pool}/${p.player.id}`)
          }}
        />
      )}
    </div>
  )
}

function Contact({ r }: { r: PlayerListItem }) {
  return (
    <span className="flex flex-col">
      {r.email ? <EmailText email={r.email} /> : <span className="text-black/60">No email</span>}
      {r.phone && (
        <a href={telHref(r.phone)} className="text-brand w-fit underline-offset-2 hover:underline">
          {r.phone}
        </a>
      )}
    </span>
  )
}

function lastPlayed(r: PlayerListItem) {
  return r.lastSpot ? `${r.lastSpot.teamName}, ${r.lastSpot.seasonName}` : ''
}

function interestText(r: PlayerListItem) {
  if (!r.interest) return ''
  const bits = [
    r.interest.kind === 'team' ? `Team${r.interest.teamName ? ` ${r.interest.teamName}` : ''}` : 'Player',
    r.interest.level ? (LEVEL_LABEL[r.interest.level] ?? r.interest.level) : '',
    r.interest.position ? (POSITION_LABEL[r.interest.position] ?? r.interest.position) : '',
  ].filter(Boolean)
  return bits.join(' · ')
}

function Row({ r, pool }: { r: PlayerListItem; pool: Pool }) {
  const gender = genderLabel(r.gender)
  const enrolments = r.enrolments
    ? `${r.enrolments} ${r.enrolments === 1 ? 'enrolment' : 'enrolments'}${r.lastEnrolment ? `, latest ${r.lastEnrolment.programmeName}: ${r.lastEnrolment.label}` : ''}`
    : 'None yet'
  return (
    <tr className="align-top">
      <td className="py-2.5 pr-3">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link href={`/players/${pool}/${r.id}`} className="text-brand font-semibold underline-offset-2 hover:underline">
            {fullName(r)}
          </Link>
          {r.group && r.group !== 'other' && <GroupChip group={r.group} />}
          {r.retiredAt && r.group !== 'retired' && <Chip>Retired</Chip>}
        </span>
        {gender && <span className="block text-xs text-black/60">{gender}</span>}
        {/* Phones: the other columns, as small lines. */}
        <span className="mt-1 block space-y-0.5 text-xs text-black/70 sm:hidden">
          <Contact r={r} />
          {pool === 'competition' && lastPlayed(r) && <span className="block">Last: {lastPlayed(r)}</span>}
          {pool === 'competition' && interestText(r) && <span className="block">EOI: {interestText(r)}</span>}
          {pool === 'training' && <span className="block">{enrolments}</span>}
        </span>
      </td>
      <td className="hidden py-2.5 pr-3 sm:table-cell">
        <Contact r={r} />
      </td>
      {pool === 'competition' ? (
        <>
          <td className="hidden py-2.5 pr-3 sm:table-cell">
            {lastPlayed(r) || <span className="text-black/60">Not on a roster yet</span>}
          </td>
          <td className="hidden py-2.5 pr-3 md:table-cell">
            {r.interest ? (
              <Link href={`/interest/${r.interest.interestId}`} className="text-brand underline-offset-2 hover:underline">
                {interestText(r)}
              </Link>
            ) : (
              ''
            )}
            {r.interest && <span className="block text-xs text-black/60">Sent {formatWhen(r.interest.createdAt)}</span>}
          </td>
        </>
      ) : (
        <td className="hidden py-2.5 pr-3 sm:table-cell">{enrolments}</td>
      )}
    </tr>
  )
}
