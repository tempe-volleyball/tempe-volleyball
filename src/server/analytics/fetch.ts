import { and, eq, gte, lt, sql } from 'drizzle-orm'
import { runBatch, type AppDb } from '../db'
import { analyticsDaily, analyticsFetches, analyticsState, siteSettings, type AnalyticsState } from '../db/schema'
import { DEFAULT_SETTINGS, readSettings, type AnalyticsSettings } from '../../lib/content/settings'
import { addDays, dateIn, daysBetween } from '../../lib/analytics/dates'
import { GA4_SCOPE, ga4Request, rowLimit, ga4Url, parseGa4, type Ga4Response } from '../../lib/analytics/ga4'
import {
  SEARCH_CONSOLE_DIMENSIONS,
  SEARCH_CONSOLE_SCOPE,
  parseSearchConsole,
  searchConsoleRequest,
  searchConsoleUrl,
  type SearchConsoleDimension,
  type SearchConsoleResponse,
} from '../../lib/analytics/search-console'
import {
  CF_GRAPHQL_URL,
  cfPageloadQuery,
  CF_VITALS_QUERY,
  cfError,
  cfVariables,
  parseCfPageloads,
  parseCfVitals,
  type CfResponse,
} from '../../lib/analytics/cloudflare'
import { fetchSwitch, sources, type DailyRow, type Source } from '../../lib/analytics/rows'
import { AnalyticsConfigError, googleAccessToken, parseServiceAccount } from './google-auth'

// The daily analytics fetch (docs/admin.md §2). The hourly cron calls runAnalytics() once per invocation and it
// fetches at most ONE source, so each source gets its own invocation and its own 10 ms CPU budget (network waits
// don't count). A source is "due" until its last complete day is the source's yesterday, so in practice each
// source runs once a day, a first fetch back-fills in 10-day steps an hour apart, and a failure is retried after
// RETRY_AFTER_MS. Every write is one db.batch(); the rows go in as one JSON parameter per ~1,500 rows
// (INSERT … SELECT FROM json_each), so a run is a handful of statements whatever the row count.

export type AnalyticsSecrets = { GOOGLE_SERVICE_ACCOUNT_JSON?: string; CF_ANALYTICS_TOKEN?: string }

export type AnalyticsDeps = { secrets: AnalyticsSecrets; fetch: typeof fetch }

/** Each source's reporting day (GA4 follows the property's zone, which the old site set to Sydney). */
export const SOURCE_TIME_ZONE: Record<Source, string> = {
  ga4: 'Australia/Sydney',
  search_console: 'America/Los_Angeles',
  cloudflare: 'UTC',
}

/** Days re-fetched on every run, because sources revise recent data (Search Console lags 2–3 days). */
export const OVERLAP_DAYS: Record<Source, number> = { ga4: 3, search_console: 4, cloudflare: 2 }

/** How far back each source can go (Search Console keeps 16 months, Web Analytics 6). */
export const MAX_HISTORY_DAYS: Record<Source, number> = { ga4: 3650, search_console: 480, cloudflare: 180 }

/** Days fetched per run. */
export const WINDOW_DAYS = 10

export const RETRY_AFTER_MS = 3 * 60 * 60 * 1000
const LOCK_MS = 5 * 60 * 1000
const FETCH_LOG_DAYS = 90
const ROWS_PER_STATEMENT = 1500

export type SourceStatus = {
  source: Source
  /** Settings and secrets present. */
  configured: boolean
  /** What's missing, in words, for the Stats page ("not connected yet"). */
  missing: string[]
  /** The admin's switch in Settings → Analytics (and analytics_state.enabled, a manual kill switch). */
  enabled: boolean
}

export function sourceStatus(
  source: Source,
  settings: AnalyticsSettings,
  secrets: AnalyticsSecrets,
  state?: Pick<AnalyticsState, 'enabled'>,
): SourceStatus {
  const missing: string[] = []
  const google = () => {
    if (!secrets.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) missing.push('the GOOGLE_SERVICE_ACCOUNT_JSON secret')
  }
  if (source === 'ga4') {
    if (!settings.ga4PropertyId) missing.push('the GA4 property ID (Settings → Analytics)')
    google()
  } else if (source === 'search_console') {
    if (!settings.searchConsoleSite) missing.push('the Search Console property (Settings → Analytics)')
    google()
  } else {
    if (!settings.cfAccountId) missing.push('the Cloudflare account ID (Settings → Analytics)')
    if (!settings.cfSiteTag) missing.push('the Web Analytics site tag (Settings → Analytics)')
    if (!secrets.CF_ANALYTICS_TOKEN?.trim()) missing.push('the CF_ANALYTICS_TOKEN secret')
  }
  return { source, configured: missing.length === 0, missing, enabled: settings.fetch[fetchSwitch[source]] && (state?.enabled ?? true) }
}

