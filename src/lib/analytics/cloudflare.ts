import { addDays } from './dates'
import { cleanValue, mergeRows, normalisePagePath, num, topPerDay, type DailyRow } from './rows'

// Cloudflare GraphQL Analytics API, Web Analytics (RUM) datasets. Dates are UTC.
// https://developers.cloudflare.com/analytics/graphql-api/  (token scope: Account Analytics: Read)
//
// Two requests: page loads (visits and page views by day, path, referrer, country and device), then Core Web
// Vitals. They're separate so a problem with the vitals dataset never loses the traffic numbers.

export const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql'

export const CF_RANK: Record<string, string> = {
  requestPath: 'pageviews',
  refererHost: 'visits',
  countryName: 'visits',
  deviceType: 'visits',
}

const BREAKDOWNS = ['requestPath', 'refererHost', 'countryName', 'deviceType'] as const

const group = (limit: number, alias: string, dim?: string) =>
  `${alias}: rumPageloadEventsAdaptiveGroups(filter: $filter, limit: ${Math.trunc(limit)}, orderBy: [count_DESC]) { count sum { visits } dimensions { date${dim ? ` ${dim}` : ''} } }`

/** `limit`: TOP_N per day of the range (rowLimit in ga4.ts) for breakdowns, so responses stay small. */
export const cfPageloadQuery = (
  limit: number,
) => `query TempeRum($accountTag: string!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    ${[group(1000, 'totals'), ...BREAKDOWNS.map((d) => group(limit, d, d))].join('\n    ')}
  } }
}`

/** Vitals: p75 per day, as the Web Analytics dashboard shows them. */
export const CF_VITALS_QUERY = `query TempeVitals($accountTag: string!, $filter: AccountRumWebVitalsEventsAdaptiveGroupsFilter_InputObject) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    vitals: rumWebVitalsEventsAdaptiveGroups(filter: $filter, limit: 1000) {
      count
      dimensions { date }
      quantiles { largestContentfulPaintP75 interactionToNextPaintP75 cumulativeLayoutShiftP75 firstContentfulPaintP75 timeToFirstByteP75 }
    }
  } }
}`

export function cfVariables(accountTag: string, siteTag: string, startDate: string, endDate: string) {
  return {
    accountTag,
    filter: {
      AND: [{ datetime_geq: `${startDate}T00:00:00Z` }, { datetime_lt: `${addDays(endDate, 1)}T00:00:00Z` }, { siteTag }],
    },
  }
}

type Group = { count?: number; sum?: { visits?: number }; dimensions?: Record<string, string | undefined> }
type VitalsGroup = { count?: number; dimensions?: { date?: string }; quantiles?: Record<string, number | null | undefined> }

export type CfResponse<T> = {
  data?: { viewer?: { accounts?: T[] } } | null
  errors?: { message?: string }[] | null
}

/** The first GraphQL error, if any (Cloudflare answers 200 with `errors`). */
export const cfError = (res: CfResponse<unknown>): string | null =>
  res.errors?.length ? (res.errors[0]?.message ?? 'GraphQL error') : null

export function parseCfPageloads(res: CfResponse<Record<string, Group[] | undefined>>): DailyRow[] {
  const account = res.data?.viewer?.accounts?.[0]
  if (!account) return []
  const out: DailyRow[] = []
  for (const g of account.totals ?? []) {
    const date = g.dimensions?.date ?? ''
    out.push({ date, metric: 'visits', dimension: '', dimensionValue: '', value: num(g.sum?.visits) })
    out.push({ date, metric: 'pageviews', dimension: '', dimensionValue: '', value: num(g.count) })
  }
  for (const dimension of BREAKDOWNS) {
    for (const g of account[dimension] ?? []) {
      const date = g.dimensions?.date ?? ''
      const raw = g.dimensions?.[dimension]
      const dimensionValue =
        dimension === 'requestPath'
          ? normalisePagePath(raw)
          : raw
            ? cleanValue(raw)
            : dimension === 'refererHost'
              ? '(direct)'
              : '(not set)'
      out.push({ date, metric: 'visits', dimension, dimensionValue, value: num(g.sum?.visits) })
      out.push({ date, metric: 'pageviews', dimension, dimensionValue, value: num(g.count) })
    }
  }
  return topPerDay(mergeRows(out.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date))), CF_RANK)
}

/** Vitals metric names stored, in ms (CLS is unitless). */
export const CF_VITALS: Record<string, string> = {
  largestContentfulPaintP75: 'lcpP75',
  interactionToNextPaintP75: 'inpP75',
  cumulativeLayoutShiftP75: 'clsP75',
  firstContentfulPaintP75: 'fcpP75',
  timeToFirstByteP75: 'ttfbP75',
}

/**
 * Cloudflare reports RUM timings in microseconds. Anything above a minute can't be milliseconds, so it's
 * converted; small values are taken as ms already. CLS is unitless (0–1, scaled down if sent ×1000).
 */
const toMs = (v: number) => (v > 60_000 ? v / 1000 : v)
const toCls = (v: number) => (v > 10 ? v / 1000 : v)

export function parseCfVitals(res: CfResponse<{ vitals?: VitalsGroup[] }>): DailyRow[] {
  const out: DailyRow[] = []
  for (const g of res.data?.viewer?.accounts?.[0]?.vitals ?? []) {
    const date = g.dimensions?.date ?? ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    out.push({ date, metric: 'vitalsSamples', dimension: '', dimensionValue: '', value: num(g.count) })
    for (const [field, metric] of Object.entries(CF_VITALS)) {
      const raw = g.quantiles?.[field]
      if (raw === null || raw === undefined) continue
      const v = num(raw)
      out.push({ date, metric, dimension: '', dimensionValue: '', value: metric === 'clsP75' ? toCls(v) : toMs(v) })
    }
  }
  return mergeRows(out)
}
