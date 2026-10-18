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
