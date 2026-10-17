import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, checkSetting } from '../content/settings'
import { cfError, cfVariables, parseCfPageloads, parseCfVitals, cfPageloadQuery } from './cloudflare'
import { addDays, compactDate, dateIn, dateRange, isIsoDate } from './dates'
import { ga4Request, parseGa4 } from './ga4'
import { normalisePagePath, topPerDay, type DailyRow } from './rows'
import { parseSearchConsole, searchConsoleRequest, searchConsoleUrl } from './search-console'
import { analyticsTags, ga4LoaderScript } from './tags'
import cf from './fixtures/cloudflare.json'
import ga4 from './fixtures/ga4-batch-run-reports.json'
import sc from './fixtures/search-console.json'

const find = (rows: DailyRow[], q: Partial<DailyRow>) =>
  rows.filter((r) => Object.entries(q).every(([k, v]) => r[k as keyof DailyRow] === v))
const one = (rows: DailyRow[], q: Partial<DailyRow>) => {
  const f = find(rows, q)
  if (f.length !== 1) throw new Error(`expected one row for ${JSON.stringify(q)}, got ${f.length}`)
  return f[0]!.value
}

describe('dates', () => {
  it('does day arithmetic and zones', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(compactDate('20261017')).toBe('2026-10-17')
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('2026-02-28')).toBe(true)
    expect(dateRange('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
    // 2026-10-17 14:00 UTC is already the 18th in Sydney (AEDT) but still the 17th in California.
    const at = new Date('2026-10-17T14:00:00Z')
    expect(dateIn('Australia/Sydney', at)).toBe('2026-10-18')
    expect(dateIn('America/Los_Angeles', at)).toBe('2026-10-17')
    expect(dateIn('UTC', at)).toBe('2026-10-17')
  })
})

describe('rows', () => {
  it('normalises page paths across sources', () => {
    expect(normalisePagePath('https://www.tempevb.com/fixtures/')).toBe('/fixtures')
    expect(normalisePagePath('/2023-enrolment/?utm_source=ig')).toBe('/2023-enrolment')
    expect(normalisePagePath('/')).toBe('/')
    expect(normalisePagePath('')).toBe('(not set)')
  })

  it('keeps the top N values per day and dimension, with all their metrics', () => {
    const rows: DailyRow[] = []
    for (let i = 0; i < 5; i++) {
      rows.push({ date: '2026-10-16', metric: 'views', dimension: 'page', dimensionValue: `/p${i}`, value: i })
      rows.push({ date: '2026-10-16', metric: 'users', dimension: 'page', dimensionValue: `/p${i}`, value: 100 - i })
    }
    rows.push({ date: '2026-10-16', metric: 'views', dimension: '', dimensionValue: '', value: 10 })
    const kept = topPerDay(rows, { page: 'views' }, 2)
    expect(
      kept
        .filter((r) => r.dimension)
        .map((r) => r.dimensionValue)
        .toSorted(),
    ).toEqual(['/p3', '/p3', '/p4', '/p4'])
    expect(kept.some((r) => r.dimension === '')).toBe(true)
  })
})

describe('GA4', () => {
  it('builds at most 5 reports for one range', () => {
    const req = ga4Request('2026-10-07', '2026-10-16')
    expect(req.requests).toHaveLength(5)
    expect(req.requests[0]!.dimensions).toEqual([{ name: 'date' }])
    expect(req.requests.every((r) => r.dateRanges[0]!.startDate === '2026-10-07')).toBe(true)
  })

  it('maps a batchRunReports response', () => {
    const rows = parseGa4(ga4)
    expect(one(rows, { date: '2026-10-16', metric: 'activeUsers', dimension: '' })).toBe(131)
    expect(one(rows, { date: '2026-10-15', metric: 'screenPageViews', dimension: '' })).toBe(377)
    // "/x/" and "/x" are one page.
    expect(
      one(rows, { date: '2026-10-16', metric: 'screenPageViews', dimension: 'pagePath', dimensionValue: '/thursday-night-league-ladder' }),
    ).toBe(80)
    expect(one(rows, { date: '2026-10-16', metric: 'screenPageViews', dimension: 'pagePath', dimensionValue: '/2023-enrolment' })).toBe(33)
    // Channel groups and sources come from one report, each summed on its own.
    expect(
      one(rows, { date: '2026-10-16', metric: 'sessions', dimension: 'sessionDefaultChannelGroup', dimensionValue: 'Organic Search' }),
    ).toBe(90)
    expect(one(rows, { date: '2026-10-16', metric: 'sessions', dimension: 'sessionSource', dimensionValue: 'google' })).toBe(78)
    expect(one(rows, { date: '2026-10-16', metric: 'activeUsers', dimension: 'deviceCategory', dimensionValue: 'mobile' })).toBe(101)
    expect(one(rows, { date: '2026-10-16', metric: 'activeUsers', dimension: 'country', dimensionValue: 'Australia' })).toBe(124)
  })

  it('copes with an empty or odd response', () => {
    expect(parseGa4({})).toEqual([])
    expect(parseGa4({ reports: [{ dimensionHeaders: [{ name: 'pagePath' }], metricHeaders: [{ name: 'x' }], rows: [{}] }] })).toEqual([])
  })
})

