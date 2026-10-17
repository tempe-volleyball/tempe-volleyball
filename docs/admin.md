# Admin plan (Phase 6)

What the organiser needs from `/admin`, and how far the rebuild has got. PLAN.md links here for Phase 6; keep the detail
here so PLAN.md stays short.

**The rule: no regressions.** Anything Michael relies on in SportsPress today must exist in the new admin before the
cutover (PLAN.md Phase 8). The research behind this is in
[docs/reference/sportspress-admin-rundown.md](reference/sportspress-admin-rundown.md): what SportsPress offers, what Tempe
actually uses, and what's tracking visitors on the old site.

Status as of 2026-10-18: **Done** = built and on staging, **Partial** = some of it exists, **Missing** = not started.

---

## 1. Must have before cutover (parity with SportsPress)

| Feature                           | What we need                                                                                                                           | Status      | What's there / what's left                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Leagues**                       | Leagues as records (TNL, FNL …) that own their seasons, with add, rename, retire and reactivate                                        | **Done**    | Admin → Leagues lists each league with its seasons; a league opens to Details, Enrolment and Seasons tabs: add, rename, change URL (leaves 301s for the league and its season pages), category, retire, reactivate, delete while it has no history. Training, Development and Events have their own sections (sessions, terms, dates). API: [api/programmes.md](api/programmes.md). |
| **Seasons**                       | A league has quarterly seasons, each with its own settings                                                                             | **Done**    | Admin → Seasons: create, set up, publish, archive. Points per W/D/L and sets per match are per season.                                                                                                                                                                                                                                                                              |
| **Teams and rollover**            | Teams carry over between seasons; one-click "roll over to next season"                                                                 | **Done**    | "New season" copies the latest season's teams and settings. Teams can be renamed and created. Still missing: a team list screen (merge duplicates, see a team's history).                                                                                                                                                                                                           |
| **Venues and courts**             | Venues (Robyn Webster, MLC, Five Dock) separate from the courts inside them                                                            | **Done**    | Admin → Venues: name, URL, address, map link, directions; courts per venue with ordering and renames; delete only when unused. The public Where We Play page still needs to read them (public pages agent).                                                                                                                                                                         |
| **Matches**                       | Date, time, teams, court, match day, status, plus duty team, bye and finals placeholders as real fields                                | **Partial** | Duty, byes and placeholders are fields. Status has scheduled, played, forfeit and cancelled; **postponed** and **TBD** are in the schema (plus a status note, the original match day and a referee) but not in the admin yet.                                                                                                                                                       |
| **Creating fixtures**             | The draw generator, with CSV import as a fallback                                                                                      | **Partial** | Generator done (runs in the browser). CSV import missing.                                                                                                                                                                                                                                                                                                                           |
| **Match list**                    | Filters for team, venue, league, season and match day; results for a whole match day on one screen                                     | **Partial** | A season's Results tab shows a whole match day on one screen. Missing: one list across all leagues filtered by team, venue or date ("everything on this Thursday").                                                                                                                                                                                                                 |
| **Results**                       | Per-set points, sets and outcome worked out automatically, a manual override for forfeits and walkovers, draft → publish per match day | **Partial** | Per-set entry, draft → publish and undo are done. Forfeit is only a label on an ordinary score. The manual outcome override is in the schema (`match_results.outcome`, `note`) but not in the admin; the forfeit score rule waits on Michael (PLAN.md open question 7).                                                                                                             |
| **Scoring rules**                 | Fixed ladder columns, with W/D/L points, sets per match and tie-break order per season                                                 | **Partial** | Points and sets per match are per season. Tie-break order is a season setting in the schema (`settings.tieBreaks`, defaulting to today's order), but the ladder and admin don't use it yet. The 1–1 rule (draw, or decided on points as SportsPress did) is still open.                                                                                                             |
| **Ladders**                       | Automatic, with point adjustments plus a reason, hiding a withdrawn team, and automatic "Week X of Y" and "Updated" lines              | **Partial** | Automatic, adjustments with reasons, and the generated headings are done. Withdrawn teams are in the schema (`season_teams.withdrawn_at`/`reason`, `settings.withdrawn` to mark or hide them and keep or void their results); the ladder and admin don't use them yet.                                                                                                              |
| **Fixture lists**                 | Filtered lists ("this week", "upcoming") and an iCal feed per team                                                                     | **Missing** | The league page shows the whole season. No "this week" view, no team pages, no iCal feeds.                                                                                                                                                                                                                                                                                          |
| **Fixtures and ladders on pages** | "Ladder" and "Fixtures" blocks in the page editor that follow the current season (SportsPress used shortcodes)                         | **Missing** | Block types are defined (`src/lib/content/blocks.ts`) and `page_data_refs` is in the schema for cache purges. The editor and rendering are missing. Designed in section 3.4.                                                                                                                                                                                                        |
| **Bulk postpone or cancel**       | Postpone or cancel a whole night, with a choice to push the season back a week                                                         | **Missing** | Matches can be cancelled one at a time. The schema is ready (`match_days.status`, `original_date`; `matches.original_match_day_id`); the whole-night action and "push the rest of the season back a week" are missing.                                                                                                                                                              |
| **Import and export**             | A one-time WordPress import, plus CSV export                                                                                           | **Done**    | `npm run import:wp` (staging so far; production in Phase 8) and a CSV download per season.                                                                                                                                                                                                                                                                                          |
| **Roles**                         | Owner / admin / editor; a results-only helper role could come later                                                                    | **Done**    | With invites, the audit log and TOTP for owners. Editors see only results in Seasons.                                                                                                                                                                                                                                                                                               |
| **Analytics**                     | Replace the Site Kit and Jetpack dashboards                                                                                            | **Partial** | Built: the GA4 tag (`GT-PLFFMCMT`, lazy-loaded) and the Cloudflare beacon on production www only, Settings → Analytics, the daily fetch from GA4, Search Console and Cloudflare into D1, Admin → Stats, and view counts in Admin → Pages. Left: the credentials (section 2.3); until then each source shows "not connected yet".                                                    |

## 2. Analytics and the Stats page

The old site has Google Analytics 4 and Search Console through Site Kit, and Jetpack Stats. The rebuild:

| Piece                        | Plan                                                                                                                | Status                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Google Analytics 4**       | Keep the same tag (`GT-PLFFMCMT`) so the visitor history carries on unbroken                                        | **Done** (tag); Stats waits for the property ID and service account                    |
| **Google Search Console**    | Keep the property and verify it by DNS TXT so it survives the move; an optional verification meta tag as a fallback | **Done** (fetch and meta); waits for access. DNS verification at the cutover (Phase 8) |
| **Cloudflare Web Analytics** | Add it: cookieless, page views, visits, referrers, countries, devices, Core Web Vitals, 6 months of history         | **Done** (beacon and fetch); waits for the site token, site tag and API token          |
| **Jetpack Stats**            | Drop it                                                                                                             | Its history can't be moved, and it may soon need a paid plan.                          |
| **Admin Stats page**         | Visitors, page views, top pages, sources, devices, countries, Google searches, Core Web Vitals; reads only D1       | **Done** (Admin → Stats)                                                               |
| **Business numbers**         | Sign-ups, payments, revenue, waitlists, who still owes money                                                        | **Partial**: registrations and team entries by programme and status (admins only)      |
| **Optional**                 | View counts beside each page in Admin → Pages (like Jetpack's Stats column), a weekly summary email                 | View counts **Done** (last 30 days); weekly email **Missing**                          |

**Still a decision for Michael:** GA4 sets cookies, and PLAN.md said "no cookies, no banner". Australia doesn't require a
cookie banner for analytics, but the privacy policy needs a line about GA4 (Phase 7). Cloudflare Web Analytics is
cookieless. Turning GA4 off is one setting (clear the measurement ID).

### 2.1 How it works

- **Settings → Analytics** (admins and owners; the `analytics` key in `site_settings`, `src/lib/content/settings.ts`):
  the GA4 measurement ID (default `GT-PLFFMCMT`) and how the tag loads, the GA4 property ID, the Cloudflare beacon
  token, account ID and site tag, the Search Console property and an optional verification code, a switch per source
  for the daily fetch, how far the first fetch goes back (default 90 days) and how long to keep history (default 3
  years). Saving purges every cached page, so tag changes go live at once. API keys are **Worker secrets**, never
  settings: `GOOGLE_SERVICE_ACCOUNT_JSON` (the key file as is) and `CF_ANALYTICS_TOKEN`.
- **Tags on the public site** (`src/lib/analytics/tags.ts`, used by `BaseLayout.astro`) appear only when `isIndexable()`
  (production on `www.tempevb.com`), so staging, previews and `*.workers.dev` never send hits or skew the numbers.
- **Daily fetch** (`src/server/analytics/fetch.ts`, run by the hourly cron in `src/server/cron.ts`): each invocation
  fetches at most **one** source, so every source gets its own invocation and its own 10 ms CPU budget (network waits
  don't count). A source is due while its last complete day is before its own yesterday, so it runs once a day. The
  first run back-fills in 10-day steps an hour apart, and each run re-fetches the last 2–4 days because sources revise
  them. A failure is logged and retried after 3 hours; "Fetch now" on the Stats page (admins) retries at once. A lock
  in `analytics_state.cursor` stops the cron and "Fetch now" running the same source at the same time.
- **Storage:** `analytics_daily` holds daily totals plus the top 50 values per breakdown per day. A run replaces its date
  range (so a page that dropped out of the top 50 doesn't linger) with one `INSERT … SELECT FROM json_each(?)` per
  1,500 rows, so a run is about 10 D1 statements whatever its size. A busy day is a few hundred rows. Search Console
  stores `clicks`, `impressions` and `positionSum` (position × impressions), which are all additive, so CTR and average
  position over any range are exact.
- **Stats page** (`src/admin/screens/Stats.tsx`, lazy-loaded; API in [docs/api/stats.md](api/stats.md)): presets (7, 28
  and 90 days, 1 year) or any range up to 400 days, from one D1 batch of ~20 indexed queries.

### 2.2 Decisions (each the more robust or more configurable option)

- **Tag loading is a setting**, defaulting to "on first interaction". `interaction` loads gtag.js on the first scroll,
  tap or key, when the tab is hidden, or after 15 s; `idle` loads it after the load event once the browser is idle;
  `eager` loads it at once. The trade-off: gtag.js is ~150 KB and costs Lighthouse performance and Total Blocking Time
  when it loads with the page. Deferring it keeps the Lighthouse score (Lighthouse doesn't scroll), at the cost of
  missing a visitor who leaves within 15 s without touching the page. The page view is queued at once, so it keeps its
  real time and page when gtag.js arrives. Switch to `eager` if GA4's numbers matter more than speed.
- **Consent mode defaults:** ads storage and personalisation are always denied (there are no ads); analytics storage is
  granted unless the browser sends Global Privacy Control, in which case GA4 gets cookieless pings.
- **The Cloudflare beacon loads with `defer`** (~6 KB, cookieless), so Core Web Vitals are measured from the start. Use
  the manual snippet's token and leave Cloudflare's "automatic setup" off, or visits count twice.
- **One source per cron invocation**, not all three, to stay inside 10 ms of CPU. Responses are capped at 50 rows per
  day of the range per breakdown (biggest first), because parsing is the CPU cost: ~2,000 rows map in ~3 ms, while
  18,000 took ~15 ms in a test. Production CPU shows in Workers Logs (observability is on).
- **Each source keeps its own day:** GA4 uses the property's zone (Sydney), Search Console US Pacific and Cloudflare UTC.
  The Stats page says so rather than shifting numbers between days.
- **GA4 visitors are daily users added up**, because daily rows can't give unique users over a range. The tile says so.
- **Core Web Vitals over a range** are the daily p75s weighted by each day's sample count. Cloudflare reports timings in
  microseconds, so values over 60,000 are converted to ms. Vitals come from a second GraphQL request, so a problem
  there is a warning and never loses the traffic numbers.
- **Page view counts in Admin → Pages** use GA4 when it has data, else Cloudflare, over the last 30 days. Only each
  day's top 50 pages are stored, so a quiet page can show "–".

### 2.3 Setup (nothing here exists yet)

**Google (GA4 and Search Console):**

1. In Google Cloud (any project; free), enable the **Google Analytics Data API** and the **Google Search Console API**.
2. IAM → Service accounts → create one (e.g. `tempevb-stats`) with no roles. Keys → Add key → JSON, and download it.
3. GA4 → Admin → Property access management → add the service account's email as **Viewer**. Note the **Property ID**
   (Admin → Property details: a number, not the `GT-` tag).
4. Search Console → the tempevb.com property → Settings → Users and permissions → add the service account's email with
   **Restricted** permission. Note the property's name exactly: `sc-domain:tempevb.com` for a domain property, or
   `https://www.tempevb.com/` for a URL-prefix one.
5. `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env production` and paste the whole key file. Don't commit it
   or send it in chat.

**Cloudflare Web Analytics:**

1. Cloudflare → Analytics & Logs → Web Analytics → Add a site → `www.tempevb.com`, with **manual** setup (the JS
   snippet). Copy the snippet's `token` (32 characters) and the site's **site tag**. Do this at the cutover (Phase 8);
   the beacon only reports from the real domain.
2. My Profile → API Tokens → Create Token → Custom: **Account → Account Analytics → Read**, scoped to the one account.
   Then `npx wrangler secret put CF_ANALYTICS_TOKEN --env production`.

**Then** in Admin → Settings → Analytics, enter the GA4 property ID, the Search Console property, the Cloudflare account
ID, the site tag and the beacon token. The Stats page shows each source as connected, and the cron fetches it within
the hour (or press "Fetch now"). Staging can be given the same secrets to test the fetch; it never emits tags.

## 3. Programmes, categories and how pages link to them

Agreed with Jeremy on 2026-10-18. **The principle: the admin gives complete control of the website, and every system is
as automated and robust as possible.** Anything generated from data can still be edited by hand. When in doubt, take the
more robust, more configurable option.

Why: the old site's pages are hand-typed and drift out of date (the main enrolment page is `/2023-enrolment` in 2026, and
it still lists a Monday league). A new league should appear everywhere it belongs without anyone editing pages.

### 3.1 Programmes

- **One record type underneath: a programme.** The existing `leagues` table grows into it with additive columns, so
  imported leagues and seasons are kept.
- **Four kinds**, fixed in code because each has its own admin screens:

  | Kind            | Examples                                          | What it adds                                                |
  | --------------- | ------------------------------------------------- | ----------------------------------------------------------- |
  | **league**      | TNL, FNL, SNL, SAL, TVSL                          | Seasons, draws, results, ladders (Admin → Seasons as built) |
  | **training**    | Scrim & Coached Training, Thursday casual         | Sessions with dates, times, venue and a cap                 |
  | **development** | ADP, JDP (VolleyJoeys)                            | Terms with sessions, age groups                             |
  | **event**       | Tempe Cup, rep team trials, socials, come-and-try | One date or a short range, its own entry form, no seasons   |

- **Separate admin sections** for Leagues, Training, Development and Events. Each shows only what that kind needs. They
  share the programme basics: name, code, URL, category, venue, day and times, description, summary line, status and
  enrolment settings.
- **Summary line:** a one-line description generated from the programme's details by default, such as "Thursday Night
  League (TNL) @ Robyn Webster Sports Centre, Tempe, Thursdays 8–10pm". Michael can edit it on the programme, and it then
  shows everywhere that programme is listed. Each programme also has a short description and a "more info" link.

### 3.2 Categories

- **Managed in the admin:** name, URL, menu order and an editable intro. Every programme belongs to exactly one category,
  of any kind.
- **Each category has a landing page** (such as `/mixed-leagues`) listing its programmes with day, venue, times and next
  start date.
- **Seed:**

  | Category       | Programmes                                                                       |
  | -------------- | -------------------------------------------------------------------------------- |
  | Mixed Leagues  | TNL, FNL, SNL, SAL                                                               |
  | Super League   | TVSL                                                                             |
  | Juniors        | JDP (VolleyJoeys); the Saturday Junior League if it still runs (Michael adds it) |
  | Adult Training | Scrim & Coached Training, ADP                                                    |

### 3.3 Lifecycle

| Status      | Public site                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Draft**   | Hidden everywhere while it's set up                                                                                                                |
| **Active**  | In menus, category pages and lists                                                                                                                 |
| **Retired** | Removed from menus, lists and blocks. Its page stays up ("This league has finished") with past seasons archived, so old links and history survive. |

- **Enrolment** is a separate switch: open or closed, with optional open and close dates so it changes on its own. When
  open, the programme appears on `/enrol` and in "enrolment open" lists, with a "Next season starts …" line taken from its
  next season or session (or typed by hand).
- **Delete** is only allowed while a programme has no seasons, sessions, results or enrolments; after that it can only be
  retired. Reactivating restores everything, menu position included.
- Every status change is audited and purges the affected cached pages.

### 3.4 Blocks in the page editor

- **Programme list block:** choose what it shows (a category, kinds, "enrolment open only"). One line per programme, so a
  new programme adds its line automatically. The block has an editable line template (`Next {name} ({code}) @ {venue}
({times})`), and each line can be reordered, hidden or overridden with hand-written text for that page.
- **Which text wins:** page override → the programme's own summary line → generated text.
- **Changed data:** an overridden line keeps Michael's text, and the editor flags it when the programme's details change
  ("TNL's venue changed since you edited this line"), with one click back to the automatic text.
- **Retired programmes** drop out of every list, overrides included.
- **Ladder and Fixtures blocks:** pick a league; the block always shows its current season. They're data, so no per-line
  overrides, but they have display options (compact or full, number of rows, title override). This replaces SportsPress's
  shortcodes.
- Everything around a block is ordinary editable text. Blocks render on the server from the same data as the programme
  pages, and publishing a season, results or a programme change purges every page that uses them.

### 3.5 Menu

- **A "category" menu item expands into a dropdown on its own:** the category's landing page, then one link per active
  programme in it. A new programme joins automatically; a retired one leaves.
- **Michael can still** reorder and rename dropdowns, hide a programme from the menu without retiring it, and pin
  hand-made links before or after the automatic ones.
- **One link per league**, not separate Ladder and Fixtures links. League pages get Fixtures, Ladder and Results tabs,
  and old `#ladder` / `#fixtures` links still open the right tab.
- **Proposed top level:** Home · Mixed Leagues · Super League · Juniors · Adult Training · Enrol · About (Where We Play,
  Contact, Rules, FAQ). Instagram moves to header icons; "Login" leaves the public menu (`/admin` still works).

### 3.6 URLs

- **Category pages:** `/mixed-leagues`, `/super-league`, `/juniors`, `/adult-training`.
- **Programme pages are flat**, so re-categorising never changes a URL: `/leagues/tnl`, `/training/<slug>`,
  `/programs/<slug>`, `/events/<slug>`. The breadcrumb shows the category. Seasons stay at `/leagues/tnl/tnl-q4-2026`.
- **One enrolment page, `/enrol`.** `/2023-enrolment` and the other year-stamped and duplicate enrolment pages 301 to it.
- Michael can change any URL; the old one leaves a 301 automatically, as pages already do.

### 3.7 Enrolment (moved out of parked Phase 5)

The site takes enrolments itself, replacing the Google Forms. **Payment processing stays parked.**

- **Forms per programme**, with fields Michael can edit (skill level, preferred division, guardian details for juniors
  …), protected by Turnstile.
- **Caps** where they belong, each defaulting from the programme and changeable per instance: per training session (for
  example 32 or 40), per development term, per event, and per league season by **teams, players or both**. Leagues can
  take team entries and individual "free agents", whom Michael places into teams.
- **Full → waitlist.** When someone cancels, the first on the waitlist is offered the spot by email.
- **Paid / unpaid marked by hand** for now (PayID as today). When Stripe comes back it just marks enrolments paid.
- **Admin:** lists per programme, session, season or event, CSV export, and confirmation emails through the outbox
  (once Resend is set up). Uses the existing `players`, `groups` and `registrations` tables; `products` maps onto
  sessions, terms, seasons and events.

**Status: Done (server, admin and the form component); the public pages that show the form are the Public step.**
Built: the form builder (Admin → Enrolments → Enrolment forms) with every field type, required, help text, reordering,
per-entry-type and conditional questions, defaults per kind and a live preview; `POST /api/enrol` with Turnstile,
validation against the form, exact caps by players and/or teams, waitlist, duplicate detection, D1 rate limits and
`TVB-XXXX` references; emailed waitlist offers with expiring accept/decline links and the hourly cron that passes
lapsed offers on; four email templates; Admin → Enrolments (per season, session, term or event, with counts against
the caps, search and filters, mark paid/unpaid with method and note, cancel, reinstate, move, promote and offer from
the waitlist, free agents into teams, add by hand, CSV export); and the `<EnrolmentForm>` island for `/enrol` and
programme pages. API: [docs/api/enrolment.md](api/enrolment.md). Left: real Turnstile keys for production (without
them the form says enrolment is unavailable), the `/enrol` and programme pages, and Resend for the emails.

Decisions (each the more robust or more configurable option):

- **Caps are checked inside the insert's batch**, not before it, so the last spot can't be taken twice. Over the cap,
  an entry joins the end of the waitlist, also when others are already waiting, so nobody jumps the queue. With the
  waitlist off it's refused. The admin can still confirm someone past the cap, on purpose.
- **Offers go out automatically** whenever a spot frees up (cancel, delete, move, a raised cap, a decline, a lapsed
  offer), held for the programme's offer hours (48 by default, per instance). The cron keeps going down the list. The
  admin can also offer, confirm or resend by hand. One request offers at most 5, and the cron at most 3 an hour, to
  stay inside the free plan's query limit.
- **Offer links are signed, not stored**, and die the moment the offer is answered or lapses.
- **Duplicates** are the same email and the same first and last name in the same target, so siblings can share a
  parent's email. A public form fills only blank player details and never overwrites what's there.
- **Rate limits** live in D1 (`rate_limits`, fixed windows): 20 an hour per IP, 6 an hour and 15 a day per email.
- **Editors get no access** to enrolments or forms: it's personal data, juniors' included, and nothing an editor does
  (results, pages, news) needs it. Admins and owners see everything. Revisit if Michael wants a check-in helper.
- **Payment method and note** are kept with "paid" (PayID, cash, bank transfer, card, other), and both directions are
  audited. Stripe, when it returns, just sets `paid_at`.
- **Form changes are versioned**: each registration records the form and version it answered, and questions are
  retired rather than deleted, so old answers keep their labels in the admin and the CSV.

**Privacy and retention.** Stored per player: name, email, phone, and only what the form asks: year of birth (not a
full birth date), guardian name, emergency contact, and the answers. On a junior form the contact email and phone
are the guardian's, so they're asked once. Personal data is shown to admins and owners only, is never in a URL, and is
never cached at the edge: the API answers `no-store`, the public form pages carry only the form definition, and the
offer page renders nothing personal on the server. None of it goes to analytics (GA4 and the Cloudflare beacon see
page URLs only, and no URL holds an answer or a token). The audit log records which personal fields changed, not their
values. Rate-limit keys are salted hashes, deleted when their window ends; offer links are scrubbed from the outbox.
Retention: entries stay while Michael needs them for the season. "Delete for good" removes an entry, and the player
row with it when nothing else uses it. A yearly clean-up of finished seasons (for example after 2 years) is a
follow-up for Michael to decide.

### 3.8 Content map

The 37 imported pages get a new home each. I draft the text, Michael reviews it on staging, and the map is a table in
`docs/content-map.md` (one row per old URL, its new home and status) to tick off:

- **Programme descriptions:** TVSL info, ADP, JDP, VolleyJoeys, Scrim & Coached Training, Thursday casual training.
- **Merged into `/enrol`:** `/2023-enrolment`, `/2021-interest-in-playing`, New Player, Returning Player, New Team,
  Returning Team (and their 2023/2026 duplicates).
- **Archived and redirected:** 2021 Monday and Thursday leagues, COVID guidelines, Sample Page, the 2022 junior
  tournaments, the Tempe Cup thank-you page, other duplicates.
- **Kept and tidied:** About, Where We Play, Contact, Rules, FAQ, with dated or outdated details flagged for Michael.
- **For Michael to decide:** Tempe Cup registration (likely an event) and the USyd Junior Rep programme.
- Nothing is lost: archived pages keep their revisions, and every old URL 301s somewhere sensible.

### 3.9 Data model

Shipped as one additive migration (`0003_phase6_programmes`), with every table and column in
[docs/data-model-phase6.md](data-model-phase6.md). The choices made, each taking the more robust and more configurable
option:

- Programmes are **new columns on `leagues`** (exported as `programmes`), so live code, seasons and imported data keep
  working. The SQL rename waits for a later release.
- **One product per enrolment target** (a season, training session, development term or event). It holds that
  instance's caps, form, window and waitlist overrides; anything left null falls back to the programme.
- Paid or unpaid is `registrations.paid_at`, kept apart from the spot status (`confirmed`, `waitlist`, `offered`).
- Form field keys are permanent (retire a field, never delete it), so old answers keep their labels.
- Season-level policies (tie-break order, how withdrawn teams show) go in `seasons.settings`, so changing them needs no
  migration.
- `page_data_refs` records which pages use which data, so a change purges exactly those pages.

Programmes admin (build step 1), decisions taken the robust and configurable way:

- **Admin sections:** Leagues (the season list, plus a league page with Details, Enrolment and Seasons tabs),
  Training (Sessions tab), Development (Terms tab, each term with its sessions) and Events (Dates tab), plus
  Categories and Venues. `/admin/seasons` redirects to `/admin/leagues`; season pages stay at `/admin/seasons/<id>`.
- **Editors** can open every programme screen read-only; all structure changes need admin.
- **New programmes pick their category:** the one most programmes of that kind already use, else a per-kind hint
  (leagues → Mixed Leagues, training → Adult Training, development → Juniors; `categoryHint` in
  `src/admin/programmes/kinds.ts`), else the first category. It's only a default; the category is always required.
- **Generated text stays editable:** the summary line, the day-and-times text and "Next … starts" are generated
  (`src/lib/programme-text.ts`) unless Michael writes his own; each has "reset to automatic" (clear the field).
- **Slugs:** leagues default to their code (`/leagues/tnl`), other kinds to their name. A URL change on anything that
  has been public (not a draft) leaves 301s for the page and every page under it (seasons, terms, events), repoints
  older redirects and is refused if a content page or another programme uses the URL. Category slugs and page paths
  can't collide either way, and `/training`, `/programs` and `/events` are reserved for programme pages.
- **Products are created with their instance:** every training session, development term and event gets its
  product row at creation, so caps and later enrolments always have one row to live on (seasons get theirs from
  enrolment). Instance caps are on the instance's dialog; blank means the programme default.
- **Weekly runs are idempotent:** dates that already have a session are skipped, so "add weekly sessions" can be
  rerun safely; at most 60 at once.
- **Moving a session or event keeps its first date** (`original_date` / `original_start_date`), for "postponed from …".
- **Lifecycle guards:** a programme needs a category to go live; active → draft only without history; a category
  can't be retired while it has active programmes; nothing with seasons, sessions, enrolments, menu links or page
  blocks can be deleted, only retired.
- **Cache tags** `programme:<slug>`, `category:<slug>`, `programmes` and `venues` (src/server/cache.ts) plus SITE for
  anything the menu shows; see [api/programmes.md](api/programmes.md#cache-tags).

### 3.10 Build order (Phase 6)

1. **Done:** programmes and categories: data model, the four admin sections, category management (absorbs "league
   management" and "venues and courts" from section 1).
2. Menu and blocks: automatic category dropdowns, the Programme list block, Ladder and Fixtures blocks.
3. Public pages: category and programme pages, flat URLs with 301s, league page tabs.
4. Enrolment: forms, caps, waitlists, manual paid/unpaid, CSV export. **Done** (section 3.7); the pages showing the
   form come with step 3.
5. Content map: rewrite the 37 imported pages into the new structure for Michael's review.
6. The rest of section 1 (postponed/TBD, bulk postpone or cancel a night, cross-league match list, withdrawn teams,
   tie-break order, fixture lists and iCal) and the analytics in section 2 (built; waiting for credentials).

Phase 7 then designs how the category, programme and enrolment pages look and does their SEO (structured data for
leagues and events, sitemap).

## 4. Admin UI/UX

To be written with Jeremy. Known items so far:

- PR preview URLs can't sign in (Better Auth's origin and cookie checks use the staging URL).
- Trusted devices: every passwordless sign-in asks owners for a TOTP code.
- Media: Safari versions without canvas WebP encoding can't upload; abandoned uploads leave files in R2.
- Pages: re-inserting an image is needed after changing its alt text; the editor drops unsupported imported content on
  first save (the original is kept as a revision).
- Menu: no drag and drop between levels.

## 5. Later or optional

- Team logos, colours and descriptions.
- A head-to-head results grid.
- A referee name on TVSL matches (Volleyball NSW referees).
- A countdown to the next match.
- A results-entry helper role.

## 6. Not rebuilding (Tempe doesn't use these)

- SportsPress players, player lists and player statistics (the site has zero player records). Player records will come
  from registration and payments instead (Phase 5).
- Staff and the officials directory.
- The formula builder, sport presets, the setup wizard and sample data.
- Text relabelling, colour schemes, custom CSS and module toggles.
- Paid add-ons: tournament brackets, Sponsors, Scoreboard, Timelines, Branding.
