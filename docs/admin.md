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

| Feature                           | What we need                                                                                                                           | Status      | What's there / what's left                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Leagues**                       | Leagues as records (TNL, FNL …) that own their seasons, with add, rename, retire and reactivate                                        | **Done**    | Admin → Leagues lists each league with its seasons; a league opens to Details, Enrolment and Seasons tabs: add, rename, change URL (leaves 301s for the league and its season pages), category, retire, reactivate, delete while it has no history. Training, Development and Events have their own sections (sessions, terms, dates). API: [api/programmes.md](api/programmes.md).                                                                                                                                                                                                                                                                                  |
| **Seasons**                       | A league has quarterly seasons, each with its own settings                                                                             | **Done**    | Admin → Seasons: create, set up, publish, archive. Points per W/D/L and sets per match are per season.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Teams and rollover**            | Teams carry over between seasons; one-click "roll over to next season"                                                                 | **Done**    | "New season" copies the latest season's teams and settings. **Admin → Teams** lists every team across leagues with search and each team's seasons (history), and renames or creates teams. **Merge duplicates** moves team B's seasons, games (home, away, duty), ladder adjustments and enrolment groups to team A in one audited batch (`team.merge`), refused when both played in one season; B's team calendar feeds 301 to A's. Look-alike names that never shared a season are suggested for merging. A merge can be undone for 30 days (§3.11).                                                                                                               |
| **Venues and courts**             | Venues (Robyn Webster, MLC, Five Dock) separate from the courts inside them                                                            | **Done**    | Admin → Venues: name, URL, address, map link, directions; courts per venue with ordering and renames; delete only when unused. Programme, category and fixture pages read them. A **Venues** page block shows name, address, map link, directions and who plays there, so Where We Play can be generated (docs/content-map.md); until Michael swaps it in, the hand-typed page stays.                                                                                                                                                                                                                                                                                |
| **Matches**                       | Date, time, teams, court, match day, status, plus duty team, bye and finals placeholders as real fields                                | **Done**    | Duty, byes and placeholders are fields. Status is scheduled, played, forfeit, cancelled, **postponed** or **TBD**, with a public note, set per game on the Results tab and shown on the public fixtures. **Move one game to another night** (Results tab → "Move to another night"): an existing night or a new catch-up night, in a free slot, checked against the season and the other leagues' courts (`clashes.ts`); the old night lists it as "moved to …", the new one "moved from …" (`matches.original_match_day_id`); audited and undoable. An optional **referee** per game (`matches.referee`, always shown for TVSL) is edited there and shown publicly. |
| **Creating fixtures**             | The draw generator, with CSV import as a fallback                                                                                      | **Done**    | Generator (runs in the browser), plus **CSV import** for draft seasons, offered on the Setup tab and on the Fixtures tab before there's a draw: paste or pick a file, a preview listing every problem by line, then it becomes the draw (audited as `fixtures.import`). It meets the same checks as a generated draw. See docs/api/seasons.md.                                                                                                                                                                                                                                                                                                                       |
| **Match list**                    | Filters for team, venue, league, season and match day; results for a whole match day on one screen                                     | **Done**    | A season's Results tab shows a whole match day on one screen. Admin → **Matches** lists every game across leagues for a date range (Today, Next 7 days, this Thursday … buttons), filtered by league, season, team (playing or on duty), venue, court and status, each linking to its match day's results.                                                                                                                                                                                                                                                                                                                                                           |
| **Results**                       | Per-set points, sets and outcome worked out automatically, a manual override for forfeits and walkovers, draft → publish per match day | **Done**    | Per-set entry, draft → publish and undo. **Decide the outcome by hand** per game (home win, away win or draw, with a reason shown on the public fixtures), counted by the ladder whatever the scores. **Forfeits**: marking a game forfeit asks which team forfeited and enters the season's forfeit score (Setup → Ladder rules; default SportsPress's every set 25–0 and the loss point kept), still editable before publishing. See section 3.11.                                                                                                                                                                                                                 |
| **Scoring rules**                 | Fixed ladder columns, with W/D/L points, sets per match and tie-break order per season                                                 | **Done**    | Points and sets per match are per season. **Tie-break order** is configurable per season (Setup → Ladder rules: set or points difference, ratio or totals, wins, head to head; name is always last), defaulting to the old order. **The 1–1 rule** is per season too: a draw (default, the demo's rule) or decided on total points as SportsPress did. Michael confirms which (PLAN.md open question 7).                                                                                                                                                                                                                                                             |
| **Ladders**                       | Automatic, with point adjustments plus a reason, hiding a withdrawn team, and automatic "Week X of Y" and "Updated" lines              | **Done**    | Automatic, adjustments with reasons, and the generated headings. **Withdrawn teams**: withdraw one from the Results tab with a reason, optionally cancelling its remaining games (undoable with Reinstate). Per season, the ladder marks it (last, "withdrawn") or hides it, its results count or are voided, and its cancelled games show as cancelled or as byes.                                                                                                                                                                                                                                                                                                  |
| **Fixture lists**                 | Filtered lists ("this week", "upcoming") and an iCal feed per team                                                                     | **Done**    | `/leagues/fixtures`: this week (Mon–Sun, Sydney) or upcoming, across leagues or one, and one team's games and duties (GET filters, works without JS). League pages have Fixtures / Ladder / Results tabs. iCal feeds per league and per team (webcal links on the league page), following the current season. See §3.12.                                                                                                                                                                                                                                                                                                                                             |
| **Fixtures and ladders on pages** | "Ladder" and "Fixtures" blocks in the page editor that follow the current season (SportsPress used shortcodes)                         | **Done**    | Page editor → “+ Block…”: Ladder, Fixtures and Programme list blocks with a live preview and a settings dialog; they render on the public page from D1 at view time and purge with the data they show. See section 3.4 and [api/menu-and-blocks.md](api/menu-and-blocks.md).                                                                                                                                                                                                                                                                                                                                                                                         |
| **Bulk postpone or cancel**       | Postpone or cancel a whole night, with a choice to push the season back a week                                                         | **Done**    | Results tab → "Postpone or cancel the night" on a published season: postpone or cancel every game on it, or push this night and the rest of the season back a week (previewed with the lib's `pushBack()`, stepping over weeks off and holidays; results stay attached). One batch, audited, and undoable from the night or the new week off.                                                                                                                                                                                                                                                                                                                        |
| **Import and export**             | A one-time WordPress import, plus CSV export                                                                                           | **Done**    | `npm run import:wp` (staging so far; production in Phase 8) and a CSV download per season.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Roles**                         | Owner / admin / editor; a results-only helper role could come later                                                                    | **Done**    | With invites, the audit log and TOTP for owners. Editors see only results in Seasons.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Analytics**                     | Replace the Site Kit and Jetpack dashboards                                                                                            | **Partial** | Built: the GA4 tag (`GT-PLFFMCMT`, lazy-loaded) and the Cloudflare beacon on production www only, Settings → Analytics, the daily fetch from GA4, Search Console and Cloudflare into D1, Admin → Stats, and view counts in Admin → Pages. Left: the credentials (section 2.3); until then each source shows "not connected yet".                                                                                                                                                                                                                                                                                                                                     |

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
- **Every batched statement is a query builder** (fixed after the Phase 6 QA pass, where Stats returned 500 and the
  first claim of a configured source crashed on D1). The claim is `insert(analytics_state).onConflictDoUpdate({
setWhere }).returning()`, the store is `insert(analytics_daily).select(sql\`… json_each(?)\`).onConflictDoUpdate()`,
and the breakdowns are `select … group by`with aliased`sum(case …)`columns. They stay in their batches, keeping
the claim atomic with its log row and the query budget unchanged. To catch this class of bug before deploys,`createTestDb()`now behaves like drizzle's D1 batch: a raw`db.run/all/get/values(sql\`…${param}\`)`in a batch
throws, and batch rows go through D1's keyed-object step, so joined columns with the same name collide in tests
too. Guard statements use`batchGuard()` (src/server/db/index.ts).

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
  new programme adds its line automatically. Each line is the programme's summary line, the same text as category
  pages and `/enrol`; the block can have its own optional line template (for example the old site's
  `Next {name} ({code}) @ {venue} ({times})`), and each line can be reordered, hidden or overridden with hand-written
  text for that page.
- **Which text wins:** page override → the programme's own summary line → the block's template, if it has one →
  generated text. (This section is the authority; QA found the block used the template as a default, which made one
  programme read differently across the site. Fixed 2026-10-18: blocks without a template show the generated line.)
- **Changed data:** an overridden line keeps Michael's text, and the editor flags it when the programme's details change
  ("TNL's venue changed since you edited this line"), with one click back to the automatic text.
- **Retired programmes** drop out of every list, overrides included.
- **Ladder and Fixtures blocks:** pick a league; the block always shows its current season. They're data, so no per-line
  overrides, but they have display options (compact or full, number of rows, title override). This replaces SportsPress's
  shortcodes.
- **Venues block:** the venues from Admin → Venues (all, or chosen ones in a chosen order), each with its address, a
  "Map and directions" link (its map link, else a Google Maps search for name and address), the directions as typed,
  and "Who plays here" (active programmes whose usual venue it is). Options turn each part off and add a heading.
  Purged by venue and programme edits (`tags.venues`, `tags.programmes`).
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

**Status: Done**, public pages included: each programme page has an `#enrol` section with the form, and `/enrol` lists
everything open (§3.13).
Built: the form builder (Admin → Enrolments → Enrolment forms) with every field type, required, help text, reordering,
per-entry-type and conditional questions, defaults per kind and a live preview; `POST /api/enrol` with Turnstile,
validation against the form, exact caps by players and/or teams, waitlist, duplicate detection, D1 rate limits and
`TVB-XXXX` references; emailed waitlist offers with expiring accept/decline links and the hourly cron that passes
lapsed offers on; four email templates; Admin → Enrolments (per season, session, term or event, with counts against
the caps, search and filters, mark paid/unpaid with method and note, cancel, reinstate, move, promote and offer from
the waitlist, free agents into teams, add by hand, CSV export); and the `<EnrolmentForm>` island for `/enrol` and
programme pages. API: [docs/api/enrolment.md](api/enrolment.md). Left: real Turnstile keys for production (without
them the form says enrolment is unavailable) and Resend for the emails.

Hardened after the Phase 6 QA and security review: email confirmation before a spot is held, no "already enrolled"
answer on the page, per-mailbox email limits and a share of the daily email cap kept for offers, offer holds that start
when the email goes, rate limits that can't be used to lock someone out, capped request bodies, sanitised error logs,
fresh role checks and an audit row on every CSV download, waitlist places shown as ranks, one label and time format
for each target everywhere, and outbox retention. Then again after the final review (2026-10-19): offers that stop
before the start, unconfirmed details kept off the player record, one "check your email" answer for every public
entry, confirm deadlines that start when the link is sent, a share of the email reserve for confirm links, a body
cap on every request by default, one log scrubber for every server log line, the Turnstile action checked, and no
real email while the forms use Turnstile's test keys.

Decisions (each the more robust or more configurable option):

- **Caps are checked inside the insert's batch**, not before it, so the last spot can't be taken twice. Over the cap,
  an entry joins the end of the waitlist, also when others are already waiting, so nobody jumps the queue. With the
  waitlist off it's refused. The admin can still confirm someone past the cap, on purpose.
- **Offers go out automatically** whenever a spot frees up (cancel, delete, move, a raised cap, a decline, a lapsed
  offer), held for the programme's offer hours (48 by default, per instance). The cron keeps going down the list. The
  admin can also offer, confirm or resend by hand. One request offers at most 5, and the cron at most 3 an hour, to
  stay inside the free plan's query limit.
- **Offers stop before the start** (QA: an offer could outlast its session): Settings → Enrolment → "Hours before the
  start that waitlist offers stop" (default 2, 0–168). An offer is never held past that point (start minus the
  cut-off), even when its email is sent late, and once it has passed no offers are made, automatically or by hand
  (`409 offers_closed`), so a spot freed at the last minute isn't held for someone who won't answer in time. Skipping
  to the next person wouldn't help (they'd have the same time left), so offers simply close; the enrolment screen
  says so and the admin can still confirm someone from the waitlist. The start is the session's date and start time,
  an event's first day and start time, or a season's first game night (its first match day that isn't a skipped
  week, at the earliest game time, else the league's start time); with no time known it counts from midnight, so the
  cut-off errs early. Development terms have no cut-off: a place in a term that has started is still worth having.
  One global setting rather than one per programme: it's about how quickly people answer email, which doesn't vary
  by programme, and it can move to the programme later without a data change.
- **Offer links are signed, not stored**, and die the moment the offer is answered or lapses.
- **Duplicates** are the same email and the same first and last name in the same target, so siblings can share a
  parent's email. A public form fills only blank player details and never overwrites what's there.
- **Unconfirmed details stay off the player** (security review L3): an entry waiting for its email confirmation keeps
  the details it was sent with (mobile, year of birth, guardian, emergency contact) on the registration
  (`registrations.pending_details`), not the `players` row. A new player row gets only the name and address the entry
  is for; an existing one isn't touched. Confirming the address (the link, or an admin's "Confirm email" or
  "Confirm") merges them in, filling blanks only, and clears them. So someone typing another person's address can't
  put their own phone or emergency contact on that person's record. The admin sees held details marked "not saved
  until the email address is confirmed", and the confirm page lists them so the address owner sees what they're
  confirming. **A repeat of an unconfirmed entry replaces it**: the older one is cancelled ("Replaced by a newer form
  before the email address was confirmed", its link stops working) and the newer form gets a fresh link, so the
  address owner always confirms what was typed last, not what someone else may have typed first. Lapsed and replaced
  unconfirmed entries are deleted after Settings → Enrolment → "Days to keep sent emails" (default 30), with their
  player row when nothing else uses it.
- **Rate limits** live in D1 (`rate_limits`, fixed windows): 20 an hour per IP, 6 an hour and 15 a day per email.
  Only the IP is counted before Turnstile, so junk without a solved check can't lock a person's email out; the email
  limits key on the canonical mailbox (lower-case, `+tag` dropped, Gmail dots dropped), so `pat+1@gmail.com` and
  `p.at@googlemail.com` count as `pat@gmail.com`.
- **Email confirmation before a spot is held** (the security review's main finding): a per-programme setting with a
  per-instance override, like the caps, **defaulting to on for anything capped** (where a spot is worth taking) and
  off for uncapped ones. A public entry then starts as `pending_email`, holding no spot and not on the waitlist, and the
  person is emailed a signed link (HMAC, in the URL fragment, single-use); clicking it on the page settles the entry
  against the caps in one batch, exactly as a new entry would be, so it may join the end of the waitlist (or, with the
  waitlist off, be cancelled as full). The link works for Settings → Enrolment → "Hours to confirm" (default 24); the
  hourly cron then expires it. Admins see "Awaiting email" entries and can confirm them by hand (settled against the
  caps), resend the link (the deadline restarts) or confirm past the cap. Queue order is the order addresses are
  confirmed in, not the order forms were sent: an unconfirmed entry can't keep a place.
- **The form never says "already enrolled"**: that would tell anyone who a named person (maybe a junior) is entered
  with. A repeat answers like a new entry and the address on file gets the news (a fresh confirm link, or its
  reference and where it stands). **Every public entry gets one of two answers, both "check your email"**, decided
  only by the target's setting (security review L4): `pending_email` where confirmation is on, `emailed` where it's
  off. With confirmation off the entry is still settled at once (confirmed or waitlisted), but the reference and
  whether there's a spot are only in the email, never on the page, so a new entry and a repeat look the same; the
  page shows only what's the same for everyone (the programme, target, fee and the form's confirmation text). Chosen
  over "a fresh-looking reference for repeats" because there's nothing to keep in step: no fake reference that must
  look real. And with the waitlist off and no room, a repeat is refused as `full` exactly as a new entry would be.
- **Email is rationed so junk can't crowd out real mail**: anything an anonymous form triggers is limited per mailbox
  (5 an hour, then queued; 10 a day, then dropped) and stops 20 short of the general daily pool, which is kept for
  priority email: offers, cancellations, admin actions and anything after a confirmed address. **Confirm links may use
  10 of those 20** (security review L1), so junk "already enrolled" or other anonymous mail can't hold up the link a
  real entrant needs, while junk confirm links still can't touch the last 10 kept for offers and admin email. (Not
  full priority: anyone can trigger a confirm link, so that would let junk eat the offers' share.) A waitlist offer's
  hold, and a confirm link's deadline, **start when the email actually goes**: a link queued behind the day's cap gets
  its full time from when it's sent, the cron never expires an entry (or lapses an offer) whose email is still queued,
  and the drain drops a queued link whose entry was confirmed by hand or replaced meanwhile. The confirm email
  carries no team name (free text isn't sent to an address nobody has confirmed); the confirm page shows it.
- **Draft seasons take enrolment** when their league's enrolment is open: that's next season's enrolment, opened
  before the draw is published. A draft _programme_ takes none, and archived seasons are closed.
- **Waitlist places are ranks** (1, 2, 3 … in waitlist order), worked out when shown; the stored position is only an
  ordering key, so nobody is told they're number 2 when they're next.
- **One name and time format per target**, built from the season, session, term or event row each time (never the
  product's stored name), with times as "6–8pm" / "11am–1pm" from `src/lib/time.ts`: form choices, admin lists, the
  offer and confirm pages and every email agree.
- **Request hardening**: every JSON body is capped before parsing, by default (security review L5): `readJson` caps at
  64 KB everywhere outside `/api/admin` (the enrolment, offer, confirm and invite routes; the invite routes pass 4 KB)
  and at 1 MB on `/api/admin/*`, and a route can only choose another cap, never none. Better Auth's `/api/auth/*`
  bodies are capped at 16 KB before Better Auth reads them. Answers are capped at 32 KB. **Logs never carry personal
  data** (security review L2): every console call on the Worker side logs an error through `describeError()`
  (`src/server/log.ts`): name, code and message, with a failed query's SQL text and bound values cut off (those are
  names, emails, phones and the signed links in offer, confirm and invite emails). That covers the mailer, the
  enrolment emails, invites, the cache purge, media, redirects, analytics and the cron (which also catches a job
  failure escaping it and rethrows a plain one), and `src/server/log.test.ts` fails the build if a console call in
  `src/server`, `src/pages` or the middleware passes a raw error. Production refuses Cloudflare's Turnstile test keys
  and, with real keys, checks the hostname a token was solved on and the widget's action (`enrol`), so a token from
  another widget using our key can't be spent on the form (I-4). And **no real email while the forms run on the
  test keys** (I-4): with Turnstile's always-pass keys (development and staging without real ones), anyone could
  make `/api/enrol` mail any address, so a `RESEND_API_KEY` there is ignored and emails keep going to the log until
  real Turnstile keys are set too.
- **Editors get no access** to enrolments or forms: it's personal data, juniors' included, and nothing an editor does
  (results, pages, news) needs it. Admins and owners see everything. Revisit if Michael wants a check-in helper. The
  reads re-check the role in D1 (not the 5-minute session cache), so a removed or demoted admin loses access at once,
  and every CSV download is audited (`enrolment.export`: which target, how many rows).
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
row with it when nothing else uses it. Sent and failed emails (with their addresses) are deleted from the outbox after
Settings → Enrolment → "Days to keep sent emails" (default 30); queued ones stay until sent. Unconfirmed entries that
lapsed or were replaced are deleted after the same number of days (from when they lapsed), with their player row
when nothing else uses it; their contact details were never on the player. Deleted data can still
sit in the backups for a while: the nightly D1 export in R2 is kept for **30 days** (the bucket's lifecycle rule,
.github/workflows/backup.yml) and D1's own Time Travel can restore any point in the last **7 days** (the free plan's
window), so "Delete for good" is complete after at most 30 days. The privacy policy (Phase 7) should say
so. A yearly clean-up of finished seasons (for example after 2 years) is a follow-up for Michael to decide.

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

**Status: Done on staging, waiting for Michael's review.** The map is [content-map.md](content-map.md), with the
questions for Michael and the go-live steps. The drafted text is `scripts/content/drafts.ts`, applied by
`scripts/content/apply.ts` as guarded SQL (`scripts/content/content-map.sql`, checked in for Phase 8). On staging: 6
draft programmes (ADP, Scrim & Coached Training, Thursday Night Casual Training, JDP, Junior Rep Teams, Tempe Cup),
the four category intros, the TVSL description, league times, venue directions, proposed revisions of the six kept
pages, a draft `/enrol` intro page, 19 stale pages archived with 301s, and dormant 301s for the 9 pages that move later.

Decisions (each the more robust or more configurable option):

- **Nothing published is overwritten.** New programmes are drafts; a kept page's proposal is a revision just behind
  the live version (Revisions → View → Restore), and `/enrol`'s intro is a draft page. Only empty fields (category
  intros, the TVSL description, league times, venue directions) were filled directly.
