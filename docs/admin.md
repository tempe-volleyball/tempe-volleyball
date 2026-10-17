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

| Feature                           | What we need                                                                                                                           | Status      | What's there / what's left                                                                                                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Leagues**                       | Leagues as records (TNL, FNL …) that own their seasons, with add, rename, retire and reactivate                                        | **Partial** | Schema done (0003): `leagues` is now the programmes table with kind, category, status (draft, active, retired), enrolment settings and more; see [data-model-phase6.md](data-model-phase6.md). No admin screen yet; the 5 leagues came from the import. See section 3.  |
| **Seasons**                       | A league has quarterly seasons, each with its own settings                                                                             | **Done**    | Admin → Seasons: create, set up, publish, archive. Points per W/D/L and sets per match are per season.                                                                                                                                                                  |
| **Teams and rollover**            | Teams carry over between seasons; one-click "roll over to next season"                                                                 | **Done**    | "New season" copies the latest season's teams and settings. Teams can be renamed and created. Still missing: a team list screen (merge duplicates, see a team's history).                                                                                               |
| **Venues and courts**             | Venues (Robyn Webster, MLC, Five Dock) separate from the courts inside them                                                            | **Partial** | Tables exist and seasons use them. No admin screen to add or edit venues, courts, addresses or maps; the public Where We Play page is still free text.                                                                                                                  |
| **Matches**                       | Date, time, teams, court, match day, status, plus duty team, bye and finals placeholders as real fields                                | **Partial** | Duty, byes and placeholders are fields. Status has scheduled, played, forfeit and cancelled; **postponed** and **TBD** are in the schema (plus a status note, the original match day and a referee) but not in the admin yet.                                           |
| **Creating fixtures**             | The draw generator, with CSV import as a fallback                                                                                      | **Partial** | Generator done (runs in the browser). CSV import missing.                                                                                                                                                                                                               |
| **Match list**                    | Filters for team, venue, league, season and match day; results for a whole match day on one screen                                     | **Partial** | A season's Results tab shows a whole match day on one screen. Missing: one list across all leagues filtered by team, venue or date ("everything on this Thursday").                                                                                                     |
| **Results**                       | Per-set points, sets and outcome worked out automatically, a manual override for forfeits and walkovers, draft → publish per match day | **Partial** | Per-set entry, draft → publish and undo are done. Forfeit is only a label on an ordinary score. The manual outcome override is in the schema (`match_results.outcome`, `note`) but not in the admin; the forfeit score rule waits on Michael (PLAN.md open question 7). |
| **Scoring rules**                 | Fixed ladder columns, with W/D/L points, sets per match and tie-break order per season                                                 | **Partial** | Points and sets per match are per season. Tie-break order is a season setting in the schema (`settings.tieBreaks`, defaulting to today's order), but the ladder and admin don't use it yet. The 1–1 rule (draw, or decided on points as SportsPress did) is still open. |
| **Ladders**                       | Automatic, with point adjustments plus a reason, hiding a withdrawn team, and automatic "Week X of Y" and "Updated" lines              | **Partial** | Automatic, adjustments with reasons, and the generated headings are done. Withdrawn teams are in the schema (`season_teams.withdrawn_at`/`reason`, `settings.withdrawn` to mark or hide them and keep or void their results); the ladder and admin don't use them yet.  |
| **Fixture lists**                 | Filtered lists ("this week", "upcoming") and an iCal feed per team                                                                     | **Missing** | The league page shows the whole season. No "this week" view, no team pages, no iCal feeds.                                                                                                                                                                              |
| **Fixtures and ladders on pages** | "Ladder" and "Fixtures" blocks in the page editor that follow the current season (SportsPress used shortcodes)                         | **Missing** | Block types are defined (`src/lib/content/blocks.ts`) and `page_data_refs` is in the schema for cache purges. The editor and rendering are missing. Designed in section 3.4.                                                                                            |
| **Bulk postpone or cancel**       | Postpone or cancel a whole night, with a choice to push the season back a week                                                         | **Missing** | Matches can be cancelled one at a time. The schema is ready (`match_days.status`, `original_date`; `matches.original_match_day_id`); the whole-night action and "push the rest of the season back a week" are missing.                                                  |
| **Import and export**             | A one-time WordPress import, plus CSV export                                                                                           | **Done**    | `npm run import:wp` (staging so far; production in Phase 8) and a CSV download per season.                                                                                                                                                                              |
| **Roles**                         | Owner / admin / editor; a results-only helper role could come later                                                                    | **Done**    | With invites, the audit log and TOTP for owners. Editors see only results in Seasons.                                                                                                                                                                                   |
| **Analytics**                     | Replace the Site Kit and Jetpack dashboards                                                                                            | **Missing** | Tables are in the schema (`analytics_daily`, `analytics_fetches`, `analytics_state`); the cron and Stats page are missing. See section 2.                                                                                                                               |

## 2. Analytics and the Stats page

The old site has Google Analytics 4 and Search Console through Site Kit, and Jetpack Stats. The rebuild:

| Piece                        | Plan                                                                                                                                                                     | Notes                                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Google Analytics 4**       | Keep the same tag (`GT-PLFFMCMT`) so the visitor history carries on unbroken                                                                                             | **Decision needed:** PLAN.md currently says "no cookies, no banner". GA4 sets cookies. It needs a short privacy-policy line; Australia doesn't require a cookie banner for this, but check before launch. GA4 also costs some page weight (≈ 50–90 KB).   |
| **Google Search Console**    | Keep the property and verify it by DNS TXT so it survives the move                                                                                                       | Done at the cutover (Phase 8).                                                                                                                                                                                                                            |
| **Cloudflare Web Analytics** | Add it: cookieless, page views, visits, referrers, countries, devices, Core Web Vitals, 6 months of history                                                              | Free. The beacon only works on the real domain.                                                                                                                                                                                                           |
| **Jetpack Stats**            | Drop it                                                                                                                                                                  | Its history can't be moved, and it may soon need a paid plan.                                                                                                                                                                                             |
| **Admin Stats page**         | A daily cron pulls GA4 (Data API), Search Console and Cloudflare (GraphQL Analytics API) into D1; the page reads only from D1, so it's fast and stays within free limits | Shows visitors, top pages, traffic sources, search queries and site speed. Needs: a Google Cloud service account with read access to the GA4 property and the Search Console property, and a read-only Cloudflare Analytics token. New tables (additive). |
| **Business numbers**         | Sign-ups, payments, revenue, session-pack balances, attendance, who still owes money                                                                                     | **Depends on Phase 5 (parked).** The Stats page should leave room for it.                                                                                                                                                                                 |
| **Optional**                 | View counts beside each page in Admin → Pages (like Jetpack's Stats column), a weekly summary email                                                                      | Free; from the same daily data.                                                                                                                                                                                                                           |

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

### 3.10 Build order (Phase 6)

1. Programmes and categories: data model, the four admin sections, category management (absorbs "league management" and
   "venues and courts" from section 1).
2. Menu and blocks: automatic category dropdowns, the Programme list block, Ladder and Fixtures blocks.
3. Public pages: category and programme pages, flat URLs with 301s, league page tabs.
4. Enrolment: forms, caps, waitlists, manual paid/unpaid, CSV export.
5. Content map: rewrite the 37 imported pages into the new structure for Michael's review.
6. The rest of section 1 (postponed/TBD, bulk postpone or cancel a night, cross-league match list, withdrawn teams,
   tie-break order, fixture lists and iCal) and the analytics in section 2.

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
