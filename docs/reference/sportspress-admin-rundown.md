# SportsPress admin and analytics rundown

What the tempevb.com admin offers today, and what to rebuild.

## 1. How the SportsPress admin is organised

| Area                 | What it contains                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Content records**  | Events (matches), Calendars (fixture lists), Teams, League Tables (ladders), Players, Player Lists, Staff, Officials                                                                                    |
| **Tags on records**  | League, Season, Venue, Position, Staff role                                                                                                                                                             |
| **Configure screen** | Outcomes (win/loss/draw and the conditions that decide them), Results (per-set scores, with one "primary" result), Player performance, Table columns written as formulas, Player metrics and statistics |
| **Settings tabs**    | General, Events, Teams, Players, Staff, Text (relabelling), Modules (switching features on or off), Status, Licenses, Permalinks                                                                        |
| **Tools**            | CSV importers (events, fixtures, teams, players, staff, officials, player performance), setup wizard, sample data, presets for 21 sports                                                                |
| **Roles**            | League Manager (everything), Team Manager, Event Manager (needs approval), Staff, Player                                                                                                                |
| **Display**          | Shortcodes and widgets for event lists, event blocks, calendars, ladders, countdowns, a results matrix, plus iCal feeds                                                                                 |
| **Pro add-ons**      | Tournaments (brackets), Scoreboard, Sponsors, Team Access, Duplicator, Branding, Timelines and others                                                                                                   |

Tempe customised the volleyball preset:

- Their ladder adds draws, sets for and against, and a ratio of P+ ÷ (P+ + P−).
- Points are win 3, draw 2, loss 1.

## 2. What's tracking visitors on tempevb.com

| Tool                                     | What it does there                                 | What the organiser sees                                                                                                                                                                            |
| ---------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Google Analytics 4** (via Site Kit)    | The Google tag `GT-PLFFMCMT` on every page         | Visitors, sessions, top pages, traffic sources, devices and locations. Viewed in Site Kit's WordPress dashboard or on analytics.google.com.                                                        |
| **Google Search Console** (via Site Kit) | Connected, but not verified with a tag in the page | Search impressions, clicks, and the queries people used to find the site                                                                                                                           |
| **Site Kit's dashboard**                 | Shows Google's data inside wp-admin                | One dashboard covering the whole site and each page. It can also show PageSpeed scores.                                                                                                            |
| **Jetpack Stats**                        | A script from `stats.wp.com` on every page         | Page views, visitors, top pages, referrers, outbound clicks, search terms and countries. Shown in a wp-admin widget and a Stats column in the Pages list. Devices and UTM data need the paid plan. |

**A Jetpack catch:** Jetpack Stats is free only for non-commercial sites. Commercial sites over 5,000 views a month must pay, and taking registrations counts as commercial. Dropping it removes a possible upcoming bill.

## 3. What to build

### Must have: what Tempe uses today

| Feature                           | What SportsPress does                                                                        | What we should do                                                                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **League → Season structure**     | Records are tagged with a League and a Season                                                | Make them proper records: a league (TNL) has seasons (Q4 2026), and each season has its own settings                                                          |
| **Teams**                         | A single team record, reused and tagged by season                                            | Teams carry over between seasons. Add a **one-click "roll over to next season"**, which SportsPress charges for.                                              |
| **Venues and courts**             | One "Venue" field, used for Court 1/2/3 and MLC                                              | Keep **venues** (Robyn Webster, MLC, Five Dock) separate from **courts** within a venue                                                                       |
| **Matches**                       | Date, time, teams, venue, match day, status (on time, TBD, postponed, cancelled), officials  | The same, plus **duty team**, **bye** and **finals placeholders** as real fields. Today these are typed into match titles.                                    |
| **Creating fixtures**             | Add one at a time, or import a CSV                                                           | Our **draw generator**, with CSV import as a fallback                                                                                                         |
| **Match list**                    | Filters for team, venue, league, season and match day; inline editing of the main score only | The same filters, plus **results entry for a whole match day on one screen**                                                                                  |
| **Results**                       | Per-set scores; outcome worked out on save, with a manual override                           | Per-set rally points, sets and outcome worked out automatically, a manual override for **forfeits and walkovers**, and **draft → publish** for each match day |
| **Scoring rules**                 | A drag-and-drop formula builder                                                              | Fixed ladder columns, with W/D/L points, sets per match (2 for social, best of 5 for TVSL) and tie-break order set per season                                 |
| **Ladders**                       | Built automatically; teams chosen automatically or by hand; values adjusted by hand          | Automatic, with **point adjustments plus a reason**, hiding a withdrawn team, and automatic "Week X of Y" and "Updated" lines                                 |
| **Fixture lists**                 | Filters, fixed or rolling dates, iCal feed                                                   | Filtered lists ("this week", "upcoming") and an **iCal feed per team**                                                                                        |
| **Fixtures and ladders on pages** | Shortcodes inside page text                                                                  | **"Ladder" and "Fixtures" blocks** in the page editor that pick up the current season automatically                                                           |
| **Bulk actions**                  | Postpone or cancel selected matches                                                          | **Postpone or cancel a whole night**, with a choice to push the season back a week                                                                            |
| **Import and export**             | CSV importers                                                                                | A one-time WordPress import, plus a CSV export                                                                                                                |
| **Roles**                         | Five roles                                                                                   | Owner/admin/editor. A "results entry" helper role could come later.                                                                                           |
| **Analytics**                     | None in SportsPress; Jetpack Stats and Site Kit provide it                                   | See section 4                                                                                                                                                 |