- **Guarded and repeatable:** every statement only touches rows nobody has edited in the admin (`updated_by` null, no
  page revisions) that still have the imported title or an empty field, and running it again changes nothing. Ids are
  deterministic, so production gets the same rows.
- **Redirects are written before their page goes:** a published page wins over a redirect, so each moving page's 301
  is already in place and takes effect the moment Michael archives it. Pages archived now point at pages that are
  live today (a category page, `/enrol`, `/rules`), never at a draft.
- **Dateless text:** dates, prices and fees go in the fields that change each season (seasons, sessions, products,
  "next starts" text), not in descriptions. Where the old site had a price (Thursday casual: $15, 40 a session) it went
  into the draft programme's price and cap. Category intros don't name days or venues because the cards under them are
  generated.
- **Multi-venue programmes** (ADP, JDP) have no default venue and a hand-written day-and-times label, rather than two
  programmes, so they keep one page, one form and one enrolment list; each term can still set its own venue.
- **The home page's typed-out league and program list becomes two Programme list blocks** in its proposed revision, so
  a new or retired programme updates it by itself.
- **Re-imports respect the admin:** `npm run import:wp` no longer overwrites a page edited in the admin, never changes
  a page's status (so archived pages stay archived), and doesn't append oversized bodies to a page it skipped.

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
2. **Done:** menu and blocks: automatic category dropdowns, the Programme list block, Ladder and Fixtures blocks
   (decisions in section 3.12, API in [api/menu-and-blocks.md](api/menu-and-blocks.md)). The category landing pages
   the dropdowns link to are step 3.
