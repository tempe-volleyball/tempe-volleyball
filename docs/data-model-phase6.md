# Phase 6 data model

Everything Phase 6 adds to D1, in one additive migration: `migrations/0003_phase6_programmes.sql`. The design is
[docs/admin.md §3](admin.md#3-programmes-categories-and-how-pages-link-to-them); PLAN.md "Data model" has the tables
from earlier phases. The TypeScript schema is under `src/server/db/schema/`, and everything is re-exported from
`src/server/db/schema.ts`.

Conventions are unchanged. Ids are text UUIDs, except the seeded categories. Money is integer cents (AUD). Instants
are UTC ISO strings. Dates are `YYYY-MM-DD` and times `HH:MM`, both Sydney local. Enum-like columns are plain text
typed by the arrays in `enums.ts`, with no SQL CHECK, so adding a value is a code change and needs no migration.

## Decisions

| Question                                    | Choice                                                                                                | Why                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where programmes live                       | **New columns on `leagues`**, exported in TS as `programmes` too (`programmes === leagues`)           | `seasons.league_id`, `menu_items.league_id`, the importer and all live code keep working, and there's one record per programme. A separate `programmes` table would have duplicated name, code, slug, venue and sort, leaving two copies to keep in sync. The SQL rename to `programmes` can come in a later release, once nothing reads the old name. |
| `leagues.code`                              | Free text in TS (it was typed as `LeagueCode`), unique across all kinds                               | Training and events need their own codes (ADP, JDP, SCT). `leagueCodes` stays for the importer. Validate with `PROGRAMME_CODE_PATTERN`.                                                                                                                                                                                                                |
| `leagues.weekday` is NOT NULL               | Kept. Programmes without a regular day store the weekday of their first date                          | SQLite can't relax NOT NULL without rebuilding the table, and a rebuild isn't additive. `schedule_label` covers anything that one weekday can't express.                                                                                                                                                                                               |
| `active` vs `status`                        | `status` (draft, active, retired) is the source of truth. Writers keep `active = (status = 'active')` | Live code still reads `active`. The migration retires leagues that had `active = 0`. Drop `active` in a later release.                                                                                                                                                                                                                                 |
| Where an instance's enrolment settings live | **On its product**: exactly one product per season, session, term or event (unique indexes)           | `registrations` and `groups` already point at `product_id`, so cap checks count rows against one product row. Instance tables hold only the schedule. Every null on the product falls back to the programme (`effectiveCap`, `inherit` in `src/lib/programmes.ts`).                                                                                    |
| Paid / unpaid                               | `registrations.paid_at` (null = unpaid) plus `paid_marked_by`, separate from `status`                 | A spot (status) and a payment are separate facts. Stripe can set `paid_at` later as well. The Phase 5 status `paid` is kept for that flow.                                                                                                                                                                                                             |
| Form versions                               | Field keys are permanent: retire a field, never delete it. `version` is bumped on every save          | Old answers keep their labels without storing a copy of the form on every registration.                                                                                                                                                                                                                                                                |
| Withdrawn teams and tie-breaks              | Columns on `season_teams` for the fact; `seasons.settings` (JSON) for the per-season policy           | Policy changes don't need a migration, and missing keys mean today's behaviour.                                                                                                                                                                                                                                                                        |
| Which pages to purge                        | A `page_data_refs` table, rewritten on every page save                                                | It's indexed and exact, so we never scan page bodies.                                                                                                                                                                                                                                                                                                  |

## Gotchas

- **Filter by kind.** Anything that means "competition leagues" (seasons, ladders, `league_ladder` menu items, the
  `/leagues` pages) must add `where kind = 'league'`. These are already filtered: `baseQueries` (load.ts),
  `listLeagues` and `createSeason` (seasons.ts), and menu choices and `saveMenu` (content/menu.ts). `seasons.ts:77`
  (`leagueOf`) reads by season, so it's safe.
- **drizzle-kit drops `ON DELETE`** when it adds a foreign-key column with `ALTER TABLE ADD`. 0003 was hand-edited to
  restore it, and the header lists the edits; `phase6.test.ts` asserts each one. Any later migration that adds an FK
  column needs the same fix.
- **The `match_days (season_id, date)` unique index checks row by row inside an UPDATE.** To push a season back a week,
  update the days latest first (one statement per day in one `db.batch`, about 12 rows), or the shifted dates collide.
- **Partial unique indexes** (`registrations` per player, `groups` per name) use the raw `status` column in `WHERE`.
  Update the index if `closedRegistrationStatuses` changes.
- **The menu kinds `category` and `programme`** are implemented (src/lib/content/menu.ts; docs/api/menu-and-blocks.md).
- **The importer** (`scripts/import-wp.ts`) assigns imported leagues to their categories, but only where
  `category_id IS NULL`.
- **Every column with a default adds a bound parameter to each Drizzle insert row.** Drizzle binds `.default()`
  values. `chunkByParams` (competition/draw.ts) only counts the fields a row sets, so set defaulted columns
  explicitly in bulk inserts. draw.ts now sets `match_days.status`.
- **Tests:** `createMigratedSqlite({ before: '0003_phase6_programmes.sql' })` plus `applyMigration(sqlite, file)`
  test a migration against old-shape data.

## Programmes (`leagues`)

New columns. Existing ones are unchanged: id, code, name, slug, weekday, default_venue_id, format, sort, active, wp_id
and the timestamps.

| Column                                      | Type                        | Default               | Meaning                                                                                                                                                            |
| ------------------------------------------- | --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`                                      | text                        | `'league'`            | `league` \| `training` \| `development` \| `event` (`programmeKinds`). Fixed in code, since each kind has its own admin section.                                   |
| `category_id`                               | → categories, RESTRICT      | null                  | Its category. The admin requires one. It's nullable only because SQLite can't add a NOT NULL FK. A category can't be deleted while it has programmes.              |
| `status`                                    | text                        | `'active'`            | `draft` (hidden everywhere) \| `active` (listed) \| `retired` (unlisted, page kept). `isPublicStatus` / `isListedStatus`.                                          |
| `retired_at`                                | text (UTC)                  | null                  | Set when retired, cleared when reactivated.                                                                                                                        |
| `start_time`, `end_time`                    | text HH:MM                  | null                  | Usual times.                                                                                                                                                       |
| `schedule_label`                            | text                        | null                  | Hand-written day and times ("Thursdays, 6:30–10pm"). Null = generated from weekday and times.                                                                      |
| `description`                               | JSON ContentBody            | `{blocks:[],html:''}` | The programme page's main text, like a page body.                                                                                                                  |
| `summary_line`                              | text                        | null                  | The one-line description used wherever it's listed. Null = generated.                                                                                              |
| `more_info_url`                             | text                        | null                  | The "More info" link (internal path or https URL).                                                                                                                 |
| `menu_visible`                              | bool                        | true                  | False hides it from automatic menu dropdowns without retiring it.                                                                                                  |
| `age_min`, `age_max`                        | int                         | null                  | Age limits in years, checked against a `birth_year` field.                                                                                                         |
| `seo_title`, `seo_description`              | text                        | null                  | Null = generated.                                                                                                                                                  |
| `image_id`                                  | → media, SET NULL           | null                  | Hero or social image.                                                                                                                                              |
| `enrolment_open`                            | bool                        | false                 | The switch. Open = switch on, status active, and now within [`enrolment_opens_at`, `enrolment_closes_at`) where set. `enrolmentOpen()` in `src/lib/programmes.ts`. |
| `enrolment_opens_at`, `enrolment_closes_at` | text (UTC)                  | null                  | Optional window, so enrolment opens and closes on its own.                                                                                                         |
| `next_starts_text`, `next_starts_on`        | text, date                  | null                  | Manual "Next season starts …" override. Text wins over the date; both null = taken from the next season, session, term or event.                                   |
| `enrolment_form_id`                         | → enrolment_forms, SET NULL | null                  | Default form.                                                                                                                                                      |
| `cap_teams`, `cap_players`                  | int                         | null                  | Default caps for each instance. Null = unlimited.                                                                                                                  |
| `price_cents`                               | int                         | null                  | Default price per player, shown and owed. Null = no fee shown.                                                                                                     |
| `allow_team_entries`, `allow_free_agents`   | bool                        | true, true            | Leagues and events: whether teams can enter, and whether individuals can enter as free agents.                                                                     |
| `waitlist_enabled`                          | bool                        | true                  | When full, new enrolments join a waitlist. Otherwise they're refused.                                                                                              |
| `waitlist_offer_hours`                      | int                         | 48                    | How long a freed spot is held for the person offered it.                                                                                                           |

Indexes: `leagues_category_id_idx`, `leagues_kind_status_idx`, `leagues_image_id_idx`,
`leagues_enrolment_form_id_idx`. Code and slug are still unique across all programmes.

Public URLs come from `programmePath(kind, slug)`: `/leagues/<slug>`, `/training/<slug>`, `/programs/<slug>`,
`/events/<slug>`. A category is at `/<slug>` (`categoryPath`).

## `categories` (new)

| Column                         | Type              | Notes                                                                                             |
| ------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------- |
| `id`                           | text PK           | The seeded ones are `cat_mixed_leagues`, `cat_super_league`, `cat_juniors`, `cat_adult_training`. |
| `name`                         | text              |                                                                                                   |
| `slug`                         | text, unique      | The landing page path without its slash.                                                          |
| `intro`                        | JSON ContentBody  | Editable intro above the programme list.                                                          |
| `sort`                         | int               | Menu and list order.                                                                              |
| `status`                       | text              | Same values as programmes (`categoryStatuses`).                                                   |
| `seo_title`, `seo_description` | text              | Null = generated.                                                                                 |
| `og_image_id`                  | → media, SET NULL |                                                                                                   |
| timestamps, `updated_by`       |                   |                                                                                                   |

Seed (in the migration SQL, `INSERT OR IGNORE`): Mixed Leagues (`mixed-leagues`, sort 1), Super League
(`super-league`, 2), Juniors (`juniors`, 3) and Adult Training (`adult-training`, 4). The migration then sets
`category_id` for leagues coded TNL, FNL, SNL and SAL to Mixed Leagues and TVSL to Super League, where it's still null.
Production has no leagues yet, so there it changes nothing.

## Sessions, terms and events (new; `programmes.ts`)

These hold the schedule only. Enrolment settings are on the instance's product (see below). A null venue, court or
time falls back to the term, then the programme. Each has `status` = `scheduled` \| `postponed` \| `cancelled`
(`occurrenceStatuses`), plus timestamps and `updated_by`.

**`development_terms`**: id, `programme_id` (→ leagues, RESTRICT), `name` ("Term 4 2026"), `slug` (unique per
programme), `start_date`, `end_date`, `weekday`, `start_time`, `end_time`, `venue_id` (→ venues, SET NULL),
`court_id` (→ courts, SET NULL), `age_group` (free text), `status`, `note`, `sort`. People enrol in a whole term.

**`programme_sessions`**: id, `programme_id` (→ leagues, RESTRICT), `term_id` (→ development_terms, CASCADE;
null for training), `date`, `start_time`, `end_time`, `venue_id`, `court_id`, `title`, `status`, `original_date`
(set once moved), `note`. Training sessions take enrolments one session at a time; term sessions don't. Indexes:
(programme_id, date), (term_id, date), (date), venue, court.

**`events`**: id, `programme_id` (→ leagues, RESTRICT), `name` ("Tempe Cup 2026"), `slug` (unique per programme),
`start_date`, `end_date` (null = one day), `start_time`, `end_time`, `venue_id`, `status`, `original_start_date`,
`note`.

A programme with any instances can't be deleted (RESTRICT), only retired, which matches docs/admin.md §3.3.

## Enrolment

### `enrolment_forms` (new; `forms.ts`)

id, `name`, `description`, `fields` (JSON `FormField[]`, default `[]`), `version` (int, bumped on save),
`confirmation_text`, `archived_at`, timestamps, `updated_by`. The field types and limits are in
`src/lib/enrolment/forms.ts`. Every form also asks for first name, last name, email and phone (the `players` columns)
and runs Turnstile. Fields of type `guardian`, `emergency_contact`, `birth_year`, `team_name` and `vnsw_membership` map
to fixed columns (`mappedFieldTypes`). Keys are permanent: retire a field with `retired: true`, never delete it.

The form used is the product's `form_id`, else the programme's `enrolment_form_id`, else no extra questions.

### `products` (new columns)

| Column                                                                                | Notes                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `programme_id` → leagues, RESTRICT                                                    | Always set for Phase 6 products.                                                                                                                                                                                        |
| `season_id` (existing), `session_id`, `term_id`, `event_id`                           | **Exactly one is set, and each is unique**, so there's one product per target. Session, term and event use CASCADE, so deleting one also deletes its product unless registrations reference it (then the delete fails). |
| `capacity` (existing)                                                                 | Player cap: rows holding a spot (`spotHoldingStatuses`). Null = the programme's `cap_players`.                                                                                                                          |
| `capacity_teams`                                                                      | Team cap: `groups` holding a spot. Null = the programme's `cap_teams`.                                                                                                                                                  |
| `form_id` → enrolment_forms, SET NULL                                                 | Form override.                                                                                                                                                                                                          |
| `waitlist_enabled`, `waitlist_offer_hours`, `allow_team_entries`, `allow_free_agents` | Nullable overrides of the programme's settings.                                                                                                                                                                         |
| `opens_at`, `closes_at`, `active` (existing)                                          | A product can only narrow the programme's window (`enrolmentOpen()`).                                                                                                                                                   |
| `price_cents` (existing, NOT NULL)                                                    | Copy the programme's `price_cents` (or 0) when creating the product.                                                                                                                                                    |

`kind` gains `development_term` and `event_entry` (TS only). Use `season_entry`, `training_session`,
`development_term` and `event_entry` for Phase 6 products.

### `registrations` (new columns): one player's enrolment

| Column                                                         | Notes                                                                                                                                                          |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                                       | Gains `confirmed` (has a spot) and `offered` (a freed spot offered until `offer_expires_at`). The manual flow uses confirmed, waitlist, offered and cancelled. |
| `free_agent`                                                   | bool. A league or event entry without a team; set `group_id` when Michael places them.                                                                         |
| `waitlist_position`                                            | 1-based order while on the waitlist. Gaps are fine; order by position, then created_at.                                                                        |
| `offered_at`, `offer_expires_at`                               | The offer. Index (status, offer_expires_at) is for the cron that passes lapsed offers on.                                                                      |
| `amount_cents`                                                 | What they owe, copied at enrolment. Null = no fee.                                                                                                             |
| `paid_at`, `paid_marked_by` (→ user, SET NULL), `payment_note` | Paid or unpaid, marked by hand. Audit `enrolment.mark_paid` / `enrolment.mark_unpaid`.                                                                         |
| `form_id` (→ enrolment_forms, SET NULL), `form_version`        | The form version that was answered.                                                                                                                            |
| `source`                                                       | `public` \| `admin` \| `import`.                                                                                                                               |
| `cancelled_at`, `cancel_reason`                                |                                                                                                                                                                |

Uniqueness: `registrations_product_id_player_id_live_unique` on (product_id, player_id) WHERE status NOT IN
('cancelled', 'expired', 'refunded'). So one live entry per player per product, a double submit can't take two
spots, and someone can re-enrol after cancelling. Players are matched by lower-cased email before inserting.

### `groups` (new columns): a team entry

`status` (`confirmed` \| `waitlist` \| `offered` \| `cancelled`, default confirmed), `waitlist_position`,
`offered_at`, `offer_expires_at`, `team_id` (→ teams, SET NULL: the competition team it is or became), `answers`
(JSON team-level answers), `cancelled_at`, `notes`. The team name is unique per product among entries that aren't
cancelled (`groups_product_id_name_live_unique`). Trim it and compare case-insensitively in the app first.

### Capacity checks

To check a cap without a race, insert conditionally inside one `db.batch`:
`INSERT … SELECT … WHERE (SELECT count(*) FROM registrations WHERE product_id = ? AND status IN (spotHoldingStatuses)) < ?`.
If nothing was inserted, insert as `waitlist` with `waitlist_position = coalesce(max(waitlist_position), 0) + 1`
(when the waitlist is enabled). Indexes: `registrations_product_id_status_idx`, `groups_product_id_status_idx` and
the `(product_id, waitlist_position)` indexes on both tables.

As built (docs/api/enrolment.md), the batch inserts the entry as `confirmed` and then a conditional UPDATE in the
same batch moves it to the waitlist when the count is over the cap or others are waiting (or a conditional DELETE
refuses it with the waitlist off). Same guarantee, and one code path for players and team entries.

### `rate_limits` (new, migration `0004_enrolment_rate_limits`; `admin.ts`)

Fixed-window counters for public endpoints without a session (the enrolment form). `key` (PK, `"<scope>:<salted
sha-256 prefix>"`, never the IP or email itself), `count`, `window_start`, `expires_at` (UTC; indexed, the hourly cron
deletes ended windows). `hit()` in `src/server/ratelimit.ts` upserts each key atomically.