/** The source's yesterday: the last day that can be complete. */
export const sourceYesterday = (source: Source, now: Date) => addDays(dateIn(SOURCE_TIME_ZONE[source], now), -1)

export type Plan = { start: string; end: string }

/**
 * The days the next run fetches, or null when the source is up to date (its last complete day is its yesterday).
 * `force` (the admin's "Fetch now") re-fetches the overlap even when up to date.
 */
export function planFetch(
  source: Source,
  lastCompleteDate: string | null | undefined,
  settings: Pick<AnalyticsSettings, 'backfillDays'>,
  now: Date,
  force = false,
): Plan | null {
  const yesterday = sourceYesterday(source, now)
  const earliest = addDays(yesterday, -(MAX_HISTORY_DAYS[source] - 1))
  let start: string
  if (!lastCompleteDate) start = addDays(yesterday, -(Math.min(settings.backfillDays, MAX_HISTORY_DAYS[source]) - 1))
  else if (lastCompleteDate >= yesterday && !force) return null
  else start = addDays(lastCompleteDate >= yesterday ? yesterday : lastCompleteDate, -(OVERLAP_DAYS[source] - 1))
  if (start < earliest) start = earliest
  if (start > yesterday) start = yesterday
  const windowEnd = addDays(start, WINDOW_DAYS - 1)
  return { start, end: windowEnd < yesterday ? windowEnd : yesterday }
}

const inBackoff = (s: AnalyticsState | undefined, now: Date) =>
  !!s?.lastErrorAt && (!s.lastSuccessAt || s.lastErrorAt > s.lastSuccessAt) && now.getTime() - Date.parse(s.lastErrorAt) < RETRY_AFTER_MS

const lockedUntil = (s: AnalyticsState | undefined) => {
  const v = s?.cursor?.lockUntil
  return typeof v === 'string' ? v : null
}

export type RunResult =
  | { status: 'idle'; reason: string }
  | { status: 'ok'; source: Source; start: string; end: string; rows: number; warning?: string }
  | { status: 'error'; source: Source; start: string; end: string; error: string }
  | { status: 'busy'; source: Source }

export async function loadAnalyticsConfig(db: AppDb) {
  const [settingRows, states] = (await runBatch(db, [
    db.select({ key: siteSettings.key, value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, 'analytics')),
    db.select().from(analyticsState),
  ])) as unknown as [{ key: string; value: unknown }[], AnalyticsState[]]
  const settings = settingRows.length ? readSettings(settingRows).analytics : DEFAULT_SETTINGS.analytics
  return { settings, states: new Map(states.map((s) => [s.source, s])) }
}

/**
 * Fetches one source: the one asked for (the admin's "Fetch now", which ignores the backoff and re-fetches even
 * when up to date), or else the most overdue source that is due. Never throws; the outcome is in the result,
 * analytics_fetches and analytics_state.
 */
