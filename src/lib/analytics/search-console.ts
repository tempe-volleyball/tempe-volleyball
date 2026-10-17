import { rowLimit } from './ga4'
import { mergeRows, normalisePagePath, cleanValue, num, topPerDay, type DailyRow } from './rows'

// Search Console API (searchanalytics.query), one request per breakdown. Dates are the property's (US Pacific).
// https://developers.google.com/webmaster-tools/v1/searchanalytics/query
//
// Stored metrics are all additive, so a range or a merged page can simply be summed: clicks, impressions and
// positionSum (= average position × impressions). CTR = clicks / impressions and position = positionSum /
// impressions are worked out when read.

export const SEARCH_CONSOLE_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly'

export const searchConsoleUrl = (site: string) =>
  `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`

/** The breakdowns fetched, besides the daily totals. */
export const SEARCH_CONSOLE_DIMENSIONS = ['query', 'page', 'device', 'country'] as const
export type SearchConsoleDimension = '' | (typeof SEARCH_CONSOLE_DIMENSIONS)[number]

export const SEARCH_CONSOLE_RANK: Record<string, string> = {
  query: 'impressions',
  page: 'impressions',
  device: 'impressions',
  country: 'impressions',
}

export function searchConsoleRequest(startDate: string, endDate: string, dimension: SearchConsoleDimension) {
  return {
    startDate,
    endDate,
    dimensions: dimension ? ['date', dimension] : ['date'],
    type: 'web',
    // Include fresh (not yet final) data; the next runs re-fetch these days.
    dataState: 'all',
    // Sorted by clicks, biggest first; TOP_N per day of the range (see rowLimit).
    rowLimit: rowLimit(startDate, endDate),
  }
}

export type SearchConsoleResponse = {
  rows?: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }[]
}

export function parseSearchConsole(res: SearchConsoleResponse, dimension: SearchConsoleDimension): DailyRow[] {
  const out: DailyRow[] = []
  for (const r of res.rows ?? []) {
    const date = r.keys?.[0] ?? ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const raw = r.keys?.[1]
    const dimensionValue = !dimension
      ? ''
      : dimension === 'page'
        ? normalisePagePath(raw)
        : cleanValue(dimension === 'country' ? raw?.toUpperCase() : raw)
    const impressions = num(r.impressions)
    const base = { date, dimension, dimensionValue }
    out.push(
      { ...base, metric: 'clicks', value: num(r.clicks) },
      { ...base, metric: 'impressions', value: impressions },
      { ...base, metric: 'positionSum', value: num(r.position) * impressions },
    )
  }
  return topPerDay(mergeRows(out), SEARCH_CONSOLE_RANK)
}