3. **Done:** public pages: category and programme pages, flat URLs with 301s, league page tabs, `/enrol`, fixture
   lists and iCal feeds (section 3.13).
4. Enrolment: forms, caps, waitlists, manual paid/unpaid, CSV export. **Done** (section 3.7); the pages showing the
   form come with step 3.
5. **Done (staging, for review):** content map: the 37 imported pages rewritten into the new structure for Michael's
   review (section 3.8, [content-map.md](content-map.md)).
6. **Done:** the rest of section 1 (postponed/TBD, bulk postpone or cancel a night, cross-league match list, withdrawn
   teams, tie-break order, CSV fixture import, fixture lists and iCal, outcomes decided by hand, forfeit and 1–1 rules,
   moving one game, referees, the team list with merging) and the analytics in section 2 (built; waiting for
   credentials).

Phase 7 then designs how the category, programme and enrolment pages look and does their SEO (structured data for
leagues and events, sitemap).

### 3.11 Fixtures parity decisions

Each takes the more robust or more configurable option:

- **Push back a week** moves the night and every later night (finals too) by at least a week, stepping over weeks off
  and skip dates, and keeps game ids, so results, duty and courts stay attached. The admin previews exactly what the
  server saves (the same pure `pushBack()`), and the server re-runs it rather than trusting the browser's dates.
