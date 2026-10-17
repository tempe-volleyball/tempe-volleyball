import { compactDate, daysBetween } from './dates'
import { TOP_N, cleanValue, mergeRows, normalisePagePath, num, topPerDay, type DailyRow } from './rows'

// GA4 Data API (properties.batchRunReports, at most 5 reports per call). One call fetches a date range:
// totals by day, and by day per page, traffic source (channel group and source), device and country.
// https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/batchRunReports

export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'

export const ga4Url = (propertyId: string) => `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:batchRunReports`

/** Totals stored per day. activeUsers isn't additive over days; the Stats page labels its sum as "daily visitors". */
export const GA4_TOTAL_METRICS = ['activeUsers', 'newUsers', 'sessions', 'screenPageViews', 'engagedSessions'] as const

/** Breakdown dimension -> the metric that ranks its top 50 per day. */
export const GA4_RANK: Record<string, string> = {
  pagePath: 'screenPageViews',
  sessionDefaultChannelGroup: 'sessions',
  sessionSource: 'sessions',
  deviceCategory: 'activeUsers',
  country: 'activeUsers',
}

/**
 * Rows asked for per breakdown report: TOP_N per day of the range, biggest first. That keeps the response (and
 * the CPU spent parsing it) small; a value that's top-50 on one day but small over the range can be cut, which
 * is fine for "top pages". Measured: ~2,000 response rows map in ~3 ms; 18,000 take ~15 ms, too much for 10 ms.
 */
export const rowLimit = (startDate: string, endDate: string) => Math.min(10_000, TOP_N * (daysBetween(startDate, endDate) + 1))

type ReportRequest = {
  dateRanges: { startDate: string; endDate: string }[]
  dimensions: { name: string }[]
  metrics: { name: string }[]
  orderBys?: { metric: { metricName: string }; desc: boolean }[]
  limit: number
  keepEmptyRows?: boolean
}

export function ga4Request(startDate: string, endDate: string): { requests: ReportRequest[] } {
  const report = (dims: string[], metrics: readonly string[]): ReportRequest => ({
    dateRanges: [{ startDate, endDate }],
    dimensions: ['date', ...dims].map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    ...(dims.length ? { orderBys: [{ metric: { metricName: metrics[0]! }, desc: true }] } : {}),
    limit: dims.length ? rowLimit(startDate, endDate) : daysBetween(startDate, endDate) + 1,
  })
  return {
    requests: [
      report([], GA4_TOTAL_METRICS),
      report(['pagePath'], ['screenPageViews', 'activeUsers']),
      report(['sessionDefaultChannelGroup', 'sessionSource'], ['sessions']),
      report(['deviceCategory'], ['activeUsers', 'sessions']),
      report(['country'], ['activeUsers']),
    ],
  }
}

type Report = {
  dimensionHeaders?: { name: string }[]
  metricHeaders?: { name: string }[]
  rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[]
}

export type Ga4Response = { reports?: Report[] }

/** batchRunReports response -> analytics_daily rows (top 50 per dimension per day). */
export function parseGa4(res: Ga4Response): DailyRow[] {
  const out: DailyRow[] = []
  for (const report of res.reports ?? []) {
    const dims = (report.dimensionHeaders ?? []).map((h) => h.name)
    const metrics = (report.metricHeaders ?? []).map((h) => h.name)
    const dateAt = dims.indexOf('date')
    if (dateAt < 0) continue
    for (const row of report.rows ?? []) {
      const dv = row.dimensionValues ?? []
      const date = compactDate(dv[dateAt]?.value ?? '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      const breakdowns = dims.flatMap((d, i) => (i === dateAt ? [] : [[d, dv[i]?.value] as const]))
      metrics.forEach((metric, i) => {
        const value = num(row.metricValues?.[i]?.value)
        if (breakdowns.length === 0) out.push({ date, metric, dimension: '', dimensionValue: '', value })
        for (const [dimension, raw] of breakdowns)
          out.push({ date, metric, dimension, dimensionValue: dimension === 'pagePath' ? normalisePagePath(raw) : cleanValue(raw), value })
      })
    }
  }
  return topPerDay(mergeRows(out), GA4_RANK)
}
