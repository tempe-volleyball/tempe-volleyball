# Admin plan (Phase 7)

What the organiser needs from `/admin`, and how far the rebuild has got. PLAN.md links here for Phase 7; keep the detail
here so PLAN.md stays short.

**The rule: no regressions.** Anything Michael relies on in SportsPress today must exist in the new admin before the
cutover (PLAN.md Phase 8). The research behind this is in
[docs/reference/sportspress-admin-rundown.md](reference/sportspress-admin-rundown.md): what SportsPress offers, what Tempe
actually uses, and what's tracking visitors on the old site.

Status as of 2026-10-18: **Done** = built and on staging, **Partial** = some of it exists, **Missing** = not started.

---

## 1. Must have before cutover (parity with SportsPress)

| Feature                           | What we need                                                                                                                           | Status      | What's there / what's left                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Leagues**                       | Leagues as records (TNL, FNL …) that own their seasons, with add, rename, retire and reactivate                                        | **Partial** | The `leagues` table and its `active` flag exist, but there's no admin screen; the 5 leagues came from the import. Retiring a league should also deal with its description page and menu items (see section 3).  |
| **Seasons**                       | A league has quarterly seasons, each with its own settings                                                                             | **Done**    | Admin → Seasons: create, set up, publish, archive. Points per W/D/L and sets per match are per season.                                                                                                          |
| **Teams and rollover**            | Teams carry over between seasons; one-click "roll over to next season"                                                                 | **Done**    | "New season" copies the latest season's teams and settings. Teams can be renamed and created. Still missing: a team list screen (merge duplicates, see a team's history).                                       |
| **Venues and courts**             | Venues (Robyn Webster, MLC, Five Dock) separate from the courts inside them                                                            | **Partial** | Tables exist and seasons use them. No admin screen to add or edit venues, courts, addresses or maps; the public Where We Play page is still free text.                                                          |
| **Matches**                       | Date, time, teams, court, match day, status, plus duty team, bye and finals placeholders as real fields                                | **Partial** | Duty, byes and placeholders are fields. Status has scheduled, played, forfeit and cancelled. Missing: **postponed** and **TBD**.                                                                                |
| **Creating fixtures**             | The draw generator, with CSV import as a fallback                                                                                      | **Partial** | Generator done (runs in the browser). CSV import missing.                                                                                                                                                       |
| **Match list**                    | Filters for team, venue, league, season and match day; results for a whole match day on one screen                                     | **Partial** | A season's Results tab shows a whole match day on one screen. Missing: one list across all leagues filtered by team, venue or date ("everything on this Thursday").                                             |
| **Results**                       | Per-set points, sets and outcome worked out automatically, a manual override for forfeits and walkovers, draft → publish per match day | **Partial** | Per-set entry, draft → publish and undo are done. Forfeit is only a label on an ordinary score; the forfeit score rule and a manual outcome override are missing (waiting on Michael, PLAN.md open question 7). |
| **Scoring rules**                 | Fixed ladder columns, with W/D/L points, sets per match and tie-break order per season                                                 | **Partial** | Points and sets per match are per season. Tie-break order is fixed in code; making it a season setting is missing. The 1–1 rule (draw, or decided on points as SportsPress did) is still open.                  |
| **Ladders**                       | Automatic, with point adjustments plus a reason, hiding a withdrawn team, and automatic "Week X of Y" and "Updated" lines              | **Partial** | Automatic, adjustments with reasons, and the generated headings are done. Hiding or marking a **withdrawn team** is missing.                                                                                    |
| **Fixture lists**                 | Filtered lists ("this week", "upcoming") and an iCal feed per team                                                                     | **Missing** | The league page shows the whole season. No "this week" view, no team pages, no iCal feeds.                                                                                                                      |
| **Fixtures and ladders on pages** | "Ladder" and "Fixtures" blocks in the page editor that follow the current season (SportsPress used shortcodes)                         | **Missing** | Pages are free text with no link to league data. See section 3.                                                                                                                                                 |
| **Bulk postpone or cancel**       | Postpone or cancel a whole night, with a choice to push the season back a week                                                         | **Missing** | Matches can be cancelled one at a time. No whole-night action and no "push the rest of the season back a week" (needs the postponed status above).                                                              |
| **Import and export**             | A one-time WordPress import, plus CSV export                                                                                           | **Done**    | `npm run import:wp` (staging so far; production in Phase 8) and a CSV download per season.                                                                                                                      |
| **Roles**                         | Owner / admin / editor; a results-only helper role could come later                                                                    | **Done**    | With invites, the audit log and TOTP for owners. Editors see only results in Seasons.                                                                                                                           |
| **Analytics**                     | Replace the Site Kit and Jetpack dashboards                                                                                            | **Missing** | See section 2.                                                                                                                                                                                                  |

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

## 3. How league data and pages fit together

Today there are two unconnected kinds of public page:

- **Generated league pages** (`/leagues/<league>` and `/leagues/<league>/<season>`) show fixtures and ladders from the
  season data and update themselves.
- **Free-text pages** (37 imported, such as the TVSL info page `/saturday-night-endorsed-league`, training, ADP and JDP)
  are written by hand and know nothing about leagues.

So retiring a league today means a database change plus archiving its description page and menu items by hand. To fix
that:

- **Ladder and Fixtures blocks** in the page editor (parity with SportsPress shortcodes): pick a league, and the block
  always shows its current season. Rendered on the server from the same data as the league pages.
- **A league owns its description.** Either the league page shows an editable description above its fixtures, or a
  league links to one page. Retiring a league then offers to archive that page and remove its menu items in one step.
- **Training and programmes** (adult training, ADP, JDP) stay as text pages for now. Making them real records (dates,
  capacity of 40, sign-up list) belongs with Phase 5, which is parked.

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