describe('Search Console', () => {
  it('builds requests and URLs', () => {
    expect(searchConsoleUrl('sc-domain:tempevb.com')).toBe(
      'https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Atempevb.com/searchAnalytics/query',
    )
    expect(searchConsoleRequest('2026-10-01', '2026-10-10', 'query').dimensions).toEqual(['date', 'query'])
    expect(searchConsoleRequest('2026-10-01', '2026-10-10', '').dimensions).toEqual(['date'])
  })

  it('stores additive metrics (positionSum = position × impressions)', () => {
    const totals = parseSearchConsole(sc.totals, '')
    expect(one(totals, { date: '2026-10-14', metric: 'clicks' })).toBe(41)
    expect(one(totals, { date: '2026-10-14', metric: 'positionSum' })).toBeCloseTo(7.3 * 812)
    const queries = parseSearchConsole(sc.query, 'query')
    expect(one(queries, { date: '2026-10-14', metric: 'impressions', dimensionValue: 'social volleyball sydney' })).toBe(140)
    // www and apex URLs of one page merge, and their positions stay weighted.
    const pages = parseSearchConsole(sc.page, 'page')
    expect(one(pages, { date: '2026-10-14', metric: 'impressions', dimensionValue: '/fixtures' })).toBe(150)
    expect(one(pages, { date: '2026-10-14', metric: 'positionSum', dimensionValue: '/fixtures' })).toBeCloseTo(6 * 120 + 9 * 30)
    expect(one(parseSearchConsole(sc.country, 'country'), { metric: 'clicks', dimensionValue: 'AUS' })).toBe(40)
  })
})

describe('Cloudflare', () => {
  it('asks for one site over whole UTC days', () => {
    const v = cfVariables('a'.repeat(32), 'b'.repeat(32), '2026-10-07', '2026-10-16')
    expect(v.filter.AND).toEqual([
      { datetime_geq: '2026-10-07T00:00:00Z' },
      { datetime_lt: '2026-10-17T00:00:00Z' },
      { siteTag: 'b'.repeat(32) },
    ])
    expect(cfPageloadQuery(500)).toContain('requestPath: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: 500,')
  })

  it('maps page loads', () => {
    const rows = parseCfPageloads(cf.pageloads)
    expect(one(rows, { date: '2026-10-16', metric: 'visits', dimension: '' })).toBe(171)
    expect(one(rows, { date: '2026-10-16', metric: 'pageviews', dimension: '' })).toBe(402)
    expect(one(rows, { date: '2026-10-16', metric: 'pageviews', dimension: 'requestPath', dimensionValue: '/leagues/tnl' })).toBe(82)
    expect(one(rows, { date: '2026-10-16', metric: 'visits', dimension: 'refererHost', dimensionValue: '(direct)' })).toBe(61)
    expect(one(rows, { date: '2026-10-16', metric: 'visits', dimension: 'countryName', dimensionValue: 'AU' })).toBe(165)
  })

  it('maps Core Web Vitals to ms and skips missing ones', () => {
    const rows = parseCfVitals(cf.vitals)
    expect(one(rows, { date: '2026-10-16', metric: 'lcpP75' })).toBe(1830)
    expect(one(rows, { date: '2026-10-16', metric: 'inpP75' })).toBe(96)
    expect(one(rows, { date: '2026-10-16', metric: 'clsP75' })).toBe(0.02)
    expect(find(rows, { date: '2026-10-15', metric: 'inpP75' })).toEqual([])
    expect(one(rows, { date: '2026-10-15', metric: 'vitalsSamples' })).toBe(260)
  })

  it('reads GraphQL errors', () => {
    expect(cfError(cf.error)).toBe('not authorized for that account')
    expect(cfError(cf.pageloads)).toBeNull()
    expect(parseCfPageloads(cf.error)).toEqual([])
  })
})

