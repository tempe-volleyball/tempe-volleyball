import type { AnalyticsSettings } from '../content/settings'

// The shape every source mapper produces: one number per (date, metric, dimension, value), the rows of
// analytics_daily (src/server/db/schema/analytics.ts). Totals use dimension '' and value ''.

export const sources = ['ga4', 'search_console', 'cloudflare'] as const
export type Source = (typeof sources)[number]

export type DailyRow = { date: string; metric: string; dimension: string; dimensionValue: string; value: number }

/** Keep at most this many values per dimension per day (docs/data-model-phase6.md: writes stay small). */
export const TOP_N = 50

/** Longest dimension value stored (page paths and search queries can be long). */
export const MAX_VALUE_LENGTH = 300

export const sourceLabel: Record<Source, string> = {
  ga4: 'Google Analytics',
  search_console: 'Search Console',
  cloudflare: 'Cloudflare Web Analytics',
}

/** Settings key in AnalyticsSettings.fetch for each source. */
export const fetchSwitch: Record<Source, keyof AnalyticsSettings['fetch']> = {
  ga4: 'ga4',
  search_console: 'searchConsole',
  cloudflare: 'cloudflare',
}

/**
 * Of breakdown rows (dimension ≠ ''), keeps per (date, dimension) only the TOP_N values ranked by that
 * dimension's `rankMetric` (every metric of a kept value is kept, so a top page has both its views and users).
 * Totals pass through.
 */
export function topPerDay(rows: DailyRow[], rankMetric: Record<string, string>, n = TOP_N): DailyRow[] {
  const groups = new Map<string, { value: string; score: number }[]>()
  for (const r of rows) {
    if (!r.dimension || rankMetric[r.dimension] !== r.metric) continue
    const g = `${r.date}\u0000${r.dimension}`
    let list = groups.get(g)
    if (!list) groups.set(g, (list = []))
    list.push({ value: r.dimensionValue, score: r.value })
  }
  const keep = new Set<string>()
  for (const [g, list] of groups) {
    if (list.length > n) list.sort((a, b) => b.score - a.score || (a.value < b.value ? -1 : 1))
    for (const item of list.slice(0, n)) keep.add(`${g}\u0000${item.value}`)
  }
  return rows.filter((r) => !r.dimension || keep.has(`${r.date}\u0000${r.dimension}\u0000${r.dimensionValue}`))
}

/** Trims and shortens a dimension value; blanks become '(not set)'. */
export const cleanValue = (v: string | undefined | null) => {
  const s = (v ?? '').trim()
  return s ? s.slice(0, MAX_VALUE_LENGTH) : '(not set)'
}

/** Adds up rows with the same key (sources sometimes split one value, e.g. a path with and without a slash). */
export function mergeRows(rows: DailyRow[]): DailyRow[] {
  const out = new Map<string, DailyRow>()
  for (const r of rows) {
    const key = `${r.date}\u0000${r.metric}\u0000${r.dimension}\u0000${r.dimensionValue}`
    const prev = out.get(key)
    if (prev) prev.value += r.value
    else out.set(key, { ...r })
  }
  return [...out.values()]
}

export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Page paths from different sources look alike: no query, no trailing slash (except "/"). */
export function normalisePagePath(p: string | undefined | null): string {
  let s = (p ?? '').trim()
  if (!s) return '(not set)'
  try {
    if (/^https?:\/\//i.test(s)) s = new URL(s).pathname
  } catch {
    // keep as is
  }
  s = s.split(/[?#]/)[0] ?? ''
  if (s.length > 1) s = s.replace(/\/+$/, '')
  return cleanValue(s || '/')
}
