import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { addDays } from '../../lib/analytics/dates'
import {
  VITALS,
  avgPosition,
  ctr,
  fillDays,
  formatCount,
  formatPercent,
  formatVital,
  rate,
  sum,
  weightedDaily,
  type Point,
  type Rating,
  type VitalKey,
} from '../../lib/analytics/view'
import { api, formatWhen, type Me, type StatsResponse } from '../api'
import { Skeleton, Button, Card, Field, Notice, Select, errorMessage } from '../ui'

// Admin → Stats (docs/admin.md §2): traffic from GA4 and Cloudflare Web Analytics, Google search from Search
// Console, Core Web Vitals and enrolment counts. Everything comes from D1 (GET /api/admin/stats), which the
// hourly cron fills about once a day per source. Lazy-loaded from App.tsx so the charts cost nothing elsewhere.

type Source = 'ga4' | 'search_console' | 'cloudflare'

const PRESETS = [7, 28, 90, 365] as const

/** Yesterday in Sydney, the last day GA4 can have. */
const sydneyYesterday = () => addDays(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date()), -1)

const shortDate = (d: string) =>
  new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`))

// ── Chart ─────────────────────────────────────────────────────────────────────

/** One series over the range as a thin line with a hover crosshair and tooltip; null days are gaps. */
function TrendChart({
  title,
  points,
  format = formatCount,
}: {
  title: string
  points: { date: string; value: number | null }[]
  format?: (n: number) => string
}) {
  const [hover, setHover] = useState<number | null>(null)
  const id = useId()
  const W = 640
  const H = 180
  const pad = { l: 44, r: 12, t: 12, b: 26 }
  const values = points.flatMap((p) => (p.value === null ? [] : [p.value]))
  const max = Math.max(1, ...values)
  const niceMax = (() => {
    const step = 10 ** Math.floor(Math.log10(max))
    return Math.ceil(max / step) * step
  })()
  const x = (i: number) => pad.l + (points.length <= 1 ? 0 : (i / (points.length - 1)) * (W - pad.l - pad.r))
  const y = (v: number) => pad.t + (1 - v / niceMax) * (H - pad.t - pad.b)
  // Path with gaps at nulls.
  let d = ''
  let pen = false
  points.forEach((p, i) => {
    if (p.value === null) return void (pen = false)
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`
    pen = true
  })
  const ticks = [0, niceMax / 2, niceMax]
  const labelEvery = Math.max(1, Math.ceil(points.length / 6))
  const h = hover === null ? null : points[hover]
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-sm font-semibold" id={id}>
        {title}
      </figcaption>
      {values.length === 0 ? (
        <p className="rounded bg-black/5 p-6 text-center text-sm text-black/60">No data for these days yet.</p>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full touch-none"
            role="img"
            aria-labelledby={id}
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              const px = ((e.clientX - r.left) / r.width) * W
              const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (points.length - 1))
              setHover(Math.min(points.length - 1, Math.max(0, i)))
            }}
            onPointerLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="currentColor" className="text-black/10" />
                <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="fill-black/60 text-[11px]">
                  {format(t)}
                </text>
              </g>
            ))}
            {points.map((p, i) =>
              i % labelEvery === 0 ? (
                <text key={p.date} x={x(i)} y={H - 6} textAnchor="middle" className="fill-black/60 text-[11px]">
                  {shortDate(p.date)}
                </text>
              ) : null,
            )}
            <path d={d} fill="none" stroke="var(--color-brand)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {points.length <= 31 &&
              points.map((p, i) =>
                p.value === null ? null : <circle key={p.date} cx={x(i)} cy={y(p.value)} r={2.5} fill="var(--color-brand)" />,
              )}
            {h && hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="currentColor" className="text-black/30" />
                {h.value !== null && (
                  <circle cx={x(hover)} cy={y(h.value)} r={5} fill="var(--color-brand)" stroke="white" strokeWidth={2} />
                )}
              </g>
            )}
          </svg>
          {h && hover !== null && (
            <div
              className="pointer-events-none absolute top-0 rounded bg-black/85 px-2 py-1 text-xs whitespace-nowrap text-white"
              style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > points.length / 2 ? '-105%' : '5%'})` }}
            >
              {shortDate(h.date)}: <strong>{h.value === null ? 'no data' : format(h.value)}</strong>
            </div>
          )}
        </div>
      )}
    </figure>
  )
}

// ── Tables ────────────────────────────────────────────────────────────────────

type Col = { key: string; label: string; format?: (row: Record<string, number | string>) => string }

/** A ranked table with a quiet bar behind the first number, so the biggest stand out without a chart. */
function TopTable({
  rows,
  cols,
  label,
  empty = 'Nothing yet.',
}: {
  rows: Record<string, number | string>[] | undefined
  cols: Col[]
  label: string
  empty?: string
}) {
  if (!rows?.length) return <p className="text-sm text-black/60">{empty}</p>
  const first = cols[0]!
  const max = Math.max(1, ...rows.map((r) => Number(r[first.key] ?? 0)))
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs text-black/60 uppercase">
            <th className="pr-3 pb-2 font-semibold">{label}</th>
            {cols.map((c) => (
              <th key={c.key} className="pb-2 pl-3 text-right font-semibold">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.value)} className="border-t border-black/10">
              <td className="relative py-1.5 pr-3 break-all">
                <span
                  aria-hidden
                  className="bg-brand/10 absolute inset-y-1 left-0 rounded-sm"
                  style={{ width: `${(Number(r[first.key] ?? 0) / max) * 100}%` }}
                />
                <span className="relative">{String(r.value)}</span>
              </td>
              {cols.map((c) => (
                <td key={c.key} className="py-1.5 pl-3 text-right whitespace-nowrap tabular-nums">
                  {c.format ? c.format(r) : formatCount(Number(r[c.key] ?? 0))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded border border-black/10 bg-white p-4 shadow-sm">
      <div className="text-xs font-semibold text-black/60 uppercase">{label}</div>
      <div className="font-display mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {note && <div className="mt-1 text-xs text-black/60">{note}</div>}
    </div>
  )
}

const ratingStyle: Record<Rating, string> = {
  good: 'bg-green-100 text-green-900',
  'needs improvement': 'bg-amber-100 text-amber-900',
  poor: 'bg-red-100 text-red-900',
}
const ratingIcon: Record<Rating, string> = { good: '✓', 'needs improvement': '!', poor: '✕' }

// ── Sources ───────────────────────────────────────────────────────────────────

function SourceCard({ s, canFetch, onFetched }: { s: StatsResponse['sources'][number]; canFetch: boolean; onFetched: () => void }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null)
  const fetchNow = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const { result } = await api<{
        result: { status: string; rows?: number; error?: string; reason?: string; start?: string; end?: string; warning?: string }
      }>('/api/admin/stats/fetch', { body: { source: s.source } })
      if (result.status === 'ok')
        setMessage({
          kind: 'success',
          text: `Fetched ${result.start} to ${result.end}: ${formatCount(result.rows ?? 0)} numbers.${result.warning ? ` ${result.warning}` : ''}`,
        })
      else if (result.status === 'error') setMessage({ kind: 'error', text: result.error ?? 'The fetch failed.' })
      else if (result.status === 'busy') setMessage({ kind: 'info', text: 'A fetch is already running. Try again in a few minutes.' })
      else setMessage({ kind: 'info', text: result.reason ?? 'Nothing to fetch.' })
      onFetched()
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }
  const failing = !!s.lastErrorAt && (!s.lastSuccessAt || s.lastErrorAt > s.lastSuccessAt)
  const state = !s.configured
    ? 'Not connected yet'
    : !s.enabled
      ? 'Paused'
      : failing
        ? 'Last fetch failed'
        : s.lastSuccessAt
          ? 'Connected'
          : 'Waiting for the first fetch'
  const tone =
    !s.configured || !s.enabled ? 'bg-black/10 text-black/70' : failing ? 'bg-red-100 text-red-900' : 'bg-green-100 text-green-900'
  return (
    <div className="space-y-2 rounded border border-black/10 bg-white p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">{s.label}</h2>
        <span className={`rounded px-2 py-0.5 text-xs font-bold ${tone}`}>{state}</span>
      </div>
      {!s.configured ? (
        <p className="text-black/70">
          Needs {s.missing.length > 1 ? `${s.missing.slice(0, -1).join(', ')} and ${s.missing.at(-1)}` : s.missing[0]}. See docs/admin.md §2
          for the setup steps.
        </p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-black/70">
          <dt>Data up to</dt>
          <dd>
            {s.lastCompleteDate
              ? `${shortDate(s.lastCompleteDate)} (${s.timeZone === 'UTC' ? 'UTC' : s.timeZone.split('/')[1]?.replace('_', ' ')} days)`
              : '–'}
          </dd>
          <dt>Last fetched</dt>
          <dd>{s.lastSuccessAt ? formatWhen(s.lastSuccessAt) : '–'}</dd>
        </dl>
      )}
      {failing && s.lastError && <p className="text-red-800">{s.lastError}</p>}
      {message && <Notice kind={message.kind}>{message.text}</Notice>}
      {canFetch && s.configured && (
        <Button variant="secondary" busy={busy} onClick={() => void fetchNow()}>
          Fetch now
        </Button>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

const pick = (series: StatsResponse['series'], source: Source, metric: string): Point[] => series[source]?.[metric] ?? []

export default function Stats({ me }: { me: Me }) {
  const [to, setTo] = useState(sydneyYesterday)
  const [from, setFrom] = useState(() => addDays(sydneyYesterday(), -27))
  const [data, setData] = useState<StatsResponse | null>(null)
  // Which request the shown data/error answer; anything else means a load is in flight (stale data stays up).
  const [settled, setSettled] = useState<{ key: string; error: string | null } | null>(null)
  const [reloads, setReloads] = useState(0)
  const [traffic, setTraffic] = useState<'ga4' | 'cloudflare' | null>(null)
  const key = `${from}|${to}|${reloads}`
  const loading = settled?.key !== key
  const error = settled?.key === key ? settled.error : null
  const load = useCallback(() => setReloads((n) => n + 1), [])

  useEffect(() => {
    let live = true
    api<StatsResponse>(`/api/admin/stats?from=${from}&to=${to}`)
      .then((d) => {
        if (!live) return
        setData(d)
        setSettled({ key, error: null })
      })
      .catch((e) => live && setSettled({ key, error: errorMessage(e) }))
    return () => {
      live = false
    }
  }, [key, from, to])

  const preset = (days: number) => {
    const end = sydneyYesterday()
    setTo(end)
    setFrom(addDays(end, -(days - 1)))
  }

  const view = useMemo(() => {
    if (!data) return null
    const has = (s: Source) => data.sources.find((x) => x.source === s)?.hasData ?? false
    const trafficSource = traffic ?? (has('ga4') ? 'ga4' : has('cloudflare') ? 'cloudflare' : 'ga4')
    const s = data.series
    const visitors = trafficSource === 'ga4' ? pick(s, 'ga4', 'activeUsers') : pick(s, 'cloudflare', 'visits')
    const views = trafficSource === 'ga4' ? pick(s, 'ga4', 'screenPageViews') : pick(s, 'cloudflare', 'pageviews')
    const clicks = sum(pick(s, 'search_console', 'clicks'))
    const impressions = sum(pick(s, 'search_console', 'impressions'))
    const positionSum = sum(pick(s, 'search_console', 'positionSum'))
    const samples = pick(s, 'cloudflare', 'vitalsSamples')
    const vitals = (Object.keys(VITALS) as VitalKey[]).map((k) => ({ k, v: weightedDaily(pick(s, 'cloudflare', k), samples) }))
    return { has, trafficSource, visitors, views, clicks, impressions, positionSum, vitals, sessions: sum(pick(s, 'ga4', 'sessions')) }
  }, [data, traffic])

  const searchCols: Col[] = [
    { key: 'clicks', label: 'Clicks' },
    { key: 'impressions', label: 'Impressions' },
    { key: 'ctr', label: 'CTR', format: (r) => formatPercent(ctr(Number(r.clicks), Number(r.impressions))) },
    { key: 'position', label: 'Position', format: (r) => avgPosition(Number(r.positionSum), Number(r.impressions))?.toFixed(1) ?? '–' },
  ]

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Stats</h1>
          <p className="text-sm text-black/60">Updated about once a day. Days are each source's own (Sydney for Google Analytics).</p>
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            load()
          }}
        >
          <div className="flex gap-1" role="group" aria-label="Quick ranges">
            {PRESETS.map((d) => (
              <Button
                key={d}
                variant={addDays(to, -(d - 1)) === from && to === sydneyYesterday() ? 'primary' : 'secondary'}
                onClick={() => preset(d)}
              >
                {d === 365 ? '1 year' : `${d} days`}
              </Button>
            ))}
          </div>
          <div className="w-40">
            <Field label="From" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          </div>
          <div className="w-40">
            <Field label="To" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} />
          </div>
        </form>
      </div>

      {error && <Notice kind="error">{error}</Notice>}
      {!data ? (
        <Skeleton />
      ) : (
        <div className={`space-y-6 ${loading ? 'opacity-60' : ''}`}>
          <section aria-label="Data sources" className="grid gap-4 md:grid-cols-3">
            {data.sources.map((s) => (
              <SourceCard key={s.source} s={s} canFetch={data.canFetch} onFetched={load} />
            ))}
          </section>
          {data.sources.some((s) => !s.configured) && data.canFetch && (
            <p className="text-sm text-black/70">
              Connect a source under{' '}
              <Link href="/settings" className="text-brand underline">
                Settings → Analytics
              </Link>{' '}
              (ids), plus its Worker secret (see docs/admin.md §2).
            </p>
          )}

          {view && (
            <>
              <Card
                title="Visitors and page views"
                actions={
                  view.has('ga4') && view.has('cloudflare') ? (
                    <div className="w-56">
                      <Select
                        label="Source"
                        value={view.trafficSource}
                        onChange={(e) => setTraffic(e.target.value as 'ga4' | 'cloudflare')}
                      >
                        <option value="ga4">Google Analytics</option>
                        <option value="cloudflare">Cloudflare Web Analytics</option>
                      </Select>
                    </div>
                  ) : undefined
                }
              >
                <div className="mb-6 grid gap-3 sm:grid-cols-3">
                  <Tile
                    label={view.trafficSource === 'ga4' ? 'Visitors' : 'Visits'}
                    value={formatCount(sum(view.visitors))}
                    note={
                      view.trafficSource === 'ga4'
                        ? 'Daily visitors added up (someone back on 3 days counts 3 times).'
                        : 'Visits that started on the site.'
                    }
                  />
                  <Tile label="Page views" value={formatCount(sum(view.views))} />
                  {view.trafficSource === 'ga4' ? (
                    <Tile label="Sessions" value={formatCount(view.sessions)} />
                  ) : (
                    <Tile label="Pages per visit" value={sum(view.visitors) ? (sum(view.views) / sum(view.visitors)).toFixed(1) : '–'} />
                  )}
                </div>
                <div className="grid gap-6 lg:grid-cols-2">
                  <TrendChart
                    title={view.trafficSource === 'ga4' ? 'Visitors per day' : 'Visits per day'}
                    points={fillDays(view.visitors, data.range.from, data.range.to)}
                  />
                  <TrendChart title="Page views per day" points={fillDays(view.views, data.range.from, data.range.to)} />
                </div>
              </Card>

              <div className="grid gap-6 lg:grid-cols-2">
                <Card title="Top pages">
                  {view.trafficSource === 'ga4' ? (
                    <TopTable
                      label="Page"
                      rows={data.top.ga4Pages}
                      cols={[
                        { key: 'screenPageViews', label: 'Views' },
                        { key: 'activeUsers', label: 'Visitors' },
                      ]}
                    />
                  ) : (
                    <TopTable
                      label="Page"
                      rows={data.top.cfPaths}
                      cols={[
                        { key: 'pageviews', label: 'Views' },
                        { key: 'visits', label: 'Visits' },
                      ]}
                    />
                  )}
                </Card>
                <Card title="Where visitors come from">
                  {view.trafficSource === 'ga4' ? (
                    <div className="space-y-6">
                      <TopTable label="Channel" rows={data.top.ga4Channels} cols={[{ key: 'sessions', label: 'Sessions' }]} />
                      <TopTable label="Source" rows={data.top.ga4Sources} cols={[{ key: 'sessions', label: 'Sessions' }]} />
                    </div>
                  ) : (
                    <TopTable label="Referrer" rows={data.top.cfReferrers} cols={[{ key: 'visits', label: 'Visits' }]} />
                  )}
                </Card>
                <Card title="Devices">
                  {view.trafficSource === 'ga4' ? (
                    <TopTable
                      label="Device"
                      rows={data.top.ga4Devices}
                      cols={[
                        { key: 'activeUsers', label: 'Visitors' },
                        { key: 'sessions', label: 'Sessions' },
                      ]}
                    />
                  ) : (
                    <TopTable label="Device" rows={data.top.cfDevices} cols={[{ key: 'visits', label: 'Visits' }]} />
                  )}
                </Card>
                <Card title="Countries">
                  {view.trafficSource === 'ga4' ? (
                    <TopTable label="Country" rows={data.top.ga4Countries} cols={[{ key: 'activeUsers', label: 'Visitors' }]} />
                  ) : (
                    <TopTable label="Country" rows={data.top.cfCountries} cols={[{ key: 'visits', label: 'Visits' }]} />
                  )}
                </Card>
              </div>

              <Card title="Google search">
                <div className="mb-6 grid gap-3 sm:grid-cols-4">
                  <Tile label="Clicks" value={formatCount(view.clicks)} />
                  <Tile label="Impressions" value={formatCount(view.impressions)} />
                  <Tile label="Click-through rate" value={formatPercent(ctr(view.clicks, view.impressions))} />
                  <Tile label="Average position" value={avgPosition(view.positionSum, view.impressions)?.toFixed(1) ?? '–'} />
                </div>
                <div className="mb-6">
                  <TrendChart
                    title="Clicks from Google per day"
                    points={fillDays(pick(data.series, 'search_console', 'clicks'), data.range.from, data.range.to)}
                  />
                </div>
                <div className="grid gap-6 lg:grid-cols-2">
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">Searches</h3>
                    <TopTable label="Query" rows={data.top.scQueries} cols={searchCols} />
                  </div>
                  <div>
                    <h3 className="mb-2 text-sm font-semibold">Pages</h3>
                    <TopTable label="Page" rows={data.top.scPages} cols={searchCols} />
                  </div>
                </div>
                <p className="mt-4 text-xs text-black/60">
                  Search Console holds back very rare searches for privacy, and its last 2–3 days fill in late.
                </p>
              </Card>

              <Card title="Site speed (Core Web Vitals)">
                {view.vitals.every((x) => x.v === null) ? (
                  <p className="text-sm text-black/60">
                    Comes from Cloudflare Web Analytics once it's connected and the beacon is on the live site.
                  </p>
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
                      {view.vitals.map(({ k, v }) => {
                        const r = v === null ? null : rate(k, v)
                        return (
                          <div key={k} className="rounded border border-black/10 p-3">
                            <div className="text-xs font-semibold text-black/60 uppercase" title={VITALS[k].label}>
                              {VITALS[k].short}
                            </div>
                            <div className="font-display mt-1 text-xl font-bold tabular-nums">{v === null ? '–' : formatVital(k, v)}</div>
                            {r && (
                              <span className={`mt-1 inline-block rounded px-1.5 py-0.5 text-xs font-bold ${ratingStyle[r]}`}>
                                <span aria-hidden>{ratingIcon[r]} </span>
                                {r}
                              </span>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    <div className="mt-6">
                      <TrendChart
                        title="Largest Contentful Paint (p75) per day"
                        points={fillDays(pick(data.series, 'cloudflare', 'lcpP75'), data.range.from, data.range.to)}
                        format={(n) => formatVital('lcpP75', n)}
                      />
                    </div>
                    <p className="mt-2 text-xs text-black/60">
                      The 75th percentile of real visits (what Google uses). Good is LCP ≤ 2.5 s, INP ≤ 200 ms and CLS ≤ 0.1.
                    </p>
                  </>
                )}
              </Card>
            </>
          )}

          <Card title="Enrolments">
            {data.business === null ? (
              <p className="text-sm text-black/60">Only admins and owners see enrolment numbers.</p>
            ) : data.business.length === 0 ? (
              <p className="text-sm text-black/60">
                No enrolments yet. Sign-ups, waitlists and paid/unpaid counts per programme will show here once enrolment opens.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs text-black/60 uppercase">
                      <th className="pr-3 pb-2 font-semibold">Programme</th>
                      <th className="pr-3 pb-2 font-semibold">Status</th>
                      <th className="pb-2 pl-3 text-right font-semibold">Players</th>
                      <th className="pb-2 pl-3 text-right font-semibold">Teams</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.business.map((b) => (
                      <tr key={`${b.programmeId ?? b.programme}-${b.status}`} className="border-t border-black/10">
                        <td className="py-1.5 pr-3">{b.programme}</td>
                        <td className="py-1.5 pr-3">{b.status.replace(/_/g, ' ')}</td>
                        <td className="py-1.5 pl-3 text-right tabular-nums">{formatCount(b.registrations)}</td>
                        <td className="py-1.5 pl-3 text-right tabular-nums">{formatCount(b.teams)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {me.user.role !== 'editor' && data.fetches.length > 0 && (
            <details className="rounded border border-black/10 bg-white p-4 text-sm shadow-sm">
              <summary className="cursor-pointer font-semibold">Recent fetches</summary>
              <table className="mt-3 w-full text-left text-xs">
                <thead>
                  <tr className="text-black/60 uppercase">
                    <th className="pr-3 pb-1">When</th>
                    <th className="pr-3 pb-1">Source</th>
                    <th className="pr-3 pb-1">Days</th>
                    <th className="pr-3 pb-1">Result</th>
                    <th className="pb-1 text-right">Numbers</th>
                  </tr>
                </thead>
                <tbody>
                  {data.fetches.map((f) => (
                    <tr key={f.id} className="border-t border-black/10 align-top">
                      <td className="py-1 pr-3 whitespace-nowrap">{formatWhen(f.startedAt)}</td>
                      <td className="py-1 pr-3">{data.sources.find((s) => s.source === f.source)?.label ?? f.source}</td>
                      <td className="py-1 pr-3 whitespace-nowrap">
                        {f.rangeStart} – {f.rangeEnd}
                      </td>
                      <td className="py-1 pr-3">
                        {f.status}
                        {f.error ? `: ${f.error}` : ''}
                      </td>
                      <td className="py-1 text-right tabular-nums">{formatCount(f.rowsWritten)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}
    </div>
  )
}