export async function runAnalytics(db: AppDb, deps: AnalyticsDeps, now = new Date(), opts: { source?: Source } = {}): Promise<RunResult> {
  const { settings, states } = await loadAnalyticsConfig(db)
  const nowIso = now.toISOString()
  let pick: { source: Source; plan: Plan } | null = null
  if (opts.source) {
    const st = sourceStatus(opts.source, settings, deps.secrets, states.get(opts.source))
    if (!st.configured) return { status: 'idle', reason: `${opts.source} is not connected yet: needs ${st.missing.join(', ')}.` }
    const plan = planFetch(opts.source, states.get(opts.source)?.lastCompleteDate, settings, now, true)
    if (plan) pick = { source: opts.source, plan }
  } else {
    const due = sources
      .filter((s) => {
        const st = sourceStatus(s, settings, deps.secrets, states.get(s))
        const lock = lockedUntil(states.get(s))
        return st.configured && st.enabled && !inBackoff(states.get(s), now) && !(lock && lock > nowIso)
      })
      .map((s) => ({ source: s, plan: planFetch(s, states.get(s)?.lastCompleteDate, settings, now) }))
      .filter((x): x is { source: Source; plan: Plan } => !!x.plan)
      .toSorted((a, b) => (states.get(a.source)?.lastSuccessAt ?? '').localeCompare(states.get(b.source)?.lastSuccessAt ?? ''))
    pick = due[0] ?? null
  }
  if (!pick) return { status: 'idle', reason: 'Nothing due.' }
  const { source, plan } = pick

  // Claim the source (the cron and a "Fetch now" can overlap) and log the run, in one batch.
  const fetchId = crypto.randomUUID()
  const lockUntil = new Date(now.getTime() + LOCK_MS).toISOString()
  const [claimed] = (await runBatch(db, [
    db.all(sql`insert into analytics_state (source, cursor, created_at, updated_at)
      values (${source}, json_object('lockUntil', ${lockUntil}), ${nowIso}, ${nowIso})
      on conflict (source) do update set cursor = json_set(analytics_state.cursor, '$.lockUntil', ${lockUntil}), updated_at = ${nowIso}
      where coalesce(json_extract(analytics_state.cursor, '$.lockUntil'), '') <= ${nowIso}
      returning source`),
    db.insert(analyticsFetches).values({
      id: fetchId,
      source,
      status: 'running',
      startedAt: nowIso,
      rangeStart: plan.start,
      rangeEnd: plan.end,
      createdAt: nowIso,
      updatedAt: nowIso,
    }),
  ])) as unknown as [unknown]
  if (!returnedRows(claimed)) {
    await db
      .update(analyticsFetches)
      .set({ status: 'skipped', finishedAt: nowIso, error: 'Another fetch of this source is running.' })
      .where(eq(analyticsFetches.id, fetchId))
    return { status: 'busy', source }
  }

  try {
    const { rows, warning } = await fetchSource(source, plan, settings, deps, now)
    const written = await writeRows(db, source, plan, rows, { fetchId, now, warning, settings, states })
    return { status: 'ok', source, ...plan, rows: written, ...(warning ? { warning } : {}) }
  } catch (e) {
    const error = (e instanceof Error ? e.message : String(e)).slice(0, 1000)
    const at = new Date().toISOString()
    await runBatch(db, [
      db.update(analyticsFetches).set({ status: 'error', finishedAt: at, error, updatedAt: at }).where(eq(analyticsFetches.id, fetchId)),
      db
        .update(analyticsState)
        .set({ lastError: error, lastErrorAt: at, cursor: sql`json_remove(${analyticsState.cursor}, '$.lockUntil')`, updatedAt: at })
        .where(eq(analyticsState.source, source)),
    ])
    return { status: 'error', source, ...plan, error }
  }
}

/** D1 gives `{ results: [...] }` for run(); the test driver gives `{ rows: [...] }`. */
const returnedRows = (r: unknown) => {
  const o = r as { results?: unknown[]; rows?: unknown[] } | unknown[] | undefined
  if (Array.isArray(o)) return o.length
  return o?.results?.length ?? o?.rows?.length ?? 0
}

async function writeRows(
  db: AppDb,
  source: Source,
  plan: Plan,
  rows: DailyRow[],
  ctx: { fetchId: string; now: Date; warning: string | undefined; settings: AnalyticsSettings; states: Map<string, AnalyticsState> },
) {
  const at = new Date().toISOString()
  const inRange = rows.filter((r) => r.date >= plan.start && r.date <= plan.end)
  const chunks: string[] = []
  for (let i = 0; i < inRange.length; i += ROWS_PER_STATEMENT)
    chunks.push(
      JSON.stringify(inRange.slice(i, i + ROWS_PER_STATEMENT).map((r) => [r.date, r.metric, r.dimension, r.dimensionValue, r.value])),
    )
  const prev = ctx.states.get(source)?.lastCompleteDate
  const lastCompleteDate = prev && prev > plan.end ? prev : plan.end
  const keepFrom = addDays(sourceYesterday(source, ctx.now), -ctx.settings.retentionDays)
  const logFrom = new Date(ctx.now.getTime() - FETCH_LOG_DAYS * 86_400_000).toISOString()
  await runBatch(db, [
    // The range is replaced, so a page that dropped out of the top 50 doesn't linger.
    db
      .delete(analyticsDaily)
      .where(and(eq(analyticsDaily.source, source), gte(analyticsDaily.date, plan.start), sql`${analyticsDaily.date} <= ${plan.end}`)),
    ...chunks.map((json) =>
      db.run(sql`insert into analytics_daily (source, date, metric, dimension, dimension_value, value, created_at, updated_at)
        select ${source}, json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
          json_extract(j.value, '$[3]'), json_extract(j.value, '$[4]'), ${at}, ${at}
        from json_each(${json}) as j where true
        on conflict (source, date, metric, dimension, dimension_value) do update set value = excluded.value, updated_at = excluded.updated_at`),
    ),
    db
      .update(analyticsFetches)
      .set({ status: 'ok', finishedAt: at, rowsWritten: inRange.length, error: ctx.warning ?? null, updatedAt: at })
      .where(eq(analyticsFetches.id, ctx.fetchId)),
    db
      .update(analyticsState)
      .set({ lastCompleteDate, lastSuccessAt: at, cursor: sql`json_remove(${analyticsState.cursor}, '$.lockUntil')`, updatedAt: at })
      .where(eq(analyticsState.source, source)),
    db.delete(analyticsDaily).where(and(eq(analyticsDaily.source, source), lt(analyticsDaily.date, keepFrom))),
    db.delete(analyticsFetches).where(lt(analyticsFetches.startedAt, logFrom)),
  ])
  return inRange.length
}