- **Undo is built in.** Postponing, cancelling and pushing back a night, and withdrawing a team, record what they
  changed in the audit log, and Restore or Reinstate puts back exactly that. A push-back can only be undone while the
  nights are still where it put them and haven't got results since.
- **Withdrawn teams keep their data.** Withdrawing marks the season team and cancels its remaining games (not its duty
  games, which are listed so the admin finds another referee). How it shows (marked or hidden, results kept or voided,
  cancelled games or byes) is a season setting that can change any time without touching data.
- **Tie-breaks are a list**, not a fixed choice, with head to head worked out among the teams still tied. Name is
  always last so the order is stable.
- **CSV import meets the same bar as the generator** (no clashes, everyone plays the same number of games), so a
  CSV draw publishes like any other. Its problems are listed by line before anything is saved.
- **Postponed and TBD games keep their draft results**; cancelled ones lose them, as before.
- **Outcomes decided by hand are part of the result** (`match_results.outcome` and `note`), so they go through draft →
  publish like scores and can be undone with the day. The outcome wins whatever the scores say (sets and points still
  count for S+/S−/P+/P−), a result can be just an outcome (missing sets and points count as 0, shown as "W - L"), and a
  reason is required because the public fixtures show it ("Blockers awarded the win: …"). Head to head and finals
  seeding use the same decided outcome.
- **The forfeit score is a season setting, not a fixed rule** (Setup → Ladder rules, waiting on Michael): sets and set
  points for the winner and the forfeiting team, and whether the forfeiting team keeps the loss points. The default is
  what SportsPress recorded on staging's imported forfeits: the winner gets every set it needs 25–0 (2–0 social, 3–0
  TVSL), and the forfeiting team keeps its loss point (MM7 and Backcourt Liberos needed no reconciliation adjustment).
  Marking a game forfeit asks which team forfeited and writes that score as the **draft** result, decided by hand for
  the other side (note "Forfeit"), so it's checked and published like any result and can be changed first. The loss
  points rule reads the game's forfeit status, so changing it re-scores past forfeits too, without touching data.
- **The 1–1 rule is a season setting** (`levelSets`): `draw` (default, the demo's rule) or `points` (SportsPress's:
  more rally points wins, level on points too is a draw). Missing means draw, so every existing season is unchanged.
  Finals use it as well: under `points` a 1–1 final decided on points can be published. Imported seasons already match
  SportsPress through their `wp-import reconciliation` adjustments, so the admin warns against switching those to
  `points` (it would count the difference twice). PLAN.md open question 7 stays open until Michael confirms.
- **Moving one game is its own action, not a draw edit**: the published draw stays locked, and the lib's
  `moveToNight()` (shared by the dialog's preview and the server) only allows a free slot on another night of the same
  season, or a new catch-up night on any free date (same kind and match day number as the game's night, so "Week X of
  Y" still counts match days). A team playing at that time or the duty team playing then is refused; a double header or
  a duty team that isn't playing that night is a warning. Court clashes with the other leagues at the venue that night
  are refused. A postponed or TBD game becomes scheduled; it keeps its id, draft result and duty. The original night
  is remembered once (`original_match_day_id`), so a game moved twice still says where it was first; moving it home
  clears it. Undo (`match.move_undo`) restores exactly what `match.move` recorded and removes a catch-up night it
  emptied, while the game is still where the move put it and has no published result.
- **Referees are free text per game** (`matches.referee`, ≤ 80 characters), saved as you type (on leaving the box),
  editors included, like results. The box is always there for seasons without team duty (TVSL) and behind "Add a
  referee" elsewhere; the public fixtures show "Referee: …" under the match and in calendar feeds.
- **Merging teams keeps the team you pick** (its name, slug and calendar URLs) and moves everything of the other one in
  one batch of single `UPDATE … WHERE team_id = B` statements (2 parameters each, so a big merge costs the same). It's
  refused when both teams played in one season. The duplicate's calendar feeds get 301s, redirects that pointed at
  them are repointed (no chains), and its WordPress id moves over when the kept team has none. Suggestions only pair
  look-alike names that never shared a season. A merge is also refused when either team has games or adjustments in
  the other's season, and B's seasons' draw keys (`generated_from`) follow it, so they don't say "Settings changed".
- **Merges can be undone for 30 days** (Admin → Teams, "Recent merges"; the audit row links there). The merge's audit
  row keeps what's needed (`before.undo`); undo re-creates B with its id, name, slug and WordPress id, and puts back
  everything in B's seasons by season, so games added there since the merge go back to B too (A wasn't in those
  seasons, or the merge would have been refused). Feed redirects the merge made are removed and re-pointed ones
  restored. It's refused once undone (B exists again, so a double click can't apply it twice), when the kept team has
  since gone, or when another team took B's name or web address. Audited as `team.merge_undo`. 30 days rather than
  forever: after a month a split is better done by hand. Merges made before this existed say so and stay in the audit
  log.
