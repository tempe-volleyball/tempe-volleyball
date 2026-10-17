# Stats API

What Admin → Stats and Admin → Pages call (docs/admin.md §2). Routes are in `src/pages/api/admin/stats/`, the logic in
`src/server/analytics/` (fetch, stats, Google auth) and the pure parsing in `src/lib/analytics/`. Auth, errors and
same-origin rules are as in [seasons.md](seasons.md#basics). Everything is read from D1; nothing here calls Google or
Cloudflare except `POST /fetch`.

## `GET /api/admin/stats?from=YYYY-MM-DD&to=YYYY-MM-DD`

Editors and up. Both dates are optional: the default is the 28 days up to yesterday in Sydney. At most 400 days
(`400 invalid_input` otherwise). Returns `StatsView` (`src/server/analytics/stats.ts`) plus `canFetch`:

```ts
{
  range: { from, to },
  sources: [{ source: 'ga4' | 'search_console' | 'cloudflare', label, configured, missing: string[], enabled,
              timeZone, lastCompleteDate, lastSuccessAt, lastErrorAt, lastError, hasData }],
  fetches: [{ id, source, status, startedAt, finishedAt, rangeStart, rangeEnd, rowsWritten, error }],  // newest 15
  series: { ga4?: { activeUsers: [{ date, value }], newUsers, sessions, screenPageViews, engagedSessions },
            search_console?: { clicks, impressions, positionSum },
            cloudflare?: { visits, pageviews, lcpP75, inpP75, clsP75, fcpP75, ttfbP75, vitalsSamples } },
  top: { ga4Pages, ga4Channels, ga4Sources, ga4Devices, ga4Countries, scQueries, scPages, scDevices, scCountries,
         cfPaths, cfReferrers, cfCountries, cfDevices },   // each up to 20 rows: { value, <metric>: number, … }
  business: [{ programmeId, programme, kind, status, registrations, teams }] | null,  // null for editors
  canFetch: boolean,   // admins and owners
}
```

- `series` has only the days that have rows; the page shows other days as gaps.
- `missing` explains a source that isn't configured ("the GA4 property ID (Settings → Analytics)", "the
  CF_ANALYTICS_TOKEN secret" …). It never contains secret values.
- Search Console rows carry `clicks`, `impressions` and `positionSum`: CTR = clicks / impressions, average position =
  positionSum / impressions (`src/lib/analytics/view.ts`).
- Vitals are daily p75s in ms (CLS unitless). Over a range, weight each day by `vitalsSamples` (`weightedDaily`).

## `POST /api/admin/stats/fetch` `{ source }`

Admins and owners. Fetches that source now: its next window, or its last few days again when it's up to date. Ignores
the 3-hour retry backoff, but not the lock (`busy` when the cron is fetching it). Audited as `analytics.fetch` with the
result as `after`. Always `200 { result }`, where `result` is `RunResult` (`src/server/analytics/fetch.ts`):

- `{ status: 'ok', source, start, end, rows, warning? }` (`warning`, e.g. Core Web Vitals not fetched)
- `{ status: 'error', source, start, end, error }` (the source's own message, e.g. a missing permission)
- `{ status: 'busy', source }`
- `{ status: 'idle', reason }` (not connected yet: `reason` lists what's missing)

## `GET /api/admin/stats/pages`

Editors and up. Page views per path over the last 30 days, for the Views column in Admin → Pages:
`{ source: 'ga4' | 'cloudflare' | null, days: 30, views: { '/leagues/tnl': 812, … } }`. GA4 when it has data, else
Cloudflare; `source: null` when neither has any. Paths have no trailing slash or query, like page paths.

## The cron

`runJobs()` in `src/server/cron.ts` calls `runAnalytics(db, deps, now)` every hour; the result is in the cron's log
line as `analytics`. It fetches the most overdue due source, or returns `{ status: 'idle', reason: 'Nothing due.' }`.
