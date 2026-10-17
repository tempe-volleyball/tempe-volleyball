import { dateRange } from './dates'

// Small pure helpers for the admin Stats page (src/admin/screens/Stats.tsx): range sums, Search Console ratios,
// Core Web Vitals over a range, and the daily series with gaps for days that have no data.

export type Point = { date: string; value: number }

export const sum = (points: readonly Point[] | undefined) => (points ?? []).reduce((a, p) => a + p.value, 0)

/** Every day of the range, with null where the source has no row (not fetched yet, or no data that day). */
export function fillDays(points: readonly Point[] | undefined, from: string, to: string): { date: string; value: number | null }[] {
  const byDate = new Map((points ?? []).map((p) => [p.date, p.value]))
  return dateRange(from, to).map((date) => ({ date, value: byDate.get(date) ?? null }))
}

/** Search Console: CTR and average position from the additive metrics. */
export const ctr = (clicks: number, impressions: number) => (impressions > 0 ? clicks / impressions : null)
export const avgPosition = (positionSum: number, impressions: number) => (impressions > 0 ? positionSum / impressions : null)

/**
 * A daily p75 over a range, weighted by each day's sample count (a close stand-in for the range's own p75,
 * which the daily rows can't give exactly).
 */
export function weightedDaily(values: readonly Point[] | undefined, samples: readonly Point[] | undefined): number | null {
  const n = new Map((samples ?? []).map((p) => [p.date, p.value]))
  let total = 0
  let weight = 0
  for (const p of values ?? []) {
    const w = n.get(p.date) ?? 1
    total += p.value * w
    weight += w
  }
  return weight > 0 ? total / weight : null
}

/** Google's Core Web Vitals thresholds (p75): good, needs improvement, poor. */
export const VITALS = {
  lcpP75: { label: 'Largest Contentful Paint', short: 'LCP', good: 2500, poor: 4000, unit: 'ms' },
  inpP75: { label: 'Interaction to Next Paint', short: 'INP', good: 200, poor: 500, unit: 'ms' },
  clsP75: { label: 'Cumulative Layout Shift', short: 'CLS', good: 0.1, poor: 0.25, unit: '' },
  fcpP75: { label: 'First Contentful Paint', short: 'FCP', good: 1800, poor: 3000, unit: 'ms' },
  ttfbP75: { label: 'Time to First Byte', short: 'TTFB', good: 800, poor: 1800, unit: 'ms' },
} as const

export type VitalKey = keyof typeof VITALS
export type Rating = 'good' | 'needs improvement' | 'poor'

export const rate = (key: VitalKey, v: number): Rating =>
  v <= VITALS[key].good ? 'good' : v <= VITALS[key].poor ? 'needs improvement' : 'poor'

export const formatVital = (key: VitalKey, v: number) =>
  VITALS[key].unit === 'ms' ? (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`) : v.toFixed(2)

const nf = new Intl.NumberFormat('en-AU')
export const formatCount = (n: number) => nf.format(Math.round(n))
export const formatPercent = (r: number | null) => (r === null ? '–' : `${(r * 100).toFixed(1)}%`)