- **Imported draws aren't "out of date".** The importer now writes `seasons.generated_from` (`drawShapeKey()`), so the
  Fixtures tab's "Settings changed" banner only means a real change. `scripts/fix-imported-seasons.ts` (guarded,
  idempotent, audited as `import.fix`) wrote the key for seasons imported before, in SQL that a test holds to the
  TypeScript key, and removed SportsPress placeholder "teams" nothing used (BYE, Grand Final, 3rd Place); the importer
  no longer creates those. Applied to staging on 2026-10-19.
- **An imported draw's quirks are notes, not problems.** The old site kept no duty team for most games, had double
  headers and uneven meetings. For an imported season (`SeasonMeta.imported`), whatever the saved draw already has
  shows as grouped, neutral notes ("A game has no duty team (36 times, match days 1–9)") with a line saying nothing
  needs fixing, the fairness table isn't coloured, and the save toast doesn't count them. Anything an edit adds (a
  court change that clashes) is still a warning or problem, and the server still refuses new errors.
- **Catch-up nights default to the first free week before the finals** (`suggestCatchUpDate`), so a postponed
  round-robin game counts before the finals are seeded; if no week is free the dialog says the default is after them.
- **CSV import is offered wherever there's no draw yet**: the Setup tab's summary and the Fixtures tab, which a draft
  can open before a draw exists (empty state: Generate draw, or Import fixtures from CSV).

### 3.12 Menu and blocks decisions

Build step 2, each taking the more robust and more configurable option:

- **One menu module:** `src/lib/content/menu.ts` validates (`checkMenu`), builds the tree (`buildMenuTree`) and the
  public menu (`publicMenu`, `isActive`); `src/lib/menu.ts` is gone. `loadSite()` loads every non-draft programme and
  category in its one batch, so the header needs no extra queries.
- **Category items fill themselves:** a top-level `category` item links its landing page and lists each active,
  menu-visible programme in it, in programme order. A category that isn't active hides its dropdown.
