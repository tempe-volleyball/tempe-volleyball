import { and, count, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { runBatch, type AppDb } from '../db'
import {
  analyticsDaily,
  analyticsFetches,
  analyticsState,
  groups,
  products,
  programmes,
  registrations,
  type AnalyticsFetch,
  type AnalyticsState,
} from '../db/schema'
import { HttpError } from '../http'
import { addDays, daysBetween, isIsoDate } from '../../lib/analytics/dates'
import { sourceLabel, sources, type Source } from '../../lib/analytics/rows'
import type { AnalyticsSettings } from '../../lib/content/settings'
import { SOURCE_TIME_ZONE, sourceStatus, sourceYesterday, type AnalyticsSecrets, type SourceStatus } from './fetch'

// The admin Stats page's data, read from D1 only (the daily cron fills it). One batch of ~20 indexed queries.
// Rows read per view: about (days × 50 values × metrics) per breakdown, ~100k for 90 days; fine for an admin page.

export const MAX_RANGE_DAYS = 400
export const DEFAULT_RANGE_DAYS = 28
const TOP_LIMIT = 20

export type Range = { from: string; to: string }

/** ?from=&to= (YYYY-MM-DD), defaulting to the 28 days up to yesterday (Sydney). */
export function parseRange(url: URL, now: Date): Range {
  const to = url.searchParams.get('to') || sourceYesterday('ga4', now)
  const from = url.searchParams.get('from') || addDays(to, -(DEFAULT_RANGE_DAYS - 1))
  if (!isIsoDate(from) || !isIsoDate(to)) throw new HttpError(400, 'invalid_input', 'Dates are YYYY-MM-DD.')
  const days = daysBetween(from, to) + 1
  if (days < 1) throw new HttpError(400, 'invalid_input', 'The start date is after the end date.')
  if (days > MAX_RANGE_DAYS) throw new HttpError(400, 'invalid_input', `Pick at most ${MAX_RANGE_DAYS} days.`)
  return { from, to }
}

/** One breakdown: a dimension of a source, the metrics summed per value, and the metric it's ranked by. */
export type Breakdown = { key: string; source: Source; dimension: string; metrics: string[]; rank: string }

export const BREAKDOWNS: Breakdown[] = [
  { key: 'ga4Pages', source: 'ga4', dimension: 'pagePath', metrics: ['screenPageViews', 'activeUsers'], rank: 'screenPageViews' },
  { key: 'ga4Channels', source: 'ga4', dimension: 'sessionDefaultChannelGroup', metrics: ['sessions'], rank: 'sessions' },
  { key: 'ga4Sources', source: 'ga4', dimension: 'sessionSource', metrics: ['sessions'], rank: 'sessions' },
  { key: 'ga4Devices', source: 'ga4', dimension: 'deviceCategory', metrics: ['activeUsers', 'sessions'], rank: 'activeUsers' },
  { key: 'ga4Countries', source: 'ga4', dimension: 'country', metrics: ['activeUsers'], rank: 'activeUsers' },
  { key: 'scQueries', source: 'search_console', dimension: 'query', metrics: ['clicks', 'impressions', 'positionSum'], rank: 'clicks' },
  { key: 'scPages', source: 'search_console', dimension: 'page', metrics: ['clicks', 'impressions', 'positionSum'], rank: 'clicks' },
  { key: 'scDevices', source: 'search_console', dimension: 'device', metrics: ['clicks', 'impressions', 'positionSum'], rank: 'clicks' },
  { key: 'scCountries', source: 'search_console', dimension: 'country', metrics: ['clicks', 'impressions', 'positionSum'], rank: 'clicks' },
  { key: 'cfPaths', source: 'cloudflare', dimension: 'requestPath', metrics: ['pageviews', 'visits'], rank: 'pageviews' },
  { key: 'cfReferrers', source: 'cloudflare', dimension: 'refererHost', metrics: ['visits'], rank: 'visits' },
  { key: 'cfCountries', source: 'cloudflare', dimension: 'countryName', metrics: ['visits'], rank: 'visits' },
  { key: 'cfDevices', source: 'cloudflare', dimension: 'deviceType', metrics: ['visits'], rank: 'visits' },
]

/**
 * The top values of one breakdown, each metric summed over the range (m0, m1, … in b.metrics order). A query
 * builder, not db.all(sql``), because drizzle's D1 batch can't bind a raw statement's parameters. The sums are
 * aliased, so D1's batch rows (keyed by column name) keep every column.
 */
const breakdownQuery = (db: AppDb, b: Breakdown, range: Range) => {
  const sums = Object.fromEntries(
    b.metrics.map((m, i) => [
      `m${i}`,
      sql<number>`sum(case when ${analyticsDaily.metric} = ${m} then ${analyticsDaily.value} else 0 end)`.as(`m${i}`),
    ]),
  )
  const rankAt = b.metrics.indexOf(b.rank)
  return db
    .select({ value: analyticsDaily.dimensionValue, ...sums })
    .from(analyticsDaily)
    .where(
      and(
        eq(analyticsDaily.source, b.source),
        eq(analyticsDaily.dimension, b.dimension),
        gte(analyticsDaily.date, range.from),
        lte(analyticsDaily.date, range.to),
      ),
    )
    .groupBy(analyticsDaily.dimensionValue)
    .orderBy(desc(sql.raw(`m${rankAt}`)), analyticsDaily.dimensionValue)
    .limit(TOP_LIMIT)
}

export type TopRow = { value: string } & Record<string, number | string>

const toTopRows = (rows: Record<string, unknown>[], b: Breakdown): TopRow[] =>
  rows.map((r) => {
    const out: TopRow = { value: String(r.value ?? '') }
    b.metrics.forEach((m, i) => (out[m] = Number(r[`m${i}`] ?? 0)))
    return out
  })

export type SourceInfo = SourceStatus & {
  label: string
  timeZone: string
  lastCompleteDate: string | null
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastError: string | null
  /** Has any data in the range. */
  hasData: boolean
}

export type BusinessRow = {
  programmeId: string | null
  programme: string
  kind: string | null
  status: string
  registrations: number
  teams: number
}

export type StatsView = {
  range: Range
  sources: SourceInfo[]
  fetches: Pick<
    AnalyticsFetch,
    'id' | 'source' | 'status' | 'startedAt' | 'finishedAt' | 'rangeStart' | 'rangeEnd' | 'rowsWritten' | 'error'
  >[]
  /** Daily totals: series[source][metric] = [{ date, value }] in date order. */
  series: Partial<Record<Source, Record<string, { date: string; value: number }[]>>>
  top: Record<string, TopRow[]>
  /** Registrations and team entries by programme and status (admins only; null for editors). */
  business: BusinessRow[] | null
}

export async function loadStats(
  db: AppDb,
  range: Range,
  ctx: { settings: AnalyticsSettings; secrets: AnalyticsSecrets; withBusiness: boolean },
): Promise<StatsView> {
  const inRange = and(gte(analyticsDaily.date, range.from), lte(analyticsDaily.date, range.to))
  const res = (await runBatch(db, [
    db.select().from(analyticsState),
    db
      .select({
        id: analyticsFetches.id,
        source: analyticsFetches.source,
        status: analyticsFetches.status,
        startedAt: analyticsFetches.startedAt,
        finishedAt: analyticsFetches.finishedAt,
        rangeStart: analyticsFetches.rangeStart,
        rangeEnd: analyticsFetches.rangeEnd,
        rowsWritten: analyticsFetches.rowsWritten,
        error: analyticsFetches.error,
      })
      .from(analyticsFetches)
      .orderBy(desc(analyticsFetches.startedAt))
      .limit(15),
    db
      .select({ source: analyticsDaily.source, metric: analyticsDaily.metric, date: analyticsDaily.date, value: analyticsDaily.value })
      .from(analyticsDaily)
      .where(and(eq(analyticsDaily.dimension, ''), inRange))
      .orderBy(analyticsDaily.date),
    ...BREAKDOWNS.map((b) => breakdownQuery(db, b, range)),
    ...(ctx.withBusiness
      ? [
          db
            .select({
              programmeId: products.programmeId,
              programme: sql<string>`coalesce(${programmes.name}, ${products.name})`,
              kind: programmes.kind,
              status: registrations.status,
              n: count(),
            })
            .from(registrations)
            .innerJoin(products, eq(products.id, registrations.productId))
            .leftJoin(programmes, eq(programmes.id, products.programmeId))
            .groupBy(products.programmeId, registrations.status),
          db
            .select({
              programmeId: products.programmeId,
              programme: sql<string>`coalesce(${programmes.name}, ${products.name})`,
              kind: programmes.kind,
              status: groups.status,
              n: count(),
            })
            .from(groups)
            .innerJoin(products, eq(products.id, groups.productId))
            .leftJoin(programmes, eq(programmes.id, products.programmeId))
            .where(eq(groups.kind, 'team'))
            .groupBy(products.programmeId, groups.status),
        ]
      : []),
  ])) as unknown[]
  const states = res[0] as AnalyticsState[]
  const fetches = res[1] as StatsView['fetches']
  const totals = res[2] as { source: Source; metric: string; date: string; value: number }[]
  const breakdownRows = res.slice(3, 3 + BREAKDOWNS.length) as Record<string, unknown>[][]

  const series: StatsView['series'] = {}
  for (const t of totals) ((series[t.source] ??= {})[t.metric] ??= []).push({ date: t.date, value: t.value })
  const top: StatsView['top'] = {}
  BREAKDOWNS.forEach((b, i) => (top[b.key] = toTopRows(breakdownRows[i] ?? [], b)))

  const byState = new Map(states.map((s) => [s.source, s]))
  const sourceInfo: SourceInfo[] = sources.map((s) => {
    const st = byState.get(s)
    return {
      ...sourceStatus(s, ctx.settings, ctx.secrets, st),
      label: sourceLabel[s],
      timeZone: SOURCE_TIME_ZONE[s],
      lastCompleteDate: st?.lastCompleteDate ?? null,
      lastSuccessAt: st?.lastSuccessAt ?? null,
      lastErrorAt: st?.lastErrorAt ?? null,
      lastError: st?.lastError ?? null,
      hasData: !!series[s] && Object.keys(series[s]).length > 0,
    }
  })

  let business: BusinessRow[] | null = null
  if (ctx.withBusiness) {
    type Count = { programmeId: string | null; programme: string; kind: string | null; status: string; n: number }
    const regs = res[3 + BREAKDOWNS.length] as Count[]
    const teams = res[4 + BREAKDOWNS.length] as Count[]
    const map = new Map<string, BusinessRow>()
    const row = (c: Count) => {
      const key = `${c.programmeId ?? c.programme}\u0000${c.status}`
      let r = map.get(key)
      if (!r)
        map.set(
          key,
          (r = { programmeId: c.programmeId, programme: c.programme, kind: c.kind, status: c.status, registrations: 0, teams: 0 }),
        )
      return r
    }
    for (const c of regs) row(c).registrations += Number(c.n)
    for (const c of teams) row(c).teams += Number(c.n)
    business = [...map.values()].toSorted((a, b) => a.programme.localeCompare(b.programme) || a.status.localeCompare(b.status))
  }

  return { range, sources: sourceInfo, fetches, series, top, business }
}

/**
 * Views per page path over the last `days` (for Admin → Pages): GA4 page views when GA4 has data, else Cloudflare
 * page views. Only each day's top 50 pages are stored, so a quiet page can show none.
 */
export async function pageViews(
  db: AppDb,
  now: Date,
  days = 30,
): Promise<{ source: Source | null; days: number; views: Record<string, number> }> {
  const to = sourceYesterday('ga4', now)
  const from = addDays(to, -(days - 1))
  const q = (source: Source, dimension: string, metric: string) =>
    db
      .select({ path: analyticsDaily.dimensionValue, views: sql<number>`sum(${analyticsDaily.value})` })
      .from(analyticsDaily)
      .where(
        and(
          eq(analyticsDaily.source, source),
          eq(analyticsDaily.metric, metric),
          eq(analyticsDaily.dimension, dimension),
          gte(analyticsDaily.date, from),
          lte(analyticsDaily.date, to),
        ),
      )
      .groupBy(analyticsDaily.dimensionValue)
  const [ga4, cf] = (await runBatch(db, [
    q('ga4', 'pagePath', 'screenPageViews'),
    q('cloudflare', 'requestPath', 'pageviews'),
  ])) as unknown as [{ path: string; views: number }[], { path: string; views: number }[]]
  const [source, rows] = ga4.length ? (['ga4', ga4] as const) : cf.length ? (['cloudflare', cf] as const) : ([null, []] as const)
  return { source, days, views: Object.fromEntries(rows.map((r) => [r.path, Number(r.views)])) }
}