### Later or optional

- Team logos, colours and descriptions.
- A head-to-head results grid.
- A referee name on TVSL matches.
- A countdown to the next match.

### Skip: Tempe doesn't use these

- Players, player lists and player statistics. The site has zero player records.
- Staff and the officials directory.
- The formula builder, sport presets, the setup wizard and sample data.
- Text relabelling, colour schemes, custom CSS and module toggles.
- Paid add-ons: tournament brackets, Sponsors, Scoreboard, Timelines and Branding.

Player records will exist, but they come from **registration and payments** (names, parents, VNSW numbers, session packs), not from SportsPress-style player profiles.

## 4. Analytics in the rebuild

| Piece                                                                 | Plan                                                                                                                                                                                                                                               | Cost        |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **Google Analytics 4**                                                | **Keep the same tag (`GT-PLFFMCMT`)** so years of visitor history carry on unbroken                                                                                                                                                                | Free        |
| **Google Search Console**                                             | Keep the property, and verify it with a DNS record so it survives the move                                                                                                                                                                         | Free        |
| **Cloudflare Web Analytics**                                          | Add it: cookieless, with page views, visits, referrers, countries, devices, Core Web Vitals and 6 months of history                                                                                                                                | Free        |
| **Jetpack Stats**                                                     | Drop it. Its history can't be moved, and it may soon need a paid plan.                                                                                                                                                                             | Saves money |
| **Admin "Stats" page** (replaces the Site Kit and Jetpack dashboards) | A daily scheduled job pulls GA4, Search Console and Cloudflare data into our database. The page reads from there, so it loads fast and stays within the free limits. It shows visitors, top pages, traffic sources, search queries and site speed. | Free        |
| **Business numbers on the same page**                                 | Our own data: sign-ups, payments and revenue, session-pack balances, attendance per session, and who still owes money                                                                                                                              | Built in    |
| **Optional**                                                          | View counts beside each page in the admin page list, like Jetpack's Stats column, and a weekly summary email                                                                                                                                       | Free        |

The business numbers are likely what Michael will use most. They answer the spreadsheet question, "who's paid and who's running out of sessions", which none of the current tools can.

## 5. Where we can beat the current setup

1. **Duty, byes and finals placeholders as real fields,** not typed into match titles.
2. **Results for a whole match day on one screen.**
3. **Automatic "Week X of Y" and "Updated" lines** on ladders.
4. **Season rollover in one click.**
5. **Draft vs published results,** so a half-entered night never shows on the ladder.
6. **One stats page covering site traffic and the program's money and attendance,** instead of two separate plugin dashboards.

## Sources

- Jetpack: [Jetpack Stats support](https://jetpack.com/support/jetpack-stats/), [Stats: free or paid](https://www.jetpack.com/support/jetpack-stats/free-or-paid), [Changes for commercial sites](https://jetpack.com/blog/changes-to-jetpack-stats-for-commercial-sites/)
- Site Kit: [Site Kit by Google plugin page](https://wordpress.org/plugins/google-site-kit/)
- Cloudflare Web Analytics: [Dimensions](https://developers.cloudflare.com/web-analytics/data-metrics/dimensions/), [High-level metrics](https://developers.cloudflare.com/web-analytics/data-metrics/high-level-metrics/), [FAQ](https://developers.cloudflare.com/web-analytics/faq/)
- SportsPress: [WordPress.org plugin page](https://wordpress.org/plugins/sportspress/), [admin source on GitHub](https://github.com/ThemeBoy/SportsPress/tree/master/includes/admin), [meta boxes](https://github.com/ThemeBoy/SportsPress/tree/master/includes/admin/post-types/meta-boxes), [importers](https://github.com/ThemeBoy/SportsPress/tree/master/includes/admin/importers)
- ThemeBoy docs: [Configure screen](https://docs.themeboy.com/en/articles/14788091-the-configure-screen), [Event settings](https://docs.themeboy.com/en/articles/14788276-event-settings), [General settings](https://docs.themeboy.com/en/articles/14788272-general-settings), [Entering results](https://docs.themeboy.com/en/articles/14788134-entering-results), [Roles](https://support.themeboy.com/article/86-what-do-the-different-roles-in-sportspress-do)