describe('tags', () => {
  const settings = { ...DEFAULT_SETTINGS.analytics, cfBeaconToken: 'c'.repeat(32), searchConsoleVerification: 'abcDEF123_-xyz' }

  it('emits nothing unless the page is indexable (production on www)', () => {
    expect(analyticsTags(settings, false)).toEqual({ ga4: null, cfBeaconToken: null, searchConsoleVerification: null })
    expect(analyticsTags(settings, true)).toEqual({
      ga4: { id: 'GT-PLFFMCMT', loading: 'interaction' },
      cfBeaconToken: 'c'.repeat(32),
      searchConsoleVerification: 'abcDEF123_-xyz',
    })
    expect(analyticsTags({ ...settings, ga4MeasurementId: '' }, true).ga4).toBeNull()
  })

  it('loads gtag.js lazily with consent defaults, and is valid JavaScript', () => {
    const js = ga4LoaderScript('GT-PLFFMCMT', 'interaction')
    expect(js).toContain(`ad_storage:'denied'`)
    expect(js).toContain('"GT-PLFFMCMT","interaction"')
    expect(js.length).toBeLessThan(1200)
    expect(() => new Function(js)).not.toThrow()
    expect(() => new Function(ga4LoaderScript('G-ABC123', 'eager'))).not.toThrow()
  })

  it('runs: queues config at once and injects gtag.js on the first interaction', () => {
    const listeners = new Map<string, () => void>()
    const appended: { src: string }[] = []
    const w = {
      addEventListener: (e: string, f: () => void) => listeners.set(e, f),
      removeEventListener: (e: string) => listeners.delete(e),
    } as Record<string, unknown>
    const d = {
      visibilityState: 'visible',
      addEventListener: () => {},
      createElement: () => ({ src: '', async: false }),
      head: { appendChild: (s: { src: string }) => appended.push(s) },
    }
    const timers: (() => void)[] = []
    const run = new Function('window', 'document', 'navigator', 'setTimeout', ga4LoaderScript('GT-PLFFMCMT', 'interaction'))
    run(w, d, { globalPrivacyControl: false }, (f: () => void) => timers.push(f))
    expect((w.dataLayer as unknown[]).length).toBe(3)
    expect(appended).toHaveLength(0)
    listeners.get('scroll')!()
    expect(appended[0]!.src).toBe('https://www.googletagmanager.com/gtag/js?id=GT-PLFFMCMT')
    timers[0]!() // the fallback timer later does nothing
    expect(appended).toHaveLength(1)
  })
})

describe('analytics settings', () => {
  it('validates ids and keeps defaults', () => {
    const ok = checkSetting('analytics', {
      ...DEFAULT_SETTINGS.analytics,
      ga4MeasurementId: 'g-abc1234',
      ga4PropertyId: '312345678',
      cfAccountId: 'A'.repeat(32),
      searchConsoleSite: 'sc-domain:tempevb.com',
      searchConsoleVerification: '<meta name="google-site-verification" content="AbC_123-xyz987" />',
      backfillDays: '30',
    })
    expect(ok.ok && ok.value).toMatchObject({
      ga4MeasurementId: 'G-ABC1234',
      cfAccountId: 'a'.repeat(32),
      searchConsoleVerification: 'AbC_123-xyz987',
      backfillDays: 30,
      tagLoading: 'interaction',
    })
    expect(checkSetting('analytics', { ga4PropertyId: 'abc' }).ok).toBe(false)
    expect(checkSetting('analytics', { searchConsoleSite: 'tempevb.com' }).ok).toBe(false)
    expect(checkSetting('analytics', { searchConsoleSite: 'https://www.tempevb.com/' }).ok).toBe(true)
    expect(checkSetting('analytics', { backfillDays: 9999 }).ok).toBe(false)
  })
})
