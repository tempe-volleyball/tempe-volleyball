# Programmes, categories and venues API

The admin's programme screens (docs/admin.md §3.1–3.3): leagues, training, development programmes and events, their
sessions, terms and dates, the categories they belong to, and venues with their courts. Everything is under
`/api/admin`, answers JSON, and lives in `src/server/programmes/` (routes in `src/pages/api/admin/{programmes,
sessions,terms,events,categories,venues,courts}`). The data model is in [docs/data-model-phase6.md](../data-model-phase6.md).

## Basics

Same as [seasons.md](seasons.md#basics): the middleware 401s without a session, unsafe methods must be same-origin,
errors are `{ error, message }` with `message` written for the organiser, and writes that change the public site
return `cache: 'purged' | 'disabled' | 'failed' | 'nothing'`.

- **Roles.** Editors (and up) can read everything here. Every write needs **admin**; the role is re-read from D1.
- **Concurrency.** Programme and category writes take `baseUpdatedAt` (programmes require it; categories, venues,
  sessions, terms and events check it when sent). A stale one is `409 conflict`.
- **Audit.** Every write adds an `audit_log` row in the same batch: `programme.create|update|enrolment|status|delete`
  (`programme.enrolment` when only enrolment fields changed), `category.*`, `venue.*`, `court.*`, `session.*`,
  `term.*`, `event.*` (`*.status` when only the status changed). Before/after hold only the changed fields.
- **Limits.** Every call stays well under 50 D1 queries and 100 bound parameters per statement (tests assert it).
  A weekly run adds at most 60 sessions.

## Programmes

| Method and path                         | Role   | Body                                                                 | Returns                               |
| --------------------------------------- | ------ | -------------------------------------------------------------------- | ------------------------------------- |
| `GET /api/admin/programmes?kind=`       | editor |                                                                      | `{ programmes: ProgrammeListItem[] }` |
| `GET /api/admin/programmes/choices`     | editor |                                                                      | `ProgrammeChoices`                    |
| `POST /api/admin/programmes`            | admin  | `{ kind, name, code, categoryId, weekday, slug?, status?, …fields }` | `ProgrammeView & { cache }` (201)     |
| `GET /api/admin/programmes/:id`         | editor |                                                                      | `ProgrammeView`                       |
| `PATCH /api/admin/programmes/:id`       | admin  | `{ baseUpdatedAt, …fields }`                                         | `ProgrammeView & { cache }`           |
| `POST /api/admin/programmes/:id/status` | admin  | `{ status: 'draft' \| 'active' \| 'retired', baseUpdatedAt? }`       | `ProgrammeView & { cache }`           |
| `DELETE /api/admin/programmes/:id`      | admin  |                                                                      | `{ ok, cache }`                       |

Editable fields (any subset; `null` clears a nullable one): `name`, `code` (upper-cased, `PROGRAMME_CODE_PATTERN`),
`slug`, `categoryId`, `weekday` (0 = Sunday), `defaultVenueId`, `format` (leagues only), `sort`, `startTime`,
`endTime` (`HH:MM`), `scheduleLabel` (null = generated), `description` (TipTap JSON blocks; sanitised and rendered on
the server like page bodies), `summaryLine` (null = generated), `moreInfoUrl` (path or http(s)), `menuVisible`,
`ageMin`, `ageMax`, `seoTitle`, `seoDescription`, `imageId`, and enrolment: `enrolmentOpen`, `enrolmentOpensAt`,
`enrolmentClosesAt` (UTC ISO; the admin converts from Sydney time with `sydneyToUtc`), `nextStartsOn`,
`nextStartsText`, `enrolmentFormId`, `capTeams`, `capPlayers`, `priceCents`, `allowTeamEntries`, `allowFreeAgents`,
`waitlistEnabled`, `waitlistOfferHours`, and sign-ups (docs/interest.md): `signupMode` (`'interest'` |
`'enrolment'`; `null` or `''` = the kind's default, `defaultSignupMode()`), `interestOpen`, `depositPlayerCents`,
`depositTeamCents` (AUD cents, null = no deposit) and `interestText` (≤ 500, null = generated). Enrolment and sign-up
changes alone are audited as `programme.enrolment` and purge like other non-listing fields (the programme's page, its
category pages, every programme listing and the pages whose blocks use it).

Rules:

- `kind` is fixed at creation. `code` and `slug` are unique across every kind (`409`), and the programme's URL
  (`programmePath(kind, slug)`) can't be a content page's path (`409`). The slug defaults to the code for leagues
  (`/leagues/tnl`) and to the name for other kinds (`/training/scrim-and-coached-training`).
- New programmes are drafts unless `status: 'active'` is sent. A programme needs a category to become active.
- **Status:** draft → active → retired → active (reactivate restores everything, menu position included). Active →
  draft only while it has no history. `retiredAt` is set on retire and cleared on reactivate; `active` mirrors
  `status === 'active'`.
- **URL change:** on a programme that isn't a draft, the old URL and every page under it (its season, term or event
  pages) get 301s to the new ones, redirects that pointed at the old URLs (or at one of their `#tabs`) are repointed
  (no chains), and redirects _from_ the new URLs are dropped (`moveTreeStatements` in `common.ts`), all in the save's
  batch. `/leagues/fixtures?league=<old>` follows that 301 too (`renamedLeagueSlug` in `src/server/site.ts`).
- **Delete** only while it has no seasons, sessions, terms, events or products, no menu item links to it and no
  page's Ladder/Fixtures block uses it (`ProgrammeView.history` says which, `canDelete` sums it up). Otherwise `409`:
  retire it.

```ts
type ProgrammeView = {
  programme: Programme // the full leagues row
  path: string // /leagues/tnl …
  category: { id; name; slug; status } | null
  venue: { id; name; address } | null
  generated: {
    summaryLine: string // generated (what shows when summaryLine is null)
    shownSummaryLine: string // what shows now
    schedule: string // "Thursdays 8–10pm" or the scheduleLabel
    generatedSchedule: string
    nextStarts: string // "Next season starts Thursday 14 January 2027", the override text, or ''
    nextInstanceDate: string | null
    signupMode: 'interest' | 'enrolment' // effective (the row's, else the kind's default)
    defaultSignupMode: 'interest' | 'enrolment'
    interestLine: string // the join section's generated line (generatedInterestLine in src/lib/programme-text.ts)
  }
  enrolmentOpenNow: boolean // enrolmentOpen() from src/lib/programmes.ts, programme-level
  history: { seasons; sessions; terms; events; products; menuItems: { id; label }[]; pages: { id; title; path }[] }
  canDelete: boolean
  choices: { categories; venues; forms: { id; name; archived }[] }
}
type ProgrammeListItem = Omit<Programme, 'description'> & { path; category; venue; generated; enrolmentOpenNow; instances: number }
```

Leagues still list with their seasons through `GET /api/admin/leagues` (seasons.md); seasons are created there too.

## Sessions, terms and events

| Method and path                                            | Role   | Body                                                                                                                                      | Returns                              |
| ---------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `GET /api/admin/programmes/:id/sessions?termId=&from=&to=` | editor | (`termId=` empty = sessions not in a term)                                                                                                | `{ sessions: SessionRow[] }`         |
| `POST /api/admin/programmes/:id/sessions`                  | admin  | `{ date }` or `{ from, to, weekday?, everyWeeks?, skip? }`, plus `termId?`, times, `venueId?`, `courtId?`, `title?`, `note?`, `capacity?` | `{ added, skipped, cache }` (201)    |
| `PATCH /api/admin/sessions/:id`                            | admin  | `{ baseUpdatedAt?, date?, startTime?, endTime?, venueId?, courtId?, title?, note?, status?, capacity? }`                                  | `{ session, cache }`                 |
| `DELETE /api/admin/sessions/:id`                           | admin  |                                                                                                                                           | `{ ok, cache }`                      |
| `GET /api/admin/programmes/:id/terms`                      | editor |                                                                                                                                           | `{ terms: TermRow[] }`               |
| `POST /api/admin/programmes/:id/terms`                     | admin  | `{ name, startDate, endDate?, slug?, weekday?, times, venueId?, courtId?, ageGroup?, note?, capacity?, addSessions? }`                    | `{ term, cache }` (201)              |
| `PATCH /api/admin/terms/:id`, `DELETE …`                   | admin  | the same fields, `status?`                                                                                                                | `{ term, cache }` / `{ ok, cache }`  |
| `GET /api/admin/programmes/:id/events`                     | editor |                                                                                                                                           | `{ events: EventRow[] }`             |
| `POST /api/admin/programmes/:id/events`                    | admin  | `{ startDate, endDate?, name?, slug?, startTime?, endTime?, venueId?, note?, capacity?, capacityTeams? }`                                 | `{ event, cache }` (201)             |
| `PATCH /api/admin/events/:id`, `DELETE …`                  | admin  | the same fields, `status?`                                                                                                                | `{ event, cache }` / `{ ok, cache }` |

- Sessions belong to **training** programmes, or to a **development** term (`termId`). Terms belong to development
  programmes, events to event programmes (`400` otherwise).
- **Products.** Each training session, term and event gets its product when it's created (one per target:
  `products.session_id` / `term_id` / `event_id`, `kind` `training_session` / `development_term` / `event_entry`,
  slug `<kind>-<target id>`, `price_cents` copied from the programme or 0). `capacity` / `capacityTeams` on these
  endpoints are that product's caps (null = the programme's). Term sessions have no product: people enrol in the term.
  The product's name and dates follow the instance on edits.
