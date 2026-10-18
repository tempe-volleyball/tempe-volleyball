# Content map (Phase 6, build step 5)

Where each of the 37 pages imported from the old WordPress site goes in the new structure ([admin.md §3.8](admin.md)),
and what's left for Michael to review. The drafted text is in `scripts/content/drafts.ts`; `scripts/content/apply.ts`
writes it as guarded SQL (`scripts/content/content-map.sql`, checked in).

Status as of 2026-10-18, on **staging only**. Production has no imported content yet; see [Production](#production).

## How the drafts are saved

Nothing published was overwritten. Everything new waits for Michael:

| What                                                                    | Where it's saved                                                                                                                                                   | How Michael reviews it                                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 6 new programmes (ADP, Scrim & Coached, Thursday casual, JDP, Rep, Cup) | **Draft** programmes, with descriptions. Hidden everywhere on the site.                                                                                            | Admin → Training / Development / Events → open it → edit → set it **Active**. Then add its sessions, terms or dates.                       |
| Tidied kept pages (Home, About, Where We Play, Contact, Rules, FAQ)     | A **revision** just behind the live version. The live page is unchanged.                                                                                           | Admin → Pages → open the page → Revisions → the second entry → **View** → **Restore this version** (restoring can be undone the same way). |
| `/enrol` intro                                                          | A new **draft** page at `/enrol`.                                                                                                                                  | Admin → Pages → Enrol → edit → Publish. Its text then shows above the generated list on `/enrol`.                                          |
| Category intros, the Super League description, league times             | Written straight into the empty fields (category intro, TVSL description, start and finish times). Live on staging, so they can be reviewed in place.              | Admin → Categories / Leagues → edit or clear.                                                                                              |
| Venue directions (Tempe, Burwood)                                       | Written into the empty Directions field. Shown by the **Venues** page block; the Where We Play page still holds the public copy until Michael swaps it in (below). | Admin → Venues.                                                                                                                            |
| 19 clearly stale pages                                                  | **Archived** (revisions kept, restorable), each with a 301 to a live page.                                                                                         | Admin → Pages (status Archived). Republishing one removes its redirect.                                                                    |
| 9 pages that move into programmes later                                 | Still **published**. Their 301s already exist and wait behind the page: they take effect the moment the page is archived or unpublished.                           | Make the programme active first, then archive the page.                                                                                    |

Every change is guarded: it only touched rows nobody has edited in the admin (`updated_by` null, no page revisions)
that still had the imported title or an empty field, so re-running the script changes nothing. Programme, category,
venue and archive changes are in the audit log (actor blank, `source: scripts/content (content map)`).

## The map

**Status** key: **Archived** = done, 301 live · **Draft** = drafted, waiting for review · **Waits** = stays published until its replacement is live (301 written, dormant) · **Decide** = Michael's call.

| Old URL                                                 | Old title                                                    | New home                                                                                                   | Status   | Notes                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                                                     | Welcome to Tempe Volleyball!                                 | Kept: home page. Proposed revision uses two **Programme list** blocks instead of typed-out days and times. | Draft    | Live version lists the **Monday league** (Five Dock, 6–8pm), which no longer exists, and links to `/2023-enrolment`.                               |
| `/about-tempe-vb`                                       | About Tempe VB                                               | Kept: About. Directions moved to Where We Play.                                                            | Draft    | Live version has an editor's note left in (“[These should be drop downs]”) and a duplicate copy of the directions.                                 |
| `/where-we-play`                                        | WHERE WE PLAY                                                | Kept: all three venues. Also copied into Admin → Venues → Directions.                                      | Draft    | Old text said “CityRail”; now the T4 line. Five Dock has no directions on the old site. “Burwood MLC **Aquatic Centre**”: is that the entrance?    |
| `/contact`                                              | CONTACT                                                      | Kept: email and phone, links to Enrol and Where We Play.                                                   | Draft    | The live page's embedded “contact form” is actually the **New Player** Google Form. Proposed version drops it.                                     |
| `/rules`                                                | RULES                                                        | Kept: league rules.                                                                                        | Draft    | Dropped “team fees increased after the Sep 2023 renovation”. Times are for 8–10pm nights: does SAL (3–5pm) follow the same pattern?                |
| `/faq`                                                  | FAQ                                                          | Kept: FAQ, links to the category pages and `/enrol`.                                                       | Draft    | Old answers linked `/new-player-2023` and said leagues run in Five Dock (only JDP does now).                                                       |
| `/saturday-night-endorsed-league`                       | TEMPE VOLLEYBALL SUPER LEAGUE (TVSL)/ SUNDAY NIGHT …         | TVSL league description (`/leagues/tvsl`) + Super League intro.                                            | Waits    | Dated details left out: 2026 season dates, close date 19/7, Promotion Day 3 Oct, the Google Form. Title says Saturday and Sunday: which?           |
| `/adult-development-program-adp`                        | Adult Development Program (ADP)                              | Programme **ADP** (development, Adult Training) → `/programs/adult-development-program-adp`.               | Waits    | Draft programme. Two venues, so the day and times are a hand-written label.                                                                        |
| `/adults-social-training`                               | SCRIM & COACHED TRAINING SESSIONS                            | Programme **Scrim & Coached Training** (training) → `/training/scrim-and-coached-training`.                | Waits    | The old page is only a Google Form. Day (Friday 8–10pm) comes from the 2022 scrimmage page: please check. ADP's page also points here to register. |
| `/friday-night-scrimmage`                               | Friday Night Scrimmage                                       | Merged into Scrim & Coached Training.                                                                      | Waits    | 2022: $10 per person per hour, PayID. Price not copied; set it on the programme or its sessions.                                                   |
| `/junior-development-program-jdp`                       | Junior Development Program (JDP)                             | Programme **JDP** (development, Juniors, ages 12–17) → `/programs/junior-development-program-jdp`.         | Waits    | Draft. Friday 8–10pm for juniors: still right?                                                                                                     |
| `/junior-development-program-jdp-volleyjoeys`           | Junior Development Program (JDP) \| VOLLEYJOEYS Training …   | Merged into JDP (the VolleyJoeys name is in its description).                                              | Waits    | The old page is only a Google Form; enrolment moves to the JDP page's form.                                                                        |
| `/tempe-cup-registration`                               | Tempe Cup Registration                                       | Programme **Tempe Cup** (event, under Mixed Leagues for now) → `/events/tempe-cup`.                        | Decide   | Draft. Old page is Autumn 2022 ($300 a team, $500/$100 prizes). Does it still run? Which category (or a new Events one)?                           |
| `/tempe-volleyball-usyd-junior-rep-team-program`        | Tempe Volleyball USyd Junior Rep Team Program                | Programme **Junior Rep Teams** (development, Juniors) → `/programs/junior-rep-teams`.                      | Decide   | Draft. Old page is 2023 (U16, JSVL, $550/$650). The home page now says “YSVL” rep teams: which league, ages and training night?                    |
| `/tempe-vb-usyd-junior-rep-team-program-eoi`            | Tempe VB USyd Junior Rep Team Program EOI                    | Merged into Junior Rep Teams (its enrolment form becomes the expression of interest).                      | Decide   | Empty: the form was embedded.                                                                                                                      |
| `/2023-enrolment`                                       | Enrolment                                                    | `/enrol` (draft intro page; the list is generated).                                                        | Waits    | In the menu as “Enrol”. Lists the **Monday league** and a **Saturday Junior League**. 301 to `/enrol` is written.                                  |
| `/new-player-2023`                                      | New Player 2026                                              | `/enrol` (each programme's own form).                                                                      | Waits    | Current Google Form; the FAQ and Contact pages link it.                                                                                            |
| `/new-team-group-2023`                                  | New Team Or Group Entry 2026                                 | `/enrol`.                                                                                                  | Waits    | Current Google Form.                                                                                                                               |
| `/2021-interest-in-playing`                             | 2022 Enrolment                                               | `/enrol`                                                                                                   | Archived | 2022 Monday league.                                                                                                                                |
| `/new-player`                                           | New Player                                                   | `/enrol`                                                                                                   | Archived | Empty (2020 form).                                                                                                                                 |
| `/new-team-group`                                       | New Team/Group                                               | `/enrol`                                                                                                   | Archived | Empty (2020 form).                                                                                                                                 |
| `/returning-player`                                     | Returning Player                                             | `/enrol`                                                                                                   | Archived | Only the membership note (now in `/enrol`).                                                                                                        |
| `/returning-team`                                       | Returning Team/Group                                         | `/enrol`                                                                                                   | Archived | Same.                                                                                                                                              |
| `/82-2`                                                 | ABOUT                                                        | `/about-tempe-vb`                                                                                          | Archived | 2020 dates, COVID disruptions, “best of 3 sets in 50 minutes”.                                                                                     |
| `/covid-guidelines-oct-21`                              | Tempe VB League Covid-19 Guidelines (October 2021)           | `/rules`                                                                                                   | Archived | Outdated.                                                                                                                                          |
| `/sample-page`                                          | Sample Page                                                  | `/`                                                                                                        | Archived | WordPress placeholder.                                                                                                                             |
| `/monday-evening-league-2021`                           | Monday Evening League 2021                                   | `/mixed-leagues`                                                                                           | Archived | The Monday league has ended.                                                                                                                       |
| `/thursday-evening-league-2021`                         | Thursday Evening Winter League 2021                          | `/leagues/tnl`                                                                                             | Archived |                                                                                                                                                    |
| `/juniors-tournament-25-june-2022`                      | Juniors Tournament 25 June 2022                              | `/juniors`                                                                                                 | Archived | Photos only (kept in the page's revision).                                                                                                         |
| `/juniors-tournament-29-october-2022`                   | Juniors Tournament 29 October 2022                           | `/juniors`                                                                                                 | Archived | Winners and photos. Could become a news post if wanted.                                                                                            |
| `/tempe-juniors-tournament`                             | Tempe Volleyball Juniors 1-day Tournament Spring 2022        | `/juniors`                                                                                                 | Archived | If junior tournaments return, make them an event programme.                                                                                        |
| `/juniors-development-sessions-wrap-up`                 | Juniors Development Sessions Wrap Up                         | `/juniors`                                                                                                 | Archived | “See you in 2023”.                                                                                                                                 |
| `/volley-joeys-friday-evening-training-2021`            | JUNIOR DEVELOPMENT PROGRAM (JDP) Volleyjoeys Training        | `/juniors`                                                                                                 | Archived | 2021; PayID how-to only.                                                                                                                           |
| `/volley-joeys-friday-night-junior-training-booking`    | Junior Development Program (JDP) Volleyjoeys Session Booking | `/juniors`                                                                                                 | Archived | 2021; PayID how-to only.                                                                                                                           |
| `/thursday-night-casual-training`                       | THURSDAY NIGHT CASUAL TRAINING                               | `/adult-training`; text in programme **Thursday Night Casual Training** (draft).                           | Archived | Nov–Dec 2020 dates, $15 cash, 40 a session (copied to the programme's price and cap). Clashes with TNL's night and venue: does it still run?       |
| `/thank-you-for-registering-your-team-in-the-tempe-cup` | Thank you for registering your team in the Tempe Cup         | `/enrol`                                                                                                   | Archived | Form thank-you page; enrolment now shows its own confirmation.                                                                                     |
| `/thank-you-for-your-interest`                          | Thanks for contacting us!                                    | `/contact`                                                                                                 | Archived | Form thank-you page.                                                                                                                               |

37 pages: 6 kept with a proposed revision, 19 archived, 9 waiting on a programme or `/enrol`, 3 for Michael to decide.

### Also written

- **Category intros** for Mixed Leagues, Super League, Juniors and Adult Training (were empty). They avoid naming days
  and venues, since the cards below them are generated.
- **League times**: TNL, FNL and SNL 8–10pm, SAL 3–5pm, TVSL 7–10pm (from the home and TVSL pages), so the generated
  summary lines read “Thursdays 8–10pm”.
- **Venue directions** for Robyn Webster and MLC (Admin → Venues). The public site doesn't show them yet.

## For Michael

Questions:

1. **Monday league (MNL, Five Dock 6–8pm):** the home and enrolment pages still list it. Has it finished? (No MNL league
   is in the data; the proposed home page leaves it out.)
2. **Saturday Junior League** (8–10pm, Tempe), listed on `/2023-enrolment`: does it still run? If so, add it as a league
   under Juniors.
3. **Tempe Cup:** still running? If so, review the draft event, pick its category and add the date(s).
4. **USyd Junior Rep Teams:** still running, and is it JSVL or YSVL now? Ages, training night and venue?
5. **Scrim & Coached Training vs ADP:** the ADP page sends people to the Scrim & Coached form. Are they one program, or
   two? Which night is Scrim & Coached?
6. **Thursday casual training:** still running (it was 2020, and Thursday 8–10pm at Tempe is TNL's slot)? If not,
   delete the draft programme.
7. **JDP:** Friday 8–10pm for 12–17 year olds still right? The 2023 page mentioned Active Kids vouchers (that NSW scheme
   has changed); left out.
8. **TVSL:** which night (the page title says both Saturday and Sunday; the data says Sunday)? Fees and dates go on the
   season and its enrolment.
9. **PayID** in the `/enrol` intro uses the number on the old scrimmage page (0414 911 544). Right for every program?
10. **Contact:** keep both email addresses? A contact form could come later (the old one was the New Player form).
11. **Rules:** match timings for the Sunday afternoon league; is “two sets” right for every social league (2020 said best
    of 3 in 50 minutes)?

Go-live steps on staging, after review (all in the admin):

1. Restore the proposed revision of each kept page (or edit it), then clear its **Meta description** so it's generated
   from the new text (the imported one quotes the old text).
2. Publish the `/enrol` draft. Edit the menu's **Enrol** item to link `/enrol` instead of the 2023 page, then archive
   `/2023-enrolment`, `/new-player-2023` and `/new-team-group-2023` (their 301s to `/enrol` are ready).
3. For each draft programme: check it, add its sessions, term or dates, open enrolment if wanted, set it **Active**.
   Then remove its pinned page link from the category's dropdown in Admin → Menu (the dropdown now lists the
   programme by itself) and archive the old page; its 301 is ready. For TVSL, archive
   `/saturday-night-endorsed-league` and remove “About the Super League” from the menu.
4. Delete any draft programme that doesn't run any more.

## Production

Nothing here has touched production, whose content isn't imported yet. In Phase 8, after the import:

- Michael will have reviewed and edited the text on staging, so the reviewed version (staging's rows) is what should go
  to production, not the drafts. The checked-in `scripts/content/content-map.sql` is the fallback and the record of
  the original drafts.
- To apply the drafts as they are: `npx wrangler d1 execute DB --env production --remote --file scripts/content/content-map.sql`
  (run by hand, once approved; `apply.ts` never targets production). It's guarded and idempotent like on staging.
- A re-import (`npm run import:wp`) no longer overwrites a page edited in the admin or changes any page's status, so
  archived pages stay archived.

## Where We Play from the venues table

`/where-we-play` is still hand-typed (the tidied revision above repeats each venue's address and directions). Since
2026-10-18 a **Venues** page block shows the same from Admin → Venues: name, address, a map link, the directions and
which programmes play there, and venue edits purge it. To generate the page, Michael opens Where We Play in Admin →
Pages, deletes the typed venue sections, inserts **+ Block… → Venues** (all venues, or chosen ones in his order) and
keeps any text around it. Check first that each venue's Directions field reads well on its own (Five Dock has none
yet). Nothing on staging was changed for this.
