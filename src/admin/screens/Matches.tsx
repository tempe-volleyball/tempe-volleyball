import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useSearch } from 'wouter'
import { MATCH_STATUS_LABEL, addDays, formatLong, weekdayName } from '../../lib/fixtures'
import { sydneyDate } from '../../lib/time'
import { api, type MatchList, type MatchListRow } from '../api'
import { Skeleton, Button, Card, Notice, errorMessage } from '../ui'

// Every game across leagues (docs/admin.md §1 "Match list"): "everything on this Thursday", a team's games, one
// court's night. Filters live in the URL so a view can be bookmarked or shared. Each game links to its match day's
// results. Reads GET /api/admin/matches.

const FILTERS = ['from', 'to', 'league', 'season', 'team', 'venue', 'court', 'status', 'drafts'] as const
type Filter = (typeof FILTERS)[number]

const selectClass = 'rounded border border-black/20 bg-white px-2 py-1.5 text-sm'

const sideName = (s: MatchListRow['home']) => (!s ? '' : 'name' in s ? s.name : `(${s.label})`)

export function Matches() {
  const search = useSearch()
  const [location, navigate] = useLocation()
  const params = useMemo(() => new URLSearchParams(search), [search])
  const [today] = useState(() => sydneyDate(new Date()))
  const get = (k: Filter) => params.get(k) ?? ''
  const from = get('from') || today
  const to = get('to') || addDays(from, 6)
  // What the last request answered, and for which query: loading is "the answer isn't for this query yet".
  const [loaded, setLoaded] = useState<{ key: string; data: MatchList | null; error: string | null }>({ key: '', data: null, error: null })

  const set = (patch: Partial<Record<Filter, string>>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v)
      else next.delete(k)
    }
    // A season belongs to one league: picking another league clears it.
    if (patch.league !== undefined) next.delete('season')
    if (patch.venue !== undefined) next.delete('court')
    navigate(`${location}?${next.toString()}`, { replace: true })
  }

  const query = useMemo(() => {
    const q = new URLSearchParams(params)
    q.set('from', from)
    q.set('to', to)
    return q.toString()
  }, [params, from, to])
  useEffect(() => {
    let live = true
    api<MatchList>(`/api/admin/matches?${query}`)
      .then((d) => live && setLoaded({ key: query, data: d, error: null }))
      .catch((e: unknown) => live && setLoaded((l) => ({ ...l, key: query, error: errorMessage(e) })))
    return () => {
      live = false
    }
  }, [query])
  const { data, error } = loaded
  const loading = loaded.key !== query

  const o = data?.options
  const byDate = useMemo(() => {
    const m = new Map<string, MatchListRow[]>()
    for (const r of data?.rows ?? []) m.set(r.date, [...(m.get(r.date) ?? []), r])
    return [...m]
  }, [data])
  const range = (a: string, b: string) => set({ from: a, to: b })
  const activeFilters = FILTERS.filter((k) => k !== 'from' && k !== 'to' && get(k)).length
  const [showFilters, setShowFilters] = useState(false)
  // The next game night of each weekday, for "everything on this Thursday".
  const nextWeekday = (day: number) => {
    let d = today
    while (new Date(`${d}T00:00:00Z`).getUTCDay() !== day) d = addDays(d, 1)
    return d
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Matches</h1>
        <p className="text-sm text-black/60">
          Every game across the leagues. Pick a night, a team or a court; each game links to its results.
        </p>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-semibold">From</span>
            <input
              type="date"
              className={selectClass}
              value={from}
              onChange={(e) => set({ from: e.target.value, to: e.target.value > to ? e.target.value : to })}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-semibold">To</span>
            <input type="date" className={selectClass} value={to} min={from} onChange={(e) => set({ to: e.target.value })} />
          </label>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => range(today, today)}>
              Today
            </Button>
            <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => range(today, addDays(today, 6))}>
              Next 7 days
            </Button>
            {[4, 5, 6, 0].map((d) => {
              const date = nextWeekday(d)
              return (
                <Button
                  key={d}
                  variant="secondary"
                  className="px-2 py-1 text-xs"
                  onClick={() => range(date, date)}
                  title={formatLong(date)}
                >
                  {weekdayName(date)}
                </Button>
              )
            })}
            <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => range(addDays(from, -7), addDays(to, -7))}>
              ← Week
            </Button>
            <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => range(addDays(from, 7), addDays(to, 7))}>
              Week →
            </Button>
          </div>
        </div>
        {/* Phones: the filters fold away behind one button so tonight's games are on the first screen. */}
        <button
          type="button"
          className="text-brand mt-3 text-sm font-semibold underline underline-offset-2 sm:hidden"
          aria-expanded={showFilters}
          aria-controls="match-filters"
          onClick={() => setShowFilters((v) => !v)}
        >
          {showFilters ? 'Hide filters' : `Filters${activeFilters ? ` (${activeFilters} on)` : ''}`}
        </button>
        <div id="match-filters" className={`mt-3 flex-wrap items-end gap-3 ${showFilters ? 'flex' : 'hidden sm:flex'}`}>
          <select className={selectClass} aria-label="League" value={get('league')} onChange={(e) => set({ league: e.target.value })}>
            <option value="">All leagues</option>
            {o?.leagues.map((l) => (
              <option key={l.id} value={l.id}>
                {l.code}
              </option>
            ))}
          </select>
          <select className={selectClass} aria-label="Season" value={get('season')} onChange={(e) => set({ season: e.target.value })}>
            <option value="">All seasons</option>
            {o?.seasons
              .filter((s) => !get('league') || s.leagueId === get('league'))
              .filter((s) => get('drafts') === '1' || s.status !== 'draft')
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.status === 'draft' ? ' (draft)' : ''}
                </option>
              ))}
          </select>
          <select className={selectClass} aria-label="Team" value={get('team')} onChange={(e) => set({ team: e.target.value })}>
            <option value="">All teams</option>
            {o?.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select className={selectClass} aria-label="Venue" value={get('venue')} onChange={(e) => set({ venue: e.target.value })}>
            <option value="">All venues</option>
            {o?.venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <select className={selectClass} aria-label="Court" value={get('court')} onChange={(e) => set({ court: e.target.value })}>
            <option value="">All courts</option>
            {o?.courts
              .filter((c) => !get('venue') || c.venueId === get('venue'))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {get('venue') ? '' : ` (${o.venues.find((v) => v.id === c.venueId)?.name ?? ''})`}
                </option>
              ))}
          </select>
          <select className={selectClass} aria-label="Status" value={get('status')} onChange={(e) => set({ status: e.target.value })}>
            <option value="">Any status</option>
            {Object.entries(MATCH_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              className="accent-brand"
              checked={get('drafts') === '1'}
              onChange={(e) => set({ drafts: e.target.checked ? '1' : '' })}
            />
            Include draft seasons
          </label>
          {FILTERS.some((k) => k !== 'from' && k !== 'to' && get(k)) && (
            <Button
              variant="link"
              className="text-sm"
              onClick={() => set({ league: '', season: '', team: '', venue: '', court: '', status: '', drafts: '' })}
            >
              Clear filters
            </Button>
          )}
        </div>
      </Card>

      {error && <Notice kind="error">{error}</Notice>}
      {data?.truncated && <Notice kind="warning">Showing the first 500 games. Narrow the dates or filters to see the rest.</Notice>}
      {loading && !data && <Skeleton />}
      {data && byDate.length === 0 && !loading && <p className="text-sm text-black/60">No games in that range.</p>}

      {byDate.map(([date, rows]) => (
        <section key={date} className="overflow-hidden rounded border border-black/10 bg-white shadow-sm">
          <h2 className="border-b border-black/10 px-4 py-2 font-bold">
            {formatLong(date)} <span className="text-sm font-normal text-black/60">· {rows.length} games</span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs tracking-wider text-black/60 uppercase">
                  <th className="px-3 py-1.5">Time</th>
                  <th className="hidden px-3 py-1.5 sm:table-cell">League</th>
                  <th className="hidden px-3 py-1.5 sm:table-cell">Court</th>
                  <th className="px-3 py-1.5">Game</th>
                  <th className="hidden px-3 py-1.5 sm:table-cell">Duty</th>
                  <th className="px-3 py-1.5">Result</th>
                  <th className="px-3 py-1.5">
                    <span className="sr-only">Link</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {rows.map((r) => (
                  <tr key={r.id} className={r.status === 'cancelled' || r.status === 'postponed' ? 'bg-black/5' : ''}>
                    <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">{r.startTime ?? ''}</td>
                    <td className="hidden px-3 py-1.5 whitespace-nowrap sm:table-cell">
                      <span className="font-semibold">{r.leagueCode}</span>
                      {r.seasonStatus === 'draft' && <span className="ml-1 text-xs text-black/60">(draft)</span>}
                    </td>
                    <td className="hidden px-3 py-1.5 whitespace-nowrap sm:table-cell">
                      {r.courtName ?? '—'}
                      {r.venueName && !get('venue') && <span className="block text-xs text-black/60">{r.venueName}</span>}
                    </td>
                    <td className="px-3 py-1.5">
                      {r.title && <span className="text-brand mr-1 text-xs font-bold uppercase">{r.title}</span>}
                      {sideName(r.home)} <span className="text-black/60">v</span> {sideName(r.away)}
                      {/* Phones: league, court and duty under the game instead of three more columns. */}
                      <span className="block text-xs text-black/60 sm:hidden">
                        {r.leagueCode}
                        {r.seasonStatus === 'draft' ? ' (draft)' : ''} · {r.courtName ?? '—'}
                        {r.duty ? ` · duty ${sideName(r.duty)}` : ''}
                      </span>
                    </td>
                    <td className="hidden px-3 py-1.5 sm:table-cell">{sideName(r.duty)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      {r.result && r.result.homeSets !== null ? (
                        <span className="font-semibold tabular-nums">
                          {r.result.homeSets} – {r.result.awaySets}
                        </span>
                      ) : r.status !== 'scheduled' && r.status !== 'played' ? (
                        <span className="rounded bg-black/10 px-1.5 text-xs font-semibold">{MATCH_STATUS_LABEL[r.status]}</span>
                      ) : (
                        ''
                      )}
                      {r.status === 'forfeit' && <span className="ml-1 text-xs text-red-800">(forfeit)</span>}
                      {r.unpublished && <span className="ml-1 text-xs text-black/60">· unpublished changes</span>}
                      {r.statusNote && <span className="block text-xs text-black/60 italic">{r.statusNote}</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      <Link
                        href={`/seasons/${r.seasonId}/results#results-${r.matchDayId}`}
                        className="text-brand -my-2 inline-block py-2 text-xs font-semibold underline"
                      >
                        Results →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  )
}