- **Weekly runs** start on the first `weekday` (default: the term's, else the programme's day) on or after `from`, every
  `everyWeeks` weeks, up to `to`, minus `skip`. Times, venue and court default to the term's, then the programme's.
  Dates that already have a session are skipped and reported in `skipped`, so a repeated run is harmless.
- **Moving:** changing a session's date (or an event's start date) keeps the first date in `originalDate` /
  `originalStartDate`; moving it back clears it. `status` is `scheduled | postponed | cancelled`, `note` the public
  reason.
- **Delete** is refused (`409`) once anyone enrolled (registrations or team entries on its product); cancel instead.
  Deleting a term deletes its sessions.
- A term or event slug change on a public programme leaves a 301 for its page.

`SessionRow`, `TermRow` and `EventRow` are the rows plus `product: { id, capacity, capacityTeams, active, priceCents,
enrolled, teams } | null` (spot-holding registrations and live, non-waitlist team entries); terms and events add
`path`, terms `sessions` (count).

## Categories

| Method and path                    | Role   | Body                                                                       | Returns                              |
| ---------------------------------- | ------ | -------------------------------------------------------------------------- | ------------------------------------ |
| `GET /api/admin/categories`        | editor |                                                                            | `{ categories: CategoryListItem[] }` |
| `POST /api/admin/categories`       | admin  | `{ name, slug?, intro?, seoTitle?, seoDescription?, ogImageId?, status? }` | `{ category, cache }` (201)          |
| `PATCH /api/admin/categories/:id`  | admin  | `{ baseUpdatedAt?, …same fields }`                                         | `{ category, cache }`                |
| `PUT /api/admin/categories/order`  | admin  | `{ ids }`: every category id, first first                                  | `{ categories, cache }`              |
| `DELETE /api/admin/categories/:id` | admin  |                                                                            | `{ ok, cache }`                      |

