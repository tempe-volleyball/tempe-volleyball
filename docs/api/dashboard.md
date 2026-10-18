# Dashboard API

What the admin home page (`/admin`, docs/admin.md §4) calls. The route is `src/pages/api/admin/dashboard.ts`, the logic
`src/server/dashboard.ts` (tests in `src/server/dashboard.test.ts`). Auth, errors and same-origin rules are as in
[seasons.md](seasons.md#basics). Read-only: nothing here writes.

## `GET /api/admin/dashboard`

Editors and up (the role is re-read from D1). Enrolment, recent activity and setup are for admins and owners only;
editors get `null` / `[]` for them.

```ts
{
  today: 'YYYY-MM-DD',                 // Sydney
  upcoming: DashboardDay[],            // match days from today to six days ahead, published seasons, oldest first
  needsResults: DashboardDay[],        // earlier match days (up to 120 days back) with games still unpublished, or a
                                       // saved draft that differs from what's published; newest first
  enrolment: TargetSummary[] | null,   // admins+: open targets, and any with a waitlist, offers out or emails to confirm
  content: {
    draftProgrammes: { id, name, code, kind }[],   // status draft (the content map's new programmes)
    draftPages: { id, title, path }[],
    pagesToReview: { id, title, path }[],          // never edited in the admin, with a newer saved revision waiting
    draftPosts: { id, title }[],
  },                                   // each list at most 20
  recent: AuditRow[] | null,           // admins+: the latest 8 audit entries
  setup: { key: 'resend' | 'turnstile' | 'analytics' | 'payid', ok: false, text, href }[],  // admins+: only what's missing
}

DashboardDay = {
  matchDayId, seasonId, seasonName, leagueCode, leagueName, date, matchDay,
  kind: 'regular' | 'semi' | 'final',
  firstStart: 'HH:MM' | null,
  games: number,          // games needing a result (not cancelled, postponed or TBD)
  published: number,      // of those, with a published result
  unpublished: number,    // games whose saved draft differs from the published result
  resultsPublishedAt: string | null,
}
```

`TargetSummary` is the enrolment list's row ([enrolment.md](enrolment.md)). `href` values are admin paths (inside the
`/admin` base), e.g. `/settings#settings-payid`.

**Cost:** one `db.batch()` of five grouped reads (match days with per-day counts from a join of matches and both result
kinds, draft programmes, draft pages, pages to review, draft posts), plus `listTargets` and `listAudit` for admins, the
settings read and the role check: about 15 D1 queries. Joined columns are aliased (`md_id`, `season_name` …) because D1
keys batch rows by column name.