- **Hiding a programme from menus** is the programme's `menu_visible` switch, set from the menu editor's dropdown
  preview (admins, since it's a programme setting; audited with the menu save) or the programme page. Retired and
  draft programmes never show.
- **Pinned links:** hand-made sub-items of a category item sit before or after the automatic links (`placement`). A
  `programme` sub-item for a programme the dropdown lists anyway replaces its automatic link, which is how a link is
  renamed or moved without a new column.
- **Hidden items:** any item can be hidden (kept in the admin, off the site), so Michael can stage a change.
- **Old league links still work:** `league_ladder` / `league_fixtures` items keep resolving to `#ladder` /
  `#fixtures`, but the editor only offers them on items that already use them.
- **Instagram and Facebook** are icons in the header (from Settings → Social), not menu items; Login left the menu.
- **The staging menu** was moved to the proposed top level by `scripts/menu-phase6.ts` (guarded: it refuses once the
  menu has been edited in the admin, and writes a `menu.update` audit row so it runs once). The importer's `MENU` is the
  same structure, and the importer now only writes the menu while nobody has edited it.
- **Programme JDP, ADP and training pages** aren't programme records yet, so they're pinned links under Juniors and
  Adult Training; once Michael creates the programmes, he removes the pinned links (or hides the programmes).
- **Blocks render at view time** from the body's blocks; the stored HTML leaves them out, so revisions, excerpts and
  meta descriptions never contain stale data. A page without data blocks is served from its stored HTML as before.
- **Which text wins:** page override → the programme's summary line → the block's template (only if it has one) →
  the generated summary line (`generatedSummaryLine`, as on category pages and `/enrol`); a block can turn summary
  lines off (`useSummaryLines`) when it needs its own wording for every line. Overrides use the same placeholders as
  the template, and existing overrides and templates are kept as they are.
- **Change flags:** an override stores the programme's details when it was written; the editor shows “TNL's venue
  changed since you edited this line” on the block and in its settings, with Reset to automatic or Keep my text.
- **The "status" filter** is enrolment state (any, open now, closed now): only active programmes are ever listed, so a
  programme-status filter would have nothing to choose.
- **Ladder and Fixtures follow the current season**, falling back to the latest archived season between seasons so a
  page doesn't go blank. A league with no season shows nothing on the site and a note in the editor.
- **Previews are the real renderer:** the editor asks the server to render the block (`POST /api/admin/blocks/preview`),
  so what Michael sees is what the page shows.
- **Attrs are normalised on save** (bounded lengths and counts, unknown fields dropped), and every value is escaped
  when rendered. Blocks are offered in the page editor only, not news posts.

### 3.13 Public pages (build step 3)

| URL                                                                | What                                                                                                                                                                                                      | Route / data                                                                           |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/<category>`                                                      | Breadcrumb, the category's intro (Admin → Categories), a card per active programme: summary line, next start, enrolment open or closed, links to the page and its `#enrol`                                | `src/pages/[...path].astro` → `loadCategoryPage()` (`src/server/programmes/public.ts`) |
| `/leagues/<slug>`                                                  | Breadcrumb (category › league), when and where, "Next season starts …", the description, then **Fixtures / Ladder / Results** tabs, the season archive, the `#enrol` section and calendar links           | `src/pages/leagues/[league]/index.astro`                                               |
| `/training/<slug>`, `/programs/<slug>`, `/events/<slug>`           | Breadcrumb, when and where, description, upcoming sessions / terms / dates (postponed and cancelled marked, "moved from", spots left while open), then `#enrol` with the form                             | `ProgrammeDetail.astro` via `programmeRoute()` (`src/server/programmes/route.ts`)      |
| `/training`, `/programs`, `/events`                                | Every active programme of that kind, by category (cards as on category pages, with open sessions/terms/dates and spots left); the title and intro come from a page published at that path if there is one | `src/pages/{training,programs,events}/index.astro` → `kindIndexRoute()`                |
| `/enrol`                                                           | Everything open now, grouped by category (cards list each open session/term/season with spots left), then what isn't open yet with its next start                                                         | `src/pages/enrol/index.astro` → `loadListings()`                                       |
| `/leagues/fixtures?view=week\|upcoming&league=<slug>&team=<slug>`  | This week (Monday–Sunday, Sydney) or upcoming games, all leagues or one, or one team's games, byes and duties; grouped by night, one table per league                                                     | `src/pages/leagues/fixtures.astro`                                                     |
| `/leagues/<slug>/calendar.ics`, `/leagues/<slug>/teams/<team>.ics` | iCal feeds of the league's current season, or one team's games and duties in it                                                                                                                           | `src/server/competition/feed-route.ts`, `calendar.ts`, `src/lib/ical.ts`               |

Decisions (each the more robust or more configurable option):

- **Tabs degrade to sections.** Without JavaScript the three sections stack with their headings; a 1 KB inline script
  turns them into ARIA tabs (arrow keys, Home/End). The page opens on the **fixtures before the first game night**
  (and while there's no draw) and on the **ladder** from then on (`defaultLeagueTab()`, `src/lib/fixture-lists.ts`).
  `#fixtures`, `#ladder` and `#results` (old links too) open their tab, and clicking a tab updates the hash so links
  can be shared. A night moves from Fixtures to Results once its date passes or its results are published.
- **Generated text, hand-editable.** Cards and pages use the same text as the admin (`src/lib/programme-text.ts`): the
  programme's own summary line, schedule label and "next starts" text win over the generated ones; the SEO title and
  description fields win over the generated `<title>` and meta description. The `/enrol` intro is editable: publish
  a page at `/enrol` in Admin → Pages and its title and body show above the list.
- **Lifecycle.** Drafts are 404s everywhere. Retired programmes keep their page with "This … has finished" and what
  they ran (past seasons, sessions, terms or events), and say "below" only when something is listed; a league with
  no public season drops "Ladder, Fixtures and Results" from its title. They leave category pages, `/enrol`, the kind
  index pages and the feeds. A slug of another kind 301s to the right prefix (`/training/tnl` → `/leagues/tnl`); an
  old slug follows the 301 the programmes admin wrote, and so do the league's calendar feeds and `?league=` (§3.14).
- **Spots left** come from the enrolment loaders (live counts against the caps); pages are edge-cached for 5 minutes,
  so the number can lag a few minutes. The server's cap check is exact, so a late entry joins the waitlist.
- **The form hydrates on scroll** (`client:visible`) and only where something is open, so programme pages stay at
  Lighthouse mobile 99–100 performance and 100 accessibility (checked locally on the built Worker; SEO shows 69
  only because non-production pages are `noindex`).
- **Fixture lists use GET parameters** on one URL under `/leagues` (no content page can take it, and "fixtures" is a
  reserved programme slug). Unknown league or team values fall back to everything, never an empty page, and the URL
  301s to what's shown so each view has one URL (§3.14). The old `/this-weeks-fixtures` page now redirects here.
- **iCal:** times in UTC (`…Z`) converted from Sydney local time, so no VTIMEZONE is needed and every client shows the
  right local time; `X-WR-TIMEZONE:Australia/Sydney` hints the display zone. UIDs are `<match id>@tempevb.com`, so an
  edit updates the event rather than duplicating it. Cancelled games stay in as `STATUS:CANCELLED` (calendars remove
  them); postponed and TBD ones are `TENTATIVE`. Feeds follow the **current** season, so one subscription lasts
  season after season; between seasons a feed is empty rather than a 404, so calendar apps keep it. Clients are asked
  to refresh every 6 hours.
- **Old enrolment pages → `/enrol`:** `/2023-enrolment`, `/2021-interest-in-playing`, `/new-player(-2023)`,
  `/new-team-group(-2023)`, `/returning-player` and `/returning-team` are `manual` redirects written by the importer
  (`ENROL_REDIRECTS` in `src/lib/wp-import/routes.ts`), never overwriting one Michael has edited. They take over as
  soon as each page is archived (a published page always wins over a redirect). The content map archived the five
  2020–2022 ones; `/2023-enrolment` and the two 2026 forms wait until `/enrol` is live (docs/content-map.md).
- **Cache tags** match the purge helpers: programme pages carry `programme:<slug>` (+ `league:<slug>`),
  `category:<slug>` (the breadcrumb), `venues` and `page:<path>` (which the enrolment admin purges); category pages
  `category:<slug>`, `programmes`, `venues`; `/enrol` `page:/enrol`, `programmes`, `venues`; fixture lists and feeds
  `league:<slug>` (and SITE, like every page).

### 3.14 Public-site robustness (QA and security fixes, 2026-10-18)

Each the more robust or more configurable option:

- **One URL per view (query strings).** Cloudflare's edge cache keys on the whole URL, so `/?x=<random>` used to miss
  the cache and render from D1 every time: a cheap way to burn the free D1 and Worker quotas. The middleware now 301s
  every public GET whose query string isn't canonical (`src/lib/canonical-query.ts`): each route lists the parameters
  it reads (only `/leagues/fixtures`: `view`, `league`, `team`, defaults and junk dropped, in that order), and
  everything else is removed. The redirect costs no D1. `/admin`, `/api`, `/media` and build assets are left alone.
  Trailing-slash redirects carry the canonical query, so an old URL is still one hop.
- **Campaign tracking is kept, not stripped.** A server-side 301 happens before GA4's script runs, so stripping
  `utm_*`, `gclid`, `gbraid`, `wbraid`, `fbclid` and `msclkid` would lose campaign attribution for every Instagram or
  email link. They pass through (first value each, in a fixed order, at most 200 characters) after the route's own
  parameters. Their values can still vary, so such hits can miss the cache; the memo below keeps them cheap and the
  WAF rule caps volume.
- **Per-isolate memo of `loadSite()`** (`createSiteMemo`, `src/server/site.ts`; public routes call `publicSite()`).
  While a copy is under 60 seconds old, a request costs one one-row query (the `site_version` row in
  `site_settings`, not a setting, so the Settings screen ignores it) instead of the whole batch. Every successful
  admin write (`/api/admin/*`, not GET) bumps that version in the middleware, so every isolate reloads on its next
  request and this isolate drops its copy at once; writes that skip the admin (the importer, `wrangler d1 execute`)
  show within 60 seconds. Bumping on every admin write, not just content, is deliberate: it's one tiny upsert, and
  a missed bump is worse. Admin routes still read fresh with `loadSite()`.
- **`workers_dev: false` for production and a free WAF rate-limit rule** are Phase 8 cutover items (PLAN.md), since
  production on `*.workers.dev` is never edge-cached. `wrangler.jsonc` is unchanged until then.
- **Renamed leagues keep their feeds.** `/leagues/<old>/calendar.ics`, `/leagues/<old>/teams/<team>.ics` and
  `/leagues/fixtures?league=<old>` follow the 301 the programmes admin left for `/leagues/<old>`
  (`renamedLeagueSlug`), so webcal subscribers keep their updates. Slug moves now also repoint old redirects whose
  target has a `#tab` (`/results` → `/leagues/tnl#fixtures`), so there are no two-hop chains.
- **Kind index pages** `/training`, `/programs`, `/events` list the active programmes of that kind by category, so a
  trimmed URL is a real, indexable page rather than a 404. Like `/enrol`, a page published at that exact path
  supplies the title and intro (pages may live at these four paths but not under the kind prefixes, and no category
  may take those slugs).
- **Copy:** cards show the "Next season starts …" sentence as on the programme page (no more "Next / Season starts");
  fixture tables show "(moved from …)" once per night, on its first row, so a pushed-back season doesn't crowd phones.

## 4. Admin UI/UX

The admin is built for a non-technical organiser who runs several league nights a week, often from a phone at the
venue. This section records how it's laid out, the shared building blocks every screen uses, and the decisions behind
them. The UX audit (2026-10-18) went through every screen at 1280 px and 390 px on a local build with the importer's
data and the content map applied; before and after screenshots are kept outside the repo.

### Layout and navigation

| Area                 | Status   | What's there                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grouped navigation   | **Done** | `src/admin/nav.ts`: Home, then **Competition** (Leagues, Matches, Teams, Venues), **Programmes & enrolment** (Training, Development, Events, Categories, Enrolments, Forms), **Content** (Pages, News, Menu, Media), **Site** (Stats, Settings), **People** (Admin users, Audit log, Security). Role-filtered.                                                                                                |
| Current location     | **Done** | The sidebar and the phone bar highlight the item a screen belongs to (a season belongs to Leagues), and the tab title follows the screen. Season, programme, enrolment, form, page and post screens have breadcrumbs (Leagues › Thursday Night League › TNL Q4 2026).                                                                                                                                         |
| Phone navigation     | **Done** | Below 1024 px a bottom bar in thumb reach: Home, Matches, Leagues, Enrolments (Pages for editors) and More, which opens every group as a bottom sheet. Safe-area insets are respected; the toast stack and sticky save bars sit above the bar.                                                                                                                                                                |
| Home dashboard       | **Done** | `/admin` (GET /api/admin/dashboard, [api/dashboard.md](api/dashboard.md)): tonight's and this week's games, earlier nights with results to enter or publish, enrolment needing a look (offers out, waitlists, emails to confirm, caps), drafts to review (the content map's programmes, page revisions, draft pages and posts), setup still needed (Resend, Turnstile, analytics, PayID) and recent activity. |
| Results at the venue | **Done** | The Results tab opens at tonight's match day (else the latest unfinished one), with a sticky "Go to" match day picker. 48 px score boxes with the numeric keypad, auto-advance after two digits, a sticky save/publish bar, and the draft-vs-published state on each day. Drafts save to the server on their own.                                                                                             |
| Code-splitting       | **Done** | Each screen is its own chunk; the editor (TipTap) only loads with a page or post. The season screen keeps only the Results tab in its chunk (24.6 KB gzipped, down from 40 KB): Settings, Fixtures (dnd-kit), Publish and Website load when opened.                                                                                                                                                           |
| Accessibility        | **Done** | Lighthouse accessibility 100 on Home, Matches, Results, Categories, Menu, Stats, Training, a league page, the page editor and Audit (mobile). A skip link, focus moved to each new screen, a visible focus ring, labelled dialogs that return focus, aria-live save status and toasts.                                                                                                                        |

### Known items (from the Phase 6 build)

| Item                                    | Status   | What's there                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR preview URLs can't sign in           | **Done** | On staging, a request to one of this Worker's own preview hosts (`pr-<n>-…` or `<8 hex>-…` in front of the staging host) gets a Better Auth instance whose base URL and only trusted origin are that host, so cookies, links and origin checks match it. No workflow change was needed. Previews share staging's D1, so the same admin accounts work.                 |
| Trusted devices                         | **Done** | "Trust this device for N days" on the TOTP step (Better Auth's own trust-device records and signed cookie). N is Settings → Sign-in security (owners; 0 turns it off). Security shows the count and "Forget all trusted devices"; Admin users has "Forget devices". Forgotten automatically on TOTP set-up again or off and on a role change. Audited.                |
| Media: Safari without canvas WebP       | **Done** | The uploader tests WebP encoding once and makes JPEG copies where it's missing (on white, since JPEG has no alpha); `media.variant_ext` records which, and every URL follows it. Not browser-tested on an old Safari (headless Chrome encodes WebP); the JPEG path is unit-tested.                                                                                    |
| Media: abandoned uploads left in R2     | **Done** | Uploaded files are marked (`customMetadata.source`), and the hourly cron deletes marked files over 24 h old with no media row, 400 keys a run, resuming where it stopped. The importer's files are never touched.                                                                                                                                                     |
| Pages: changing an image's alt text     | **Done** | Double-click an image (or Image settings… in the toolbar): description, caption, size (small/medium/large/full), alignment (centred, left or right with text wrapping), link, and "Choose another image" keeping the rest. render.ts writes a `<figure>` for them.                                                                                                    |
| Pages: imported content on first save   | **Done** | The editor now keeps what staging's imported pages use: captioned `<figure>`s, linked images, WordPress buttons (a "Button" link style), screen-reader-only text, sub/superscript, H5/H6 and 100%-wide Google Forms. Before the first save of an imported page or post, a notice lists what's still converted (columns, colours, anchors …) with "View the original". |
| Menu: drag and drop between levels      | **Done** | Drag onto a sub-item or a dropdown's "+ Add sub-item" strip to put an item in that dropdown, onto a top-level row to take a sub-item out. "Move to" stays for keyboard users; a dropdown with sub-items can't go inside another (two levels).                                                                                                                         |
| Page editor: keyboard insert of a block | **Done** | Type `/` on an empty line: a filterable menu of the data blocks, image, table, embed, heading, list and line (↑/↓, Enter; Escape types the slash). The toolbar's "+ Block…" and Image tooltips say so.                                                                                                                                                                |

### 4.1 Decisions (each the more robust or more configurable option)

API and protocol details: [api/security.md](api/security.md). The UX pass's decisions are in §4.3.

- **Previews derive their auth origin from the request, but only for this Worker's preview hosts.** `authOrigin()`
  (`src/server/auth/auth.ts`) accepts `https://pr-<n>-<staging host>` and `https://<8 hex>-<staging host>`, only when
  `SITE_ENV` is staging, with no port; anything else gets `SITE_URL`. Production never derives anything. Each preview
  host gets its own Better Auth instance per isolate (built once, ~1 ms), so its trusted origins are exactly one
  host, rather than Better Auth's dynamic `allowedHosts`, whose `*` wildcard also matches dots.
- **Trusted devices reuse Better Auth's twoFactor trust-device records** rather than a parallel store: the verify
  endpoints already create them and set the signed httpOnly cookie, so our passwordless hook only checks them, with
  the same HMAC as Better Auth (no crypto of our own). Revoking is a delete of the user's `trust-device-*` rows.
- **The trust period is fixed from when the code was entered**, not extended by each trusted sign-in (Better Auth's
  own hook rotates and extends; ours doesn't rotate). Owners set it (Settings → Sign-in security, 0–90 days, default
  30); a shorter period applies to devices already trusted; 0 turns it off and hides the tick box.
- **Revoked automatically** on TOTP enable/disable (after hooks), and on a role change or removal (in the role
  change's batch, next to signing them out). Admins and owners can forget the devices of anyone they could remove.
- **JPEG copies, not "original only"**, on browsers without WebP encoding: pages still get small responsive images.
  Transparent PNGs go on white.
- **The R2 sweep only deletes files the admin uploader marked**, so imported media (which the importer uploads
  without a marker, and which old page HTML may link to directly) is safe even if a row were missing. Per run: one R2
  list, at most one multi-key delete, one or two D1 reads and one write.
- **Image settings live in the image node** (caption, size, align, href attributes). A plain image still renders as
  a bare `<img>`, so existing pages are unchanged. Size and alignment are presets, not free pixel values, so pages
  stay consistent on phones (floats drop below 640 px).
- **Imported constructs are supported where staging uses them** (checked against the imported pages on staging, through the public site):
  figures with captions, linked images, WordPress buttons, `sr-only` spans, sub/sup, H5/H6, percentage iframe widths.
  Neighbouring text with the same link now renders as one `<a>`, so "here" plus its screen-reader text stays one link.
  The rest is listed before the first save by `importLosses()` (`src/lib/content/import-check.ts`), which must stay
  in step with `src/admin/editor/extensions.ts`.
- **The slash menu** opens only on an empty paragraph, so typing "/" in text still types a slash.
- **Menu drop targets are always laid out at a fixed height**: the "+ Add sub-item" row and, in a category dropdown,
  the "before the programmes" row (which says what it's for when idle), each one line with the hint cut short if
  needed, so nothing moves when a drag starts and the drop lands under the pointer (checked at 1280 px and 390 px). The
  dragged item stays in place, faded, and a `DragOverlay` of its own size follows the pointer (rows use
  `CSS.Translate`, never a scale). The most specific target under the pointer wins (a sub-item over its dropdown's
  row). The screen's long intro is now one line plus a collapsible "How the menu works".

### 4.2 Building blocks (src/admin/ui.tsx and friends)

New screens use these rather than one-off markup:

- **Buttons:** one `primary` per screen area; `secondary` for the rest; `danger` (outlined) for a destructive action and
  `dangerSolid` only as the confirm button of a destructive dialog; `link` for inline actions. A caller's own padding
  or text size wins over the defaults (`px-2 py-1 text-xs` really is small).
- **Confirmations:** `confirmAction({ title, body, confirmLabel, danger })` before anything destructive. The button
  names the action ("Delete page", never "OK") and Cancel has the focus.
- **Saves:** `toast('Saved.')` for a save that keeps you on the screen; errors stay until dismissed. Inline `Notice`s
  are for state that stays true (a locked season, a conflict).
- **Loading and errors:** `Skeleton` while loading, `LoadError` with **Try again** when a load fails. Network failures
  read "Couldn't reach the server. Check your connection and try again." (`friendlyError`).
- **Empty lists:** `EmptyState` says what the list is and what to do next.
- **Unsaved changes:** `useUnsavedWarning(dirty)` (`src/admin/unsaved.tsx`) on every screen form: the browser asks on
  reload or close, and in-app links and Back ask in the admin's own dialog. Several forms on one screen each register
  their own blocker. `Dialog` guards itself: once anything in one of its forms is typed in, Escape and × ask
  "Discard your changes?" (pass `dirty` to decide yourself).
- **Dialogs:** native `<dialog>` via `Dialog`, labelled by its title, focus in on open and back to the opener on close.
- **Reordering:** `MoveButtons` (▲/▼ with the row's name in the labels, 32 px, 44 px on touch screens).
- **Phone tables:** a list table hides its secondary columns below 640 px (`hidden sm:table-cell`) and repeats them
  as a small line under the first cell, rather than squeezing every column (Pages, News, Audit, Matches).
- **Touch:** on coarse pointers buttons, inputs and selects are at least 44 px tall and checkboxes 20 px
  (`.admin` rules in `src/styles/global.css`); inline link buttons at least 32 px.
- **Contrast:** secondary text is `text-black/60` or darker (4.5:1 on white and on the grey page); `/50` failed.

### 4.3 Decisions from the UX pass (2026-10-18)

- **Results drafts autosave to the server**, 2.5 s after typing stops (15 s between retries while offline), never to
  localStorage. Saves of one match day run one after another through a per-day queue that reads the latest token, so
  an autosave in flight can't make the next Publish fail with a conflict. A save that can't reach the server keeps the
  scores on screen with "No connection: your scores are kept on this screen and save as soon as you're back online",
  and the `online` event saves straight away. Days with problems (a half-typed score) wait instead of saving.
- **The Results tab opens at tonight**, else the latest played night still to publish, else the next one (`focusDay`,
  tested). A `#results-<id>` link (from Home or Matches) still wins.
- **The dashboard is one batch of grouped reads** plus the enrolment list and audit reads it already had helpers for
  (about 15 D1 queries, no writes). Played nights stay listed up to 120 days back until every game has a published
  result and no saved draft differs. "Pages to review" are imported pages no admin has edited that have a newer saved
  revision (the content map's proposals). Setup items are only shown to admins and owners, only when missing, and
  link to the card that fixes them (`/settings#settings-payid`).
- **Bottom bar, not a hamburger:** the four most-used screens are one tap away on a phone; More lists everything.
  Editors see Pages instead of Enrolments (which they can't open).
- **Dialogs detect edits themselves** rather than every caller passing `dirty`: a form dialog that was typed in asks
  before it's thrown away. Filters and pickers in a dialog that aren't inside a `<form>` don't count.
- **Table scrollers are positioned** (`.admin .overflow-x-auto { position: relative }`): `sr-only` text inside a wide
  table was escaping the scroller and making the whole Matches page scroll sideways on phones.
- **Matches on phones:** the filters fold behind a "Filters (n on)" button (the date range and quick days stay), and
  league, court and duty move under the game.
- **Settings has a section list** at the top (Banner, Contact, … Analytics), each card has an anchor, and saves toast
  "PayID: saved." instead of a notice inside the card.
- **Results for a night that hasn't happened yet** ask first ("This night is Thu, 22 Oct 2026, in 3 days …", Publish
  anyway), since an early forfeit is a real reason; and once scores are typed into a future night its card says so.
- **Score boxes:** Enter moves to the next box (home set 1 → away set 1 → home set 2 …) and from a game's last box to
  the next game's first. Every per-game button (Move…, Undo the move, Add a referee, Decide the outcome by hand, Enter
  set scores instead, Clear) names its game for screen readers and voice control.
- **The sticky save bar is one row on phones** (Discard · Save · Publish); the bye line and the problem note show from
  640 px up (the problem is also the Publish button's title, and the game itself shows it). "Postpone or cancel"
  drops "the night" on phones so it stays on one line.
- **Enrolments list what's on or coming up first, soonest first** (the next session is at the top at the door), then
  finished ones latest first (`targetOrder`).
- **Emails wrap at the @ and the dots** (`EmailText`), never mid-word, in Admin users and the audit log.
- **Image settings and data-block dialogs** use `confirmAction` (empty description) and `Skeleton` (loading).
- **Admin GETs that return emails (users, audit) re-read the role** (`fresh`), so a demoted admin loses them at once.
- **Image size presets set `sizes`** (small 20rem, medium 28rem, large 42rem), so a medium image doesn't fetch the
  800 px copy on a phone. Pages pick it up on their next save.
- **The season screen's other tabs are lazy**: Results is what's opened on a phone at the venue. `inputClass` moved to
  `src/admin/seasons/styles.ts` so dialogs don't drag SetupTab back into the Results chunk.

## 5. Later or optional

- Team logos, colours and descriptions.
- A head-to-head results grid.
- A countdown to the next match.
- A results-entry helper role.

## 6. Not rebuilding (Tempe doesn't use these)

- SportsPress players, player lists and player statistics (the site has zero player records). Player records will come
  from registration and payments instead (Phase 5).
- Staff and the officials directory.
- The formula builder, sport presets, the setup wizard and sample data.
- Text relabelling, colour schemes, custom CSS and module toggles.
- Paid add-ons: tournament brackets, Sponsors, Scoreboard, Timelines, Branding.