- The slug is the landing page path (`/<slug>`): a valid page path, not reserved (`/leagues`, `/training`,
  `/programs`, `/events`, `/admin` … are), and not a content page's path. Pages can't take a category's path either
  (`createPage`/`updatePage` check it).
- A slug change on a category that isn't a draft leaves a 301.
- Retiring (or going back to draft) is refused while it has **active** programmes. Delete only when no programme of any
  status is in it and the menu doesn't link to it.
- `CategoryListItem` = the row plus `path`, `programmes: { draft, active, retired }` and `menuItems` (count).

## Venues and courts

| Method and path                     | Role   | Body                                                     | Returns                  |
| ----------------------------------- | ------ | -------------------------------------------------------- | ------------------------ |
| `GET /api/admin/venues`             | editor |                                                          | `{ venues: VenueRow[] }` |
| `POST /api/admin/venues`            | admin  | `{ name, slug?, address?, mapUrl?, directions?, sort? }` | `{ venue, cache }` (201) |
| `PATCH /api/admin/venues/:id`       | admin  | the same fields, `baseUpdatedAt?`                        | `{ venue, cache }`       |
| `DELETE /api/admin/venues/:id`      | admin  |                                                          | `{ ok, cache }`          |
| `POST /api/admin/venues/:id/courts` | admin  | `{ name }`                                               | `{ venue, cache }` (201) |
| `PUT /api/admin/venues/:id/courts`  | admin  | `{ ids }`: the venue's court ids in order                | `{ venue, cache }`       |
| `PATCH /api/admin/courts/:id`       | admin  | `{ name }`                                               | `{ venue, cache }`       |
| `DELETE /api/admin/courts/:id`      | admin  |                                                          | `{ venue, cache }`       |