async function postJson<T>(fetcher: typeof fetch, url: string, token: string, body: unknown, label: string): Promise<T> {
  const res = await fetcher(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } | string; errors?: { message?: string }[] }
  if (!res.ok) {
    const message = typeof data.error === 'string' ? data.error : (data.error?.message ?? data.errors?.[0]?.message ?? res.statusText)
    throw new Error(`${label} answered ${res.status}: ${message}`)
  }
  return data
}

async function fetchSource(
  source: Source,
  plan: Plan,
  settings: AnalyticsSettings,
  deps: AnalyticsDeps,
  now: Date,
): Promise<{ rows: DailyRow[]; warning?: string }> {
  if (daysBetween(plan.start, plan.end) < 0) return { rows: [] }
  if (source === 'ga4') {
    const token = await googleAccessToken(parseServiceAccount(deps.secrets.GOOGLE_SERVICE_ACCOUNT_JSON), [GA4_SCOPE], deps.fetch, now)
    const res = await postJson<Ga4Response>(deps.fetch, ga4Url(settings.ga4PropertyId), token, ga4Request(plan.start, plan.end), 'GA4')
    return { rows: parseGa4(res) }
  }
  if (source === 'search_console') {
    const token = await googleAccessToken(
      parseServiceAccount(deps.secrets.GOOGLE_SERVICE_ACCOUNT_JSON),
      [SEARCH_CONSOLE_SCOPE],
      deps.fetch,
      now,
    )
    const dims: SearchConsoleDimension[] = ['', ...SEARCH_CONSOLE_DIMENSIONS]
    const results = await Promise.all(
      dims.map((d) =>
        postJson<SearchConsoleResponse>(
          deps.fetch,
          searchConsoleUrl(settings.searchConsoleSite),
          token,
          searchConsoleRequest(plan.start, plan.end, d),
          'Search Console',
        ).then((r) => parseSearchConsole(r, d)),
      ),
    )
    return { rows: results.flat() }
  }
  const token = deps.secrets.CF_ANALYTICS_TOKEN?.trim()
  if (!token) throw new AnalyticsConfigError('CF_ANALYTICS_TOKEN is not set.')
  const variables = cfVariables(settings.cfAccountId, settings.cfSiteTag, plan.start, plan.end)
  const [pageloads, vitals] = await Promise.allSettled([
    postJson<CfResponse<never>>(
      deps.fetch,
      CF_GRAPHQL_URL,
      token,
      { query: cfPageloadQuery(rowLimit(plan.start, plan.end)), variables },
      'Cloudflare',
    ),
    postJson<CfResponse<never>>(deps.fetch, CF_GRAPHQL_URL, token, { query: CF_VITALS_QUERY, variables }, 'Cloudflare'),
  ])
  if (pageloads.status === 'rejected') throw pageloads.reason
  const err = cfError(pageloads.value)
  if (err) throw new Error(`Cloudflare: ${err}`)
  const rows = parseCfPageloads(pageloads.value)
  // Vitals are a bonus: a failure there is a warning on an otherwise good run.
  let warning: string | undefined
  if (vitals.status === 'rejected')
    warning = `Core Web Vitals not fetched: ${String(vitals.reason instanceof Error ? vitals.reason.message : vitals.reason)}`
  else if (cfError(vitals.value)) warning = `Core Web Vitals not fetched: ${cfError(vitals.value)}`
  else rows.push(...parseCfVitals(vitals.value))
  return { rows, ...(warning ? { warning } : {}) }
}
