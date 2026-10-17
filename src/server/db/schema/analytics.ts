import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { id, timestamps } from './columns'
import { analyticsFetchStatuses, analyticsSources } from './enums'

// Analytics (docs/admin.md §2): a daily cron pulls GA4, Search Console and Cloudflare Web Analytics into D1, and the
// admin Stats page reads only these tables. See docs/data-model-phase6.md "Analytics".
//
// Budget: D1 free allows 100k rows written a day. Store totals plus the top N (≤ 50) per dimension per day, and
// upsert (the primary key makes a re-fetch of the same day replace its rows).

/**
 * One number: `value` of `metric` on `date` from `source`, optionally broken down by `dimension` = `dimension_value`.
 * Totals use dimension '' and dimension_value ''. Examples:
 *   ga4 / 2026-10-17 / activeUsers / '' / '' = 412
 *   ga4 / 2026-10-17 / screenPageViews / pagePath / /leagues/tnl = 96
 *   search_console / 2026-10-17 / clicks / query / tempe volleyball = 31
 *   cloudflare / 2026-10-17 / visits / country / AU = 380
 *   cloudflare / 2026-10-17 / lcpP75 / '' / '' = 1830 (ms)
 * `date` is the source's own reporting day (GA4: the property's time zone, Australia/Sydney; Search Console: US
 * Pacific; Cloudflare: UTC). The Stats page labels it as such.
 */
export const analyticsDaily = sqliteTable(
  'analytics_daily',
  {
    source: text('source', { enum: analyticsSources }).notNull(),
    /** YYYY-MM-DD. */
    date: text('date').notNull(),
    metric: text('metric').notNull(),
    dimension: text('dimension').notNull().default(''),
    dimensionValue: text('dimension_value').notNull().default(''),
    value: real('value').notNull(),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.date, t.metric, t.dimension, t.dimensionValue] }),
    // The Stats page: one metric over a date range, totals or a breakdown.
    index('analytics_daily_source_metric_dimension_date_idx').on(t.source, t.metric, t.dimension, t.date),
    // Pruning old rows.
    index('analytics_daily_date_idx').on(t.date),
  ],
)

/** One cron fetch per source per run: what it asked for and how it went. Prune to ~90 days. */
export const analyticsFetches = sqliteTable(
  'analytics_fetches',
  {
    id: id(),
    source: text('source', { enum: analyticsSources }).notNull(),
    status: text('status', { enum: analyticsFetchStatuses }).notNull().default('running'),
    /** UTC ISO. */
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    /** YYYY-MM-DD, the days fetched (inclusive). */
    rangeStart: text('range_start'),
    rangeEnd: text('range_end'),
    rowsWritten: integer('rows_written').notNull().default(0),
    error: text('error'),
    ...timestamps(),
  },
  (t) => [
    index('analytics_fetches_source_started_at_idx').on(t.source, t.startedAt),
    index('analytics_fetches_started_at_idx').on(t.startedAt),
  ],
)

/** Per-source state, one row per source: where the next fetch starts and the last outcome. */
export const analyticsState = sqliteTable('analytics_state', {
  source: text('source', { enum: analyticsSources }).primaryKey(),
  /** Off = the cron skips it (e.g. credentials not set yet). */
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** YYYY-MM-DD: the last day fully fetched. The next run starts after it (sources revise recent days, so re-fetch ~3). */
  lastCompleteDate: text('last_complete_date'),
  /** UTC ISO. */
  lastSuccessAt: text('last_success_at'),
  lastErrorAt: text('last_error_at'),
  lastError: text('last_error'),
  /** Source-specific extras (property ids, paging cursors). */
  cursor: text('cursor', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps(),
})

export type AnalyticsDailyRow = typeof analyticsDaily.$inferSelect
export type NewAnalyticsDailyRow = typeof analyticsDaily.$inferInsert
export type AnalyticsFetch = typeof analyticsFetches.$inferSelect
export type NewAnalyticsFetch = typeof analyticsFetches.$inferInsert
export type AnalyticsState = typeof analyticsState.$inferSelect
export type NewAnalyticsState = typeof analyticsState.$inferInsert