- Court names are unique within a venue (case-insensitive). Renaming keeps the id, so draws and results follow.
- A venue can be deleted only with no courts and nothing using it (programmes, terms, sessions, events). A court only
  when no match, term or session uses it and no season names it as a default court or a court override.
- `VenueRow` = the row plus `courts: (Court & { matches, sessions, terms })[]` and
  `usage: { programmes, terms, sessions, events }`.
- Write the address with the suburb after the last comma ("Holbeach Ave, Tempe NSW 2044"): `venueText()` shows
  "Robyn Webster Sports Centre, Tempe".

## Cache tags

Defined in `src/server/cache.ts` (`tags`). Public pages must carry these so the admin's purges reach them:

| Tag                    | Put it on                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `tags.programme(slug)` | A programme's page and every page under it (any kind). League pages also keep `tags.league(slug)`. |
| `tags.category(slug)`  | A category landing page.                                                                           |
| `tags.programmes`      | Every page that lists programmes: category pages, `/enrol`, and pages with a Programme list block. |
| `tags.venues`          | Pages showing venue details (Where We Play).                                                       |
| `tags.site`            | Every page (the menu), as before.                                                                  |

The public pages ([admin.md §3.13](../admin.md#313-public-pages-build-step-3)) carry them: `programmePageTags()` and
`categoryPageTags()` in `src/server/programmes/public.ts` list a programme page's and a category page's tags.
Programme slugs can't be `fixtures` (`RESERVED_PROGRAMME_SLUGS` in `src/lib/programmes.ts`): `/leagues/fixtures` is
the cross-league fixture list.

What purges what:

- **Programme:** nothing while it stays a draft. Otherwise its page tags (old and new slug), its category pages (old
  and new), `tags.programmes`, and `tags.site` when a menu-visible field changed (name, code, slug, category,
  status, `menuVisible`, sort). When `site` isn't purged, the pages with Programme list blocks, or with Ladder/Fixtures
  blocks for that league, are purged by path from `page_data_refs` as a backstop.
- **Session, term or event:** its programme's page tags, its category page, `tags.programmes` and the Programme list
  block pages (next start dates change). Nothing while the programme is a draft.
- **Category:** its page (old and new slug) and `tags.programmes`; plus `tags.site` for name, slug, status or order.
- **Venue or court:** `tags.site`, `tags.venues`, `tags.programmes`.

## Shared helpers for other agents

- `src/lib/programme-text.ts` (pure): `generatedSummaryLine(p, venue)`, `summaryLine(p, venue)` (hand-written wins),
  `scheduleText(p)`, `formatTime`, `formatTimeRange` ("8–10pm"), `venueText`, `venueSuburb`, `nextStartsLine(p,
nextInstanceDate)`, `formatDateLong`, `programmeLineSource(p, venue, nextInstanceDate)` (the `ProgrammeLineSource`
  for Programme list overrides), `WEEKDAYS`, `INSTANCE_NOUN`.
- `src/lib/weekly.ts`: `weeklyDates(from, to, weekday, { everyWeeks, skip, max })`, `weekdayOf(date)`.
- `src/lib/time.ts`: `sydneyToUtc('2026-10-18T09:00')`, `utcToSydneyInput(iso)` for datetime-local inputs.
- `src/server/programmes/programmes.ts`: `nextInstanceQueries(db, today)` + `nextInstanceMap(results)` (fold into a
  public batch) or `nextInstanceDates(db, today)`; `listProgrammes(db, { kind })`; `programmePurge(db, before, after)`.
- `src/server/programmes/common.ts`: `moveTreeStatements(db, { from, to }, childSlugs, actor, at)`, `blockPageTags(db,
programmeIds)`, `programmeTags(p)`.
