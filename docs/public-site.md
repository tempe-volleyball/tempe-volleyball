# Public site (Phase 7)

How the public pages are built, and the decisions behind them. PLAN.md links here for Phase 7; the admin side is in
[admin.md](admin.md). Each decision takes the more robust or more configurable option.

## SEO

### Indexing

Only production on `www.tempevb.com` may be indexed (`src/lib/indexing.ts`). Everywhere else (staging, previews,
local, production on `*.workers.dev`) every public response carries `X-Robots-Tag: noindex, nofollow` and
`robots.txt` disallows everything. On production www, `robots.txt` allows everything except `/admin` and `/api/` and
names `https://www.tempevb.com/sitemap.xml`. Canonical URLs, sitemap URLs, Open Graph URLs and JSON-LD ids are always
on `https://www.tempevb.com` (`site` in `astro.config.mjs`), whatever host served the page.

A page or post can also be hidden on its own: **Hide from search engines** (Admin → Pages / News → Search and
sharing; `pages.noindex`, `posts.noindex`) adds `<meta name="robots" content="noindex, follow">` and leaves it out of
the sitemap and site search. `/enrol/confirm`, `/enrol/offer` and `/search` are always noindex.

### The head (`src/components/Seo.astro`)

`BaseLayout` renders `<Seo>` in `<head>`; pages pass `title`, `description`, `canonicalPath` and an optional `seo`
object (`imageIds`, `jsonLd`, `noindex`, `article`). It writes `<title>`, the meta description, the canonical link,
Open Graph (`og:type`, `og:title`, `og:description`, `og:url`, `og:image` with size and alt when known,
`article:*` for posts), the Twitter card (`summary_large_image`), the Search Console verification meta (production
www only, from Settings → Analytics) and one JSON-LD `@graph`.

What each page ends up with, most specific first (generated text always loses to a hand-written field):

| Page                      | `<title>`                                                                         | Description                                                       | Sharing image                |
| ------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------- |
| Content page, home        | Search title, else the title (shouting titles title-cased), `\| Tempe Volleyball` | Meta description, else the body's text                            | Page's social image          |
| News post                 | Search title, else the title                                                      | Search description, else the excerpt, else the body's text        | Cover image                  |
| Programme page (any kind) | SEO title, else the name (leagues: "… Ladder, Fixtures and Results")              | SEO description, else the summary line + "next starts", else body | Programme image              |
| Category page             | SEO title, else the name                                                          | SEO description, else the intro, else the list of programmes      | Category's social image      |
| Season page               | "TNL Q3 2026 Ladder, Fixtures and Results"                                        | Generated                                                         | The league's programme image |
| Kind index, `/enrol`      | The intro page's title, else the default                                          | The intro page's description or text, else generated              | Default                      |

Anything left over uses **Settings → Search and sharing** (the `seo` site setting): a default description, a default
social image, the club's other name ("Tempe VB"), the year founded and extra profile links. With nothing set there, the
built-in description (`DEFAULT_DESCRIPTION`) and image apply.

### Social images

- **The default** is `public/images/og-default.jpg`, 1200 × 630 (the crop Facebook, LinkedIn, WhatsApp and X use),
  made once from the hero photo and the logo by `scripts/seo/og-image.ts`. Static, so it costs no Worker request.
- **Uploaded images** are linked as `/media/<id>/social`: the route picks the stored variant at least 1200 px wide
  (else the largest; else a web-image original) with one indexed D1 lookup, and serves it with the usual year-long
  immutable caching. Pages don't need the media row to build the tag, so no page render reads the media table.
- **Decision: no generated per-page images.** Rendering text onto images needs a rasteriser (Satori + resvg is about
  1 MB of WASM and well over 10 ms of CPU per image) or a build step per page, and pages change at runtime. A good
  default plus a per-page, per-post, per-programme and per-category image (all editable) covers the need for free.

### Structured data (JSON-LD, `src/lib/seo/`)

