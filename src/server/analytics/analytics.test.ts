import { beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb } from '../db/testing'
import { analyticsDaily, analyticsFetches, analyticsState, siteSettings } from '../db/schema'
import { DEFAULT_SETTINGS, type AnalyticsSettings } from '../../lib/content/settings'
import { parseGa4 } from '../../lib/analytics/ga4'
import { runJobs } from '../cron'
import { RETRY_AFTER_MS, planFetch, runAnalytics, sourceStatus, type AnalyticsDeps } from './fetch'
import { parseServiceAccount, signJwt } from './google-auth'
import { loadStats, pageViews, parseRange } from './stats'
import cf from '../../lib/analytics/fixtures/cloudflare.json'
import ga4 from '../../lib/analytics/fixtures/ga4-batch-run-reports.json'
import sc from '../../lib/analytics/fixtures/search-console.json'

// 2026-10-18 09:00 in Sydney (AEDT), so GA4's yesterday is the 17th; it's still the 17th in UTC and California, so
// Cloudflare's and Search Console's yesterday is the 16th.
const NOW = new Date('2026-10-17T22:00:00Z')

let saJson = ''
let publicKey: CryptoKey

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  publicKey = pair.publicKey
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const b64 = btoa(String.fromCharCode(...der))
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`
  saJson = JSON.stringify({ type: 'service_account', client_email: 'stats@tempevb.iam.gserviceaccount.com', private_key: pem })
})

const configured: AnalyticsSettings = {
  ...DEFAULT_SETTINGS.analytics,
  ga4PropertyId: '312345678',
  searchConsoleSite: 'sc-domain:tempevb.com',
  cfAccountId: 'a'.repeat(32),
  cfSiteTag: 'b'.repeat(32),
  backfillDays: 5,
}

type Call = { url: string; body: unknown; auth: string | null }

function fakeFetch(overrides: { ga4?: () => Response; cf?: (query: string) => Response } = {}) {
  const calls: Call[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const raw = String(init?.body ?? '')
    const body: unknown = url.includes('oauth2') ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || '{}')
    calls.push({ url, body, auth: new Headers(init?.headers).get('authorization') })
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'ya29.token', expires_in: 3599, token_type: 'Bearer' })
    if (url.includes('analyticsdata')) return overrides.ga4?.() ?? Response.json(ga4)
    if (url.includes('searchconsole')) {
      const dims = (body as { dimensions: string[] }).dimensions
      const key = (dims[1] ?? 'totals') as keyof typeof sc
      return Response.json(sc[key])
    }
    if (url.includes('graphql')) {
      const query = (body as { query: string }).query
      return overrides.cf?.(query) ?? Response.json(query.includes('Vitals') ? cf.vitals : cf.pageloads)
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  return { fn, calls }
}

async function setup(settings: AnalyticsSettings = configured) {
  const t = createTestDb()
  await t.db.insert(siteSettings).values({ key: 'analytics', value: settings, updatedAt: NOW.toISOString() })
  return t
}

const deps = (
  fetchFn: typeof fetch,
  secrets: AnalyticsDeps['secrets'] = { GOOGLE_SERVICE_ACCOUNT_JSON: saJson, CF_ANALYTICS_TOKEN: 'cf-token' },
) => ({
  secrets,
  fetch: fetchFn,
})

describe('google auth', () => {
  it('signs an RS256 JWT that verifies with the public key', async () => {
    const jwt = await signJwt(parseServiceAccount(saJson), ['scope-a', 'scope-b'], NOW)
    const [h, c, s] = jwt.split('.') as [string, string, string]
    const dec = (x: string) => JSON.parse(atob(x.replace(/-/g, '+').replace(/_/g, '/')))
    expect(dec(h)).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(dec(c)).toMatchObject({
      iss: 'stats@tempevb.iam.gserviceaccount.com',
      scope: 'scope-a scope-b',
      aud: 'https://oauth2.googleapis.com/token',
    })
    const sig = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0))
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, sig, new TextEncoder().encode(`${h}.${c}`))).toBe(true)
  })

  it('explains a bad key file', () => {
    expect(() => parseServiceAccount(undefined)).toThrow(/not set/)
    expect(() => parseServiceAccount('{')).toThrow(/not valid JSON/)
    expect(() => parseServiceAccount('{"client_email":"x"}')).toThrow(/private_key/)
  })
})

describe('planFetch', () => {
  it('back-fills, then fetches a window, then re-fetches the overlap', () => {
    // GA4: Sydney yesterday = 2026-10-17.
    expect(planFetch('ga4', null, { backfillDays: 90 }, NOW)).toEqual({ start: '2026-07-20', end: '2026-07-29' })
    expect(planFetch('ga4', '2026-07-29', { backfillDays: 90 }, NOW)).toEqual({ start: '2026-07-27', end: '2026-08-05' })
    expect(planFetch('ga4', '2026-10-16', { backfillDays: 90 }, NOW)).toEqual({ start: '2026-10-14', end: '2026-10-17' })
    expect(planFetch('ga4', '2026-10-17', { backfillDays: 90 }, NOW)).toBeNull()
    expect(planFetch('ga4', '2026-10-17', { backfillDays: 90 }, NOW, true)).toEqual({ start: '2026-10-15', end: '2026-10-17' })
    // Search Console's day is California's: yesterday there is the 16th.
    expect(planFetch('search_console', '2026-10-16', { backfillDays: 90 }, NOW)).toBeNull()
    // Cloudflare keeps 6 months, so a long back-fill is clamped.
    expect(planFetch('cloudflare', null, { backfillDays: 400 }, NOW)!.start).toBe('2026-04-20')
  })
})

describe('sourceStatus', () => {
  it('says what is missing', () => {
    const st = sourceStatus('cloudflare', DEFAULT_SETTINGS.analytics, {})
    expect(st.configured).toBe(false)
    expect(st.missing).toEqual([
      'the Cloudflare account ID (Settings → Analytics)',
      'the Web Analytics site tag (Settings → Analytics)',
      'the CF_ANALYTICS_TOKEN secret',
    ])
    expect(sourceStatus('ga4', configured, { GOOGLE_SERVICE_ACCOUNT_JSON: '{}' }).configured).toBe(true)
  })
})

describe('runAnalytics', () => {
  it('does nothing until a source is connected', async () => {
    const { db } = await setup(DEFAULT_SETTINGS.analytics)
    const f = fakeFetch()
    expect(await runAnalytics(db, deps(f.fn, {}), NOW)).toEqual({ status: 'idle', reason: 'Nothing due.' })
    expect(await runAnalytics(db, deps(f.fn, {}), NOW, { source: 'ga4' })).toMatchObject({ status: 'idle' })
    expect(f.calls).toHaveLength(0)
  })

  it('fetches one source per run, within D1 limits, and then each is done for the day', async () => {
    const { db, stats } = await setup()
    const f = fakeFetch()
    stats.reset()
    const first = await runAnalytics(db, deps(f.fn), NOW)
    expect(first).toMatchObject({ status: 'ok', source: 'ga4', start: '2026-10-13', end: '2026-10-17' })
    expect(stats.queries).toBeLessThanOrEqual(12)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://analyticsdata.googleapis.com/v1beta/properties/312345678:batchRunReports',
    ])
    expect(f.calls[1]!.auth).toBe('Bearer ya29.token')
    expect((f.calls[0]!.body as Record<string, string>).grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')

    const stored = await db.select().from(analyticsDaily).where(eq(analyticsDaily.source, 'ga4'))
    expect(stored.length).toBe(parseGa4(ga4).length)
    expect(stored.find((r) => r.metric === 'activeUsers' && r.dimension === '' && r.date === '2026-10-16')?.value).toBe(131)

    expect((await runAnalytics(db, deps(f.fn), NOW)).status).toBe('ok') // the next due source
    expect((await runAnalytics(db, deps(f.fn), NOW)).status).toBe('ok')
    expect(await runAnalytics(db, deps(f.fn), NOW)).toEqual({ status: 'idle', reason: 'Nothing due.' })
    const states = await db.select().from(analyticsState)
    expect(Object.fromEntries(states.map((s) => [s.source, s.lastCompleteDate]))).toEqual({
      ga4: '2026-10-17',
      search_console: '2026-10-16',
      cloudflare: '2026-10-16',
    })
    expect(states.every((s) => !('lockUntil' in s.cursor))).toBe(true)
    const fetches = await db.select().from(analyticsFetches)
    expect(fetches.map((x) => x.status)).toEqual(['ok', 'ok', 'ok'])
    const scRows = await db.select().from(analyticsDaily).where(eq(analyticsDaily.source, 'search_console'))
    expect(scRows.some((r) => r.dimension === 'query' && r.dimensionValue === 'tempe volleyball')).toBe(true)
    const cfRows = await db.select().from(analyticsDaily).where(eq(analyticsDaily.source, 'cloudflare'))
    expect(cfRows.find((r) => r.metric === 'lcpP75' && r.date === '2026-10-16')?.value).toBe(1830)
  })

  it('re-fetching replaces the range (no stale top-50 rows)', async () => {
    const { db } = await setup()
    await db
      .insert(analyticsDaily)
      .values({ source: 'ga4', date: '2026-10-16', metric: 'screenPageViews', dimension: 'pagePath', dimensionValue: '/gone', value: 1 })
    await runAnalytics(db, deps(fakeFetch().fn), NOW, { source: 'ga4' })
    const gone = await db.select().from(analyticsDaily).where(eq(analyticsDaily.dimensionValue, '/gone'))
    expect(gone).toEqual([])
  })

  it('records an error, backs off, and "Fetch now" retries straight away', async () => {
    const { db } = await setup({ ...configured, fetch: { ga4: true, searchConsole: false, cloudflare: false } })
    const bad = fakeFetch({
      ga4: () =>
        Response.json({ error: { code: 403, message: 'User does not have sufficient permissions for this property.' } }, { status: 403 }),
    })
    const r = await runAnalytics(db, deps(bad.fn), NOW)
    expect(r).toMatchObject({
      status: 'error',
      source: 'ga4',
      error: 'GA4 answered 403: User does not have sufficient permissions for this property.',
    })
    const st = (await db.select().from(analyticsState))[0]!
    expect(st.lastError).toMatch(/sufficient permissions/)
    expect(st.lastCompleteDate).toBeNull()
    expect(await runAnalytics(db, deps(fakeFetch().fn), new Date(NOW.getTime() + 60_000))).toMatchObject({ status: 'idle' })
    expect(await runAnalytics(db, deps(fakeFetch().fn), new Date(NOW.getTime() + RETRY_AFTER_MS + 1000))).toMatchObject({ status: 'ok' })
    expect(await runAnalytics(db, deps(fakeFetch().fn), NOW, { source: 'ga4' })).toMatchObject({ status: 'ok' })
  })

  it('keeps traffic when Core Web Vitals fail', async () => {
    const { db } = await setup()
    const f = fakeFetch({ cf: (q) => Response.json(q.includes('Vitals') ? cf.error : cf.pageloads) })
    const r = await runAnalytics(db, deps(f.fn), NOW, { source: 'cloudflare' })
    expect(r).toMatchObject({ status: 'ok', warning: 'Core Web Vitals not fetched: not authorized for that account' })
    expect((await db.select().from(analyticsFetches))[0]!.error).toMatch(/Vitals/)
  })

  it("won't run a source another run has locked", async () => {
    const { db } = await setup()
    await db.insert(analyticsState).values({ source: 'ga4', cursor: { lockUntil: new Date(NOW.getTime() + 60_000).toISOString() } })
    expect(await runAnalytics(db, deps(fakeFetch().fn), NOW, { source: 'ga4' })).toEqual({ status: 'busy', source: 'ga4' })
    expect((await db.select().from(analyticsFetches))[0]!.status).toBe('skipped')
  })

  it('writes thousands of rows in a few statements', async () => {
    const { db, stats } = await setup()
    const pages = Array.from({ length: 300 }, (_, i) => `/page-${i}`)
    const days = Array.from({ length: 5 }, (_, i) => `202610${13 + i}`)
    const big = {
      reports: [
        ga4.reports[0],
        {
          dimensionHeaders: [{ name: 'date' }, { name: 'pagePath' }],
          metricHeaders: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
          rows: days.flatMap((d) =>
            pages.map((p, i) => ({
              dimensionValues: [{ value: d }, { value: p }],
              metricValues: [{ value: String(1000 - i) }, { value: '3' }],
            })),
          ),
        },
      ],
    }
    const t0 = performance.now()
    const parsed = parseGa4(big as typeof ga4)
    const parseMs = performance.now() - t0
    // 1,500 response rows -> top 50 pages × 5 days × 2 metrics + totals. Parsing stays a few ms of CPU.
    expect(parsed.filter((r) => r.dimension === 'pagePath')).toHaveLength(500)
    expect(parseMs).toBeLessThan(50)
    stats.reset()
    const r = await runAnalytics(db, deps(fakeFetch({ ga4: () => Response.json(big) }).fn), NOW, { source: 'ga4' })
    expect(r).toMatchObject({ status: 'ok', rows: parsed.length })
    expect(stats.queries).toBeLessThanOrEqual(12)
  })

  it('runs from the hourly cron', async () => {
    const { db } = await setup()
    const mailer = {
      drainOutbox: () => Promise.resolve({ sent: 0, failed: 0, skipped: 0, remaining: 0 }),
      scrubSensitivePayloads: () => Promise.resolve(0),
    }
    const result = await runJobs(db, mailer, NOW, { analytics: deps(fakeFetch().fn) })
    expect(result.analytics).toMatchObject({ status: 'ok', source: 'ga4' })
  })
})

describe('stats', () => {
  it('parses the range', () => {
    expect(parseRange(new URL('https://x/api?'), NOW)).toEqual({ from: '2026-09-20', to: '2026-10-17' })
    expect(() => parseRange(new URL('https://x/api?from=2026-10-10&to=2026-10-01'), NOW)).toThrow(/after/)
    expect(() => parseRange(new URL('https://x/api?from=2020-01-01&to=2026-10-01'), NOW)).toThrow(/at most/)
  })

  it('reads totals, breakdowns and page views from D1', async () => {
    const { db, stats } = await setup()
    for (let i = 0; i < 3; i++) await runAnalytics(db, deps(fakeFetch().fn), NOW)
    stats.reset()
    const view = await loadStats(
      db,
      { from: '2026-10-01', to: '2026-10-17' },
      {
        settings: configured,
        secrets: { GOOGLE_SERVICE_ACCOUNT_JSON: saJson, CF_ANALYTICS_TOKEN: 'x' },
        withBusiness: true,
      },
    )
    expect(stats.queries).toBeLessThanOrEqual(50)
    expect(view.sources.map((s) => [s.source, s.configured, s.hasData])).toEqual([
      ['ga4', true, true],
      ['search_console', true, true],
      ['cloudflare', true, true],
    ])
    expect(view.series.ga4?.activeUsers).toEqual([
      { date: '2026-10-15', value: 119 },
      { date: '2026-10-16', value: 131 },
    ])
    expect(view.top.ga4Pages![0]).toEqual({ value: '/', screenPageViews: 268, activeUsers: 186 })
    expect(view.top.scQueries![0]).toMatchObject({ value: 'tempe volleyball', clicks: 41, impressions: 116 })
    expect(view.top.cfReferrers!.map((r) => r.value)).toEqual(['www.google.com', '(direct)', 'l.instagram.com'])
    expect(view.business).toEqual([])
    expect(view.fetches).toHaveLength(3)

    const pv = await pageViews(db, NOW)
    expect(pv.source).toBe('ga4')
    expect(pv.views['/']).toBe(268)
  })
})