## Fixtures parity (columns on existing tables)

| Table                     | Column                                         | Notes                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matches`                 | `status`                                       | Gains `postponed` and `tbd` (TS only).                                                                                                                                                                                      |
| `matches`                 | `status_note`                                  | Public reason ("Venue unavailable").                                                                                                                                                                                        |
| `matches`                 | `original_match_day_id` → match_days, SET NULL | A postponed game replayed on another night points back at the night it was first scheduled for. Relations: `originalMatchDay`, `postponedMatches`.                                                                          |
| `matches`                 | `referee`                                      | Referee name(s), e.g. the VNSW referee for TVSL.                                                                                                                                                                            |
| `match_days`              | `status`                                       | `scheduled` \| `postponed` \| `cancelled` for the whole night (`matchDayStatuses`). The reason goes in `note`.                                                                                                              |
| `match_days`              | `original_date`                                | Set when the night is moved. "Push the season back a week": set `original_date` on each later day, shift it 7 days (latest first), and optionally insert a `skip` day on the postponed date.                                |
| `match_results`           | `outcome`                                      | Manual override: `home` \| `away` \| `draw` (forfeit or walkover). Null = from the sets.                                                                                                                                    |
| `match_results`           | `note`                                         | Why it was overridden.                                                                                                                                                                                                      |
| `season_teams`            | `withdrawn_at`, `withdrawn_reason`             | When a team withdrew, and why.                                                                                                                                                                                              |
| `seasons.settings` (JSON) | `tieBreaks?: TieBreakRule[]`                   | Order after ladder points (`tieBreakRules`: setDiff, setRatio, setsFor, pointDiff, pointRatio, pointsFor, wins, headToHead, name). Missing = `DEFAULT_TIE_BREAKS` = setDiff, pointDiff, wins, name (today's `standings()`). |
| `seasons.settings` (JSON) | `withdrawn?: WithdrawnPolicy`                  | `{ ladder: 'mark' \| 'hide', results: 'keep' \| 'void' }`. Missing = mark and keep.                                                                                                                                         |

## Menu (`menu_items` new columns)

| Column                              | Notes                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `kind`                              | Gains `category` (uses `category_id`) and `programme` (uses `league_id`, any kind).                                    |
| `category_id` → categories, CASCADE | A `category` item expands into the landing page plus one link per active programme with `menu_visible`.                |
| `placement`                         | `before` \| `after` (null = after): where a hand-made child of a `category` item sits relative to the automatic links. |
| `hidden`                            | bool, default false. Kept in the admin but not shown.                                                                  |

## Page blocks (no table; `src/lib/content/blocks.ts`)

Blocks are TipTap atom nodes in `pages.body.blocks`: `programmeList`, `ladder` and `fixtures`, with attrs
`ProgrammeListAttrs`, `LadderAttrs` and `FixturesAttrs` and defaults `DEFAULT_*_ATTRS`. A programme list has a filter
(categoryIds, kinds, enrolmentOpenOnly), a template (`DEFAULT_PROGRAMME_LINE_TEMPLATE`, with
`PROGRAMME_TEMPLATE_PLACEHOLDERS`), order, hidden ids and overrides. An override is `{ text, source, editedAt }`;
`source` is a `ProgrammeLineSource` snapshot, and `changedSourceFields(then, now)` finds what changed since the edit.
The text used is the override, then the programme's `summary_line`, then the template.

### `page_data_refs` (new)

`page_id` (→ pages, CASCADE), `kind` (`programme_list` \| `ladder` \| `fixtures`), `ref_id` (the league id for ladder
and fixtures, `''` for programme lists), created_at. PK (page_id, kind, ref_id); index (kind, ref_id). Rewrite a
page's rows in the same batch as the page save (delete, then insert). To purge after a change, read the page paths
for `kind = 'programme_list'` (any programme or category change) or `kind IN ('ladder', 'fixtures') AND ref_id = <league>`.

## Analytics (new; `analytics.ts`)

**`analytics_daily`**: `source` (`ga4` \| `search_console` \| `cloudflare`), `date`, `metric`, `dimension` (`''` for
totals), `dimension_value` (`''`), `value` (real), timestamps. PK (source, date, metric, dimension, dimension_value),
so re-fetching a day upserts. Indexes (source, metric, dimension, date) and (date). Store totals plus the top 50 per
dimension per day so writes stay far below the 100k rows/day limit. `date` is the source's own reporting day.

**`analytics_fetches`**: id, source, status (`running` \| `ok` \| `error` \| `skipped`), started_at, finished_at,
range_start, range_end, rows_written, error, timestamps. One row per source per cron run; prune after about 90 days.

**`analytics_state`**: `source` PK, `enabled`, `last_complete_date`, `last_success_at`, `last_error_at`, `last_error`,
`cursor` (JSON), timestamps. Each run re-fetches the last ~3 days, because sources revise recent data.
`cursor.lockUntil` (UTC ISO) is the fetch lock; `enabled = false` is a manual kill switch (the admin's switch is
Settings → Analytics).

Metrics stored (src/lib/analytics/): **ga4** totals `activeUsers`, `newUsers`, `sessions`, `screenPageViews`,
`engagedSessions`; breakdowns `pagePath`, `sessionDefaultChannelGroup`, `sessionSource`, `deviceCategory`, `country`.
**search_console** `clicks`, `impressions`, `positionSum` (position × impressions) for totals and `query`, `page`,
`device`, `country`. **cloudflare** `visits`, `pageviews` for totals and `requestPath`, `refererHost`, `countryName`,
`deviceType`; vitals totals `lcpP75`, `inpP75`, `clsP75`, `fcpP75`, `ttfbP75` (ms; CLS unitless) and `vitalsSamples`.
Page paths are normalised (no query, no trailing slash).

## Audit actions added (TS only)

programme.create, update, status, enrolment and delete · category.create, update, status and delete · venue.\* and
court.\* (create, update, delete) · session.\*, term.\* and event.\* (create, update, status, delete) ·
form.create, update and delete · product.update · enrolment.create, update, status, mark_paid, mark_unpaid, offer,
place and delete · match_day.postpone, cancel and restore · season.push_back · team.withdraw, reinstate and merge ·
fixtures.import · page.blocks · analytics.fetch.