Every page's `@graph` has the `WebSite` and the club as a `SportsOrganization` (`@id`
`https://www.tempevb.com/#organization`): name, other name, logo, description, slogan, sport, founding year, email,
phone (international form) and a `ContactPoint` from Settings → Contact, the venues as `Place`s with a
`PostalAddress` (split from addresses typed like "Holbeach Ave, Tempe NSW 2044"), and `sameAs` from Instagram,
Facebook and the extra profiles. Other nodes point at it by `@id`.

| Page                            | Adds                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| League page                     | The current season as a `SportsEvent` (first to last night that isn't cancelled, first session time, venue, an `Offer` in AUD while that season takes entries) |
| Season page                     | That season as a `SportsEvent`                                                                                                                                 |
| Training page                   | Up to 12 upcoming sessions as `Event`s (times, venue, status, `Offer` with the session's price and availability)                                               |
| Development page                | Up to 12 upcoming terms as `Event`s (start and end dates, age group as `typicalAgeRange`)                                                                      |
| Event programme page            | Up to 12 upcoming dates as `SportsEvent`s                                                                                                                      |
| News post                       | `NewsArticle` (headline ≤ 110 characters, dates, image, publisher) and a `BreadcrumbList` (Home › News › post)                                                 |
| Pages with a visible breadcrumb | `BreadcrumbList` matching it (written by `Breadcrumbs.astro` itself, so the two can't drift)                                                                   |

Decisions:

- **Statuses are real:** postponed → `EventPostponed`, cancelled → `EventCancelled`, moved (a session's
  `original_date`, an event's `original_start_date`) → `EventRescheduled` with `previousStartDate`.
- **Times carry Sydney's offset on that date** (`sydneyIso()` in `src/lib/time.ts`: `+11:00` in summer, `+10:00` in
  winter), never UTC or the Worker's zone.
- **No location, no event.** Google requires an event's location; a season or date with no venue (its own or the
  programme's) is left out rather than shipped as an error in Search Console.
- **Safe to embed:** `jsonLdText()` escapes `<`, `>`, `&`, U+2028 and U+2029, so a title containing `</script>` can't
  break out of the script element (tested).

### Sitemap (`/sitemap.xml`)

Real, indexable pages only, with `lastmod`: the home page; published content pages that aren't hidden (intro pages
at `/enrol`, `/training` … are listed once, as the route); categories that aren't drafts; active programmes, plus
retired ones that still have history (a public season, or past dates); `/leagues`, `/leagues/fixtures`, the kind
indexes that list something; `/enrol`; `/news` and every post that isn't hidden; and every public season page except
each league's current one (its canonical URL is the league page). `lastmod` is the newest change: a league's includes
its seasons' saves and results publishes.

- One D1 batch of five column-only queries (`src/server/sitemap.ts`), whatever the size of the site; the rules are
  pure (`src/lib/seo/sitemap.ts`) and tested.
- Edge-cached like pages and purged with `site`, `news` and `programmes`, so publishing a page, post, programme,
  category or season refreshes it (hiding a page purges `site` too).
- Past 50,000 URLs it becomes a sitemap index of `/sitemap-<n>.xml` parts automatically (`sitemap-[part].xml.ts`).
- Imported rows' `lastmod` is the import time (the importer touches `updated_at`); after the Phase 8 import that's the
  launch date, which is honest enough, and every later edit moves it.

### Headings and links

- **One H1 per page** (the page title); body H1s become H2s and heading levels never skip (`fixHeadings()`,
  `src/lib/content.ts`). Checked on every sitemap page by `scripts/seo/check.ts` (below).
- **Internal links (QA low: trailing-slash links).** Imported bodies link to `/contact/`, `/where-we-play/` … which
  each cost a 301. Fixed in both places:
  - **at render time** for already-imported bodies (staging today): `tidyInternalLinks()` in `prepareHtml()` drops the
    trailing slash of every root-relative link (query and `#fragment` kept; `/`, `/api`, `/media` … left alone). Pure
    string work, edge-cached, and it also covers links typed by hand later. (PR #37 also added the guarded
    `scripts/fix-imported-links.ts` for staging's stored HTML; the render-time tidy doesn't depend on it.)
  - **in the importer** (`scripts/wp/content.ts`): the same tidy (alongside #37's `stripTrailingSlashes`), plus links to old URLs that now redirect point
    straight at the redirect's target (`/ladders/` → `/leagues/tnl#ladder`; the link's own `#fragment` wins), so a
    fresh import (production, Phase 8) has no hops at all. Links to pages that are still published stay as they are.

### 404 and search

- Unknown URLs that aren't in the redirects table get a real **404 status** with a page that has a search box
  (pre-filled with the words of the address), "Were you looking for…" links (pages, programmes, categories and menu
  items whose address or title shares words with it, near-miss spellings included; no extra queries) and the main
  links.
- **`/search?q=`** searches published pages, programmes, categories and posts that aren't hidden: every word must
  appear in the title or text; title matches rank first; at most 30 results. One D1 batch of four queries reading at
  most 2,000 characters of each body for the snippet. The query string is canonicalised by the middleware (`q` only,
  trimmed, ≤ 80 characters), so each search has one edge-cached URL. Results pages are noindex.
- Decision: our own search rather than a Google site-search link, because it works before (and regardless of)
  Google indexing the site and keeps visitors on the site.

### Checking a build

```sh
npm run db:migrate:local && npm run import:wp -- --skip-media && npx tsx scripts/content/apply.ts --local --apply
npm run build && npx wrangler dev --port 8787
npx tsx scripts/seo/check.ts --base http://127.0.0.1:8787 --old-urls   # every sitemap page + old URLs
SEO_BASE_URL=http://127.0.0.1:8787 npx vitest run scripts/seo          # the same as a test
```

`check.ts` fetches the sitemap and checks every page: 200, one H1, no skipped heading levels, a title, a description
of 50+ characters, the canonical equal to the sitemap URL, Open Graph and Twitter tags, and JSON-LD that parses with a
`SportsOrganization`; plus a 404 for an unknown path. `--old-urls` checks every old URL pattern in PLAN.md
("Old URL patterns to redirect", filled with every team, table, event and calendar slug in the importer's cache) and
every old page and post link: each must be **one 301 to a page that answers 200**. The test does the same and is
skipped in CI (no `SEO_BASE_URL`).

**Lighthouse with indexing on**, without touching production code: run the built Worker with
`--var SITE_ENV:production` and point Chrome at it as `www.tempevb.com` with
`--host-resolver-rules="MAP www.tempevb.com 127.0.0.1:<port>"` (launch Chrome with `--remote-debugging-port`, then
`lighthouse http://www.tempevb.com/<path> --port=<debug port>`).

Results (2026-10-19, local build with imported data and the content map; programmes switched to active locally with
sample sessions, a term and an event): **SEO 100 and accessibility 100** on `/`, `/where-we-play`, `/contact`,
`/mixed-leagues`, `/leagues`, `/leagues/tnl`, `/leagues/tnl/tnl-q3-2026`, `/leagues/fixtures`, `/training`,
`/training/scrim-and-coached-training`, `/programs/junior-development-program-jdp`, `/events/tempe-cup`, `/enrol`,
`/news` and `/news/tempe-cup-is-back`. `/search` scores 69 only because it's deliberately noindex; the 404 page can't
be scored (Lighthouse refuses non-200 pages). `check.ts`: all 72 sitemap pages (plus `/search`, `/enrol/confirm`, `/enrol/offer`) pass, and all 689 old URLs
(every event, team, table and calendar link in the cache, every PLAN.md page slug, and every old page and post) are
one 301 to a 200.

### At the cutover (Phase 8): Search Console

For Michael or Jeremy, once `www.tempevb.com` serves the new Worker:

1. **Verify** the Search Console property by DNS TXT (the domain property `sc-domain:tempevb.com` survives the move).
   The `google-site-verification` meta (Settings → Analytics) is a fallback; it only renders on production www.
2. **Submit the sitemap**: Search Console → Sitemaps → `https://www.tempevb.com/sitemap.xml`. Remove any old WordPress
   sitemaps listed there (such as `/wp-sitemap.xml` or a Jetpack or Site Kit one).
3. **Check redirects** before and after the switch: run `npx tsx scripts/seo/check.ts --base https://www.tempevb.com
--old-urls` (read-only GETs) and fix any failure with a redirect in the admin. Then watch Search Console →
   Pages → "Not found (404)" and "Page with redirect" for a few weeks; every 404 there that had traffic deserves a
   manual redirect.
4. **URL Inspection** on the home page, a league page and a post: "Page is indexable", the canonical is the
   www URL, and the structured data (Organization, Event, Article, Breadcrumbs) is detected without errors.
5. Settings → Analytics → Search Console property, so Admin → Stats shows Google searches (docs/admin.md §2).

## Design

The public pages' design system: tokens, components and the decisions behind them.

**Who it's for.** Players checking tonight's fixtures, court and duty, and the ladder, mostly on a phone at the
venue; and newcomers deciding whether to join. So: the fixtures and ladder are one tap from every page, they read on
a 390 px phone without zooming, and every page makes the next step (Enrol, Fixtures, Calendar) obvious.

**What stays from the old site.** The club blue `#104293` and amber `#FFA800`, the hero photo of players at the net,
the logo with the Sydney Uni Volleyball Club badge, the blue nav block over the photo, the amber rule under the
header, blue tables with amber captions, the amber copyright bar. What changed: cooler, lighter greys, rounded white
cards, sentence-case navigation, a shorter amber bar under each H1 instead of a full-width rule, and a lot more
space.

### Tokens

`src/styles/tokens.css` (shared with the admin, so editor previews match the site). Tailwind exposes each as a
utility (`bg-brand`, `text-muted`, `border-line` …).

| Token                   | Value                 | Use                                                                                   |
| ----------------------- | --------------------- | ------------------------------------------------------------------------------------- |
| `brand`                 | `#104293`             | nav, buttons, table bodies                                                            |
| `brand-dark`            | `#0b3170`             | hover on brand; table header rows (`header-row`, was the old grey `#555`)             |
| `brand-deep`            | `#071d44`             | footer (`footer`, was `#111`), hero overlay                                           |
| `brand-tint`            | `#e6ecf6`             | night rows in fixtures, info badges, selected choices in forms                        |
| `brand-text`            | `#e8eef8`             | text on brand blue (AAA)                                                              |
| `brand-soft`            | `#87a0c9`             | borders only: the old muted table numbers failed contrast (Lighthouse baseline)       |
| `accent`                | `#ffa800`             | the main action (Enrol), table captions, the header rule, the H1 bar, the active item |
| `accent-dark`           | `#e69500`             | hover on accent                                                                       |
| `accent-tint` / `-ink`  | `#fff3d9` / `#6b4400` | "Enrolling now" badges, notices                                                       |
| `ink`                   | `#1b2330`             | body text (dark text always on amber)                                                 |
| `muted`                 | `#4a5568`             | secondary text, 7:1 on white                                                          |
| `paper`                 | `#f2f4f8`             | page background (was `#e4e4e4`)                                                       |
| `line`                  | `#d5dce7`             | card borders and rules                                                                |
| `link`                  | `#0d3a85`             | text links: blue with a 2 px amber underline (amber text fails contrast on light)     |
| `danger`, `ok` (+ tint) | `#9b1c1c`, `#146c2e`  | form errors, full sessions; success panels, spots left                                |
| fonts                   | Lato 700, Noto Sans   | Lato for headings, nav, buttons; Noto Sans (Droid Sans's successor) for text          |

Type scale: H1 `clamp(2rem … 3rem)`, section H2 `clamp(1.5rem … 1.875rem)`, card titles 1.25–1.5rem, body 1rem at
1.7 line height, tables 0.875rem, labels and meta 0.8125rem. Body text is capped at 70ch.

### Components

All in `src/styles/site.css` (in Tailwind's components layer, so a utility on the same element always wins), used by
the Astro components in `src/components/`.

| Class                                                      | What                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `.page-title`, `.section-title`, `.page-lead`              | H1 with the amber bar, H2, the intro paragraph under an H1                                                                      |
| `.btn` + `.btn-enrol` / `-brand` / `-outline` / `-light`   | 44 px buttons: amber for Enrol (the main action), blue for Fixtures and the next step, outline for the rest, light on the photo |
| `.link`                                                    | a text link on a light background                                                                                               |
| `.badge` + `-open` / `-closed` / `-info` / `-full` / `-ok` | enrolment state, season, waitlist, spots; `-moved`, `-off`, `-bye` inside tables                                                |
| `.card`, `.empty`, `.notice`                               | white card; dashed empty state (what's missing and where to go instead); amber notice strip (retired, finished)                 |
| `.meter`                                                   | spots-left bar: blue, amber at 20% or fewer left, red when none; always beside the words, `aria-hidden`                         |
| `.crumbs`                                                  | breadcrumbs (`Breadcrumbs.astro`) on league, programme, category, index, enrol and news pages                                   |
| `.facts`                                                   | When / Where / Next start under a programme's title                                                                             |
| `.tabs`                                                    | the league page's Fixtures / Ladder / Results segmented control (sections stack without JavaScript)                             |
| `.data-table`                                              | the blue tables; `.fixtures-table` and `.ladder-table` from `src/lib/tables.ts`                                                 |
| `.prose`                                                   | stored page and post bodies, imported WordPress HTML included                                                                   |

### Header

`SiteHeader.astro`. The hero photo (`<picture>`, AVIF then WebP, 640–1500 px wide, `fetchpriority="high"`, preloaded
in the head) with a blue gradient for legibility; the logo on the left; the blue nav block top right with the social
icons beside it; a 4 px amber rule underneath. On phones (under 1024 px) a blue bar sits above the photo with the
site name, the social icons and an amber **Menu** button; the menu opens as a panel under the bar.

- The menu and its dropdowns are `<details>`, so they work without JavaScript. The small inline script keeps the menu
  open on wide screens, closes dropdowns on an outside click or Escape, and closes the phone menu on an outside tap
  or Escape (focus goes back to the button).
- Inner pages use a short hero (128 px phone, 240 px desktop) so the content starts high on a phone; the home page
  gets the tall one with the H1.

### Home page

The hero says what Tempe Volleyball is and how to join: **Settings → Home page** (`home`): heading, intro, two
buttons (amber and outline; empty text and link hide one) and a switch for "Leagues this season". Defaults:
"Social volleyball in Sydney's inner west", a line on the leagues, programs and venues, **no buttons** and
"Leagues this season" **off** (2026-10-20; both can be turned back on there).

- The hero heading is the page's only H1. An empty heading uses the home page's title (Pages → Home). The home
  page's own title then heads its body as an H2 (unless it's the same text), and the body's headings shift down a
  level, so heading order holds.
- **Calendar** (`HomeCalendar.astro`, in the sidebar above the ladders; after them on phones): the old site's month
  grid in its colours (blue month bar, grey day names, amber days, today white), weeks starting Monday. Every game
  night of every published or archived season is in the page (dates and league codes, a few KB), so the arrows
  switch months instantly with no requests; without JavaScript it shows this month. A game night is a link to
  `/leagues/fixtures?date=YYYY-MM-DD` (that night's games across leagues, past seasons included) with "TNL, FNL ·
  7 games" as its title; a night that's off is struck through with the reason; weeks off and drafts don't show.
- **Leagues this season:** (off by default) a card per league with a current season (night, suburb, Fixtures and Ladder buttons),
  plus a link to this week's games in every league. It's generated, so a new league appears by itself.

### Ladders: where the widgets go (QA "sidebar and footer ladders")

The old layout showed the same five ladder widgets twice on content pages: in the right sidebar and again in the
footer. **Settings → Ladders** (`ladders`) decides:

| `placement`         | Widgets                                                                      | Footer                      |
| ------------------- | ---------------------------------------------------------------------------- | --------------------------- |
| `sidebar` (default) | beside the content of the home page, content pages, news and the league list | "Ladders: TNL, FNL …" links |
| `footer`            | across the top of the footer on every page; no sidebar anywhere              | the widgets                 |
| `off`               | none (league pages always have their full ladder)                            | "Ladders: …" links          |

`rows` (1–12, default 4) is how many teams each widget shows. Widgets are compact (Pos to L) in the old site's
colours: an amber bar with the league name and "Week 4 of 9", the grey header row, alternating blue rows. They have
a fixed layout, so a long team name is cut with "…" (full name on hover) and the widget never scrolls. Under each:
"Full TNL ladder" on the left, "TNL fixtures" (the league page's Fixtures tab) on the right. Why the sidebar by default: it's where the old site's players
look, and on a phone it stacks after the page's content rather than before it.

### Tables

`src/lib/tables.ts` renders both tables as HTML for the league pages (`FixturesTable.astro`, `LadderTable.astro`)
and the page-editor data blocks (`src/lib/content/data-blocks.ts`), so a Fixtures block looks exactly like the league
page.

**Fixtures** are grouped by night: each night is a `<tbody>` headed by a light row with the date, "Match day 5" and,
when the whole night moved, a **Moved from 15/10/2026** badge. Columns: Time (8pm), Match (teams in capitals, a quiet
"vs", referee and a per-game "Moved from" badge), Result (score, sets, forfeit, Postponed/Cancelled/TBD badges and
notes), Court, Duty (none for TVSL). Byes get a "Bye" badge; weeks off one italic line.

- **Under 640 px each game is a small card:** time and court on top, the result on the right, the teams, then "Duty
  AIM BOT". Nothing scrolls sideways. Every element carries its table role explicitly, because browsers drop table
  semantics when `display` changes; the column headers stay for screen readers (visually hidden).
- **A legend** under the table explains Duty, the Moved badge and Postponed, only for what the table contains.
- The league page's **Results** tab reads newest night first; Fixtures soonest first.
- `/leagues/fixtures` heads each date itself, so its tables leave the date out of the night rows.

**Ladders**: Pos and Team first, then Pts, P, W, D, L, S+, S−, P+, P−, Ratio. Under 768 px a full ladder scrolls
sideways with Pos and Team sticky (a shadow marks the edge), a fade at the right edge that goes once you reach the
end (scroll-driven animation; it just stays where unsupported), and "Swipe the table for sets and points" under it.
The amber caption is visually hidden on phones (it would scroll away; the section heading names the table).

**Colours** (both tables): amber caption, the old site's grey header row (`--color-header-row`, #555), and blue rows
alternating with a lighter blue (`--color-brand-alt`); white text passes AA on all three.

**Team names link to their team pages** wherever a table shows a team (ladders, fixtures, results, duty, byes, the
page-editor blocks); finals placeholders ("Winner SF1") stay text. Renderers take a `teamHref` (`teamHrefFor()` in
`src/lib/teams.ts`).

### Team pages (`/teams/<slug>`)

One page per team across leagues (`src/pages/teams/[slug].astro`, `src/server/competition/team-page.ts`): the
leagues it's in this season; for each, its ladder position ("6th of 9 · 6 pts"), its fixtures and results (games,
duties, byes, nights off; the league page's tables); then its past seasons with the
final position, each linking to that season's page. Generated only; nothing to edit. Player names never show
(rosters are admin-only).

- **Which teams:** any team in a published or archived season. A team only in a draft season gets a 404, so next
  season's line-up isn't public early.
- **Renaming** moves the slug to the new name (`renameTeam`, src/server/competition/teams.ts): the old page and
  feeds 301 to the new ones, and redirects that pointed at the old page are re-pointed (no chains). A new team may
  take a freed slug; its page and feeds then stop redirecting. **Merging** 301s the merged team's page to the kept
  team's (undo puts it back). Old WordPress `/team/<slug>/` links go to the team they were imported from.
- In the sitemap and site search ("Team"); Admin → Teams has a "View page" link. Purged with the site (`site`
  tag) on results and team changes.

### Cards and programme pages

- **Programme cards** (`ProgrammeCards.astro`: category pages, `/enrol`, `/training`, `/programs`, `/events`): the
  enrolment badge, name, summary line, the "Next season starts …" sentence, when and where under a hand-written
  summary, then the open seasons, sessions or terms with spots left and a meter (`spotsMeter()` in
  `src/server/programmes/public.ts`: team places when teams are capped, else players; "Full" or "Waitlist only" as
  badges). Actions: **Enrol** (while open), **Fixtures** (leagues), **Details**.
- **Programme pages** (`ProgrammeIntro.astro`): badges (season, enrolment), the When / Where / Next start facts, Enrol
  now, More info, the description. Training sessions, terms and event dates are a list of rows (date, times, venue
  when it differs, notes, Postponed/Cancelled and spots badges), not a blue table: they're few, and a list reads
  better on a phone.
- **Enrol section and form**: the form sits in a card. 44 px fields with a blue focus ring; choices (session, team or
  individual, radio groups) are tiles that turn blue when picked; errors are red with an icon under each field, plus
  a summary ("3 answers need fixing") at the submit button; success is a green panel that takes focus, with the
  reference in large type. Closed enrolment is an empty state linking to `/enrol`.
- **Category pages** end with links to `/enrol` and the index page of each kind they list (All leagues, All
  training, All development programs, All events), and the footer links them too, so `/news`, `/training`,
  `/programs` and `/events` are reachable from every page (QA: they weren't linked).

### Joining: interest programmes and `/interest`

Leagues and events take expressions of interest by default (docs/interest.md, docs/api/interest.md); training and
development keep enrolment exactly as above. A programme's mode is `leagues.signup_mode` (null = the kind's default).

- **Join section** (`JoinSection.astro`, in place of the enrol section on league and event pages, only while the
  programme takes EOIs): "Join <name>"; then the programme's own text (`leagues.interest_text`, shown alone, as
  typed) or else "Next season starts …." when a next start is known (the usual `nextStartsLine`; nothing about dates
  otherwise) and a line on joining alone or as a team; and an amber **Register your interest** button to
  `/interest/<slug>`. It **never says closed**. It keeps `id="enrol"` (old `#enrol` links land on it) inside a
  `#join` wrapper. With EOIs off (`interest_open`) there's no section, badge or button at all.
- **Programme intro and cards**: no enrolment badge for interest programmes; "Taking sign-ups" (the open badge) while
  they take EOIs, and **Register interest** instead of Enrol now / Enrol, linking `/interest/<slug>`.
- **`/enrol`** lists "Leagues and events: register your interest" (each with a Register interest button, and a link
  to the general form) above what's open for enrolment; "Not open yet" lists the rest. The default lead mentions
  both; an intro page at `/enrol` still replaces it.
- **Programme list block** filter "enrolment open / closed" means **taking sign-ups**: an interest programme counts
  as open while it takes EOIs (they aren't time-windowed), an enrolment programme while its enrolment is open. Lines
  carry `interest: true` for interest programmes.
- **`/interest` and `/interest/<slug>`** (`InterestPage.astro` + the `InterestForm` island, `client:visible`, disabled
  until hydrated like the enrolment form): the H1 ("Register your interest", an intro page's title, or "Join <name>"),
  Settings → Interest's intro, then the form in a card: **How are you joining?** ("Just me: find me a team" / "A whole
  team", tiles), **What are you interested in?** (tick boxes by category with the summary line, next start and the
  deposit for the entry type), then, once the entry type is picked, the team name, the contact's (captain's) details,
  the form's questions (the enrolment form's `Question` component), **Team members** (optional, "+ Add a team
  member" up to the limit, each removable, fields per Settings → Interest), the deposit and PayID note, Turnstile and
  the privacy line. Errors are under each field (team members' too) with a summary at the button, and focus goes to
  the first one. Success is a green panel with the thank-you text and the deposit instructions without the
  reference (it's in the email). A `noscript` line points to Contact.

### Footer

`SiteFooter.astro`, on `brand-deep`: the logo and a line about the club, **Explore** links, **Contact us** (Settings →
Contact and Social), **Where we play** (Admin → Venues, each with a Map link), then the amber copyright bar.
**Settings → Footer** (`footer`) holds the line and the links (up to 16; reorder, rename, remove, add). Defaults:
Leagues, This week's games, Enrol, Training, Programs, Events, News, Where we play, Rules, FAQ, Contact.

### Content pages (imported bodies)

`.prose` makes old WordPress pages look decent without editing them: 70ch text, real list markers in brand blue,
spacing after headings, rounded images, captions in `muted`, 16:9 embeds unless the iframe sets a height, white ruled
tables that scroll sideways on phones, WordPress columns that stack on phones, and buttons styled as `.btn-brand`.
The pages' words themselves are content work (the content map, docs/content-map.md).

### Accessibility

Kept at Lighthouse 100 on every page type (the baseline's failures were `button-name`, `color-contrast`,
`heading-order` and `link-text`):

- Every text colour pair is at least 4.5:1 (`brand-soft` text is gone; numbers on blue use `brand-text` or white).
- One H1 per page, headings in order (the home page body shifts down a level under its H2).
- The Menu button has a visible label; icon links (Instagram, Facebook, home logo) have names; "Map", "Fixtures",
  "Enrol" and "Details" links carry hidden context ("Map of MLC School", "Enrol in Thursday Night League").
- A visible focus ring everywhere: 3 px blue on light, amber on blue and dark (`.on-dark`, inside tables).
- `prefers-reduced-motion` turns off transitions and the scroll fade.
- Touch targets are at least 40–44 px (buttons, tabs, menu items, form fields and choice tiles).

### Performance

- **No render-blocking CSS.** The public stylesheet (`src/styles/global.css`) only scans public code (Tailwind
  `source(none)` + `@source` for components, layouts, pages and lib; not the admin or API), about 45 KB raw / 10 KB
  gzipped, and is inlined into each page (`astro.config.mjs`: `inlineStylesheets: 'auto'` with a 64 KB limit for
  CSS only). The edge-cached HTML then needs no second request before it paints. The admin has its own entry,
  `src/styles/admin.css` (Tailwind over everything, ~74 KB), which stays a cached file.
- **Images:** AVIF and WebP at fixed widths (hero 640/960/1280/1500, logo 160/240/320/480), with width and height so
  nothing shifts. `npx tsx scripts/brand-images.ts` regenerates them from `scripts/brand/` (the old site's
  originals; the hero is 1500 px, so nothing is upscaled). The old `hero-800.webp`, `logo-200/400.webp` stay in
  `public/images` for anything that still links them.
- **Fonts:** self-hosted woff2 with metric-matched fallbacks; Lato 700 and Noto Sans 400 and 700 are preloaded (the
  bold body face was the last layout shift: 0.10 CLS on programme pages before it was preloaded).
- No JavaScript on public pages except the menu and tab scripts (about 1 KB each, inline) and the enrolment island,
  which hydrates when it scrolls into view.

**Lighthouse (mobile, default throttling), 2026-10-19, local built Worker (`wrangler dev`) with the imported data,
the content map and test programmes:** performance 100 (97–100 before the font preload), accessibility 100, best
practices 100 on `/`, `/leagues`, `/leagues/tnl`, `/leagues/tvsl`, an archived season, `/leagues/fixtures`,
`/mixed-leagues`, `/enrol`, `/training`, `/programs`, a training, development and event page, `/news`,
`/where-we-play`, `/rules`, `/faq` and `/contact` (with the new contact form); CLS 0–0.003, LCP 1.4–1.7 s. The
one exception locally is a news post whose image is still on the old site (local import with `--skip-media`, LCP
3.7 s, performance 90); staging serves it from R2. SEO shows 69 only because non-production pages are `noindex`.

### Decisions (each the more robust or more configurable option)

- **Ladder widgets are a setting** (sidebar by default, footer or off), and they're never shown twice on a page.
- **The home page's first line is a setting** (heading, intro, buttons), falling back to the home page's title.
- **The footer links are a setting**, with the kind index pages and News in the defaults.
- **"Program" on the public site.** Australian usage, the club's own names (Junior Development Program) and the
  `/programs` URL agree; the public copy that said "programme" now says "program" (QA info e). The admin and the code
  keep "programme".
- **Fixtures by night** with the date in a heading row, and stacked cards on phones, instead of a seven-column table
  that scrolled sideways.
- **One table renderer** for league pages and page blocks (`src/lib/tables.ts`), tested in `src/lib/tables.test.ts`.
- **Inline CSS for the public site**, a separate admin stylesheet.
- **Sessions, terms and event dates as lists**, not blue tables.
