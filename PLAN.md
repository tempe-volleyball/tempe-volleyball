# Tempe Volleyball: rebuild plan

Replace www.tempevb.com (WordPress 7.1.2 + SportsPress 2.7.31, "Premier" theme) with one Cloudflare Worker that serves the
public site, the admin at `/admin`, and the API at `/api`. It must cost $0 to run, apart from Stripe's per-payment fee and
the existing domain renewal.

Status (2026-10-18): Phases 1–3 are deployed to `https://tempe-volleyball-staging.tempevb.workers.dev` and
`https://tempe-volleyball-production.tempevb.workers.dev` (Cloudflare account `6a3ae071f30ac4126317d2920b7ce299`); staging
holds the imported WordPress data. Phase 4's library, API and admin screens (/admin/seasons) are in; next is Michael setting up real seasons. **Payments are parked** (see
Phase 5).

## Contents

1. [Architecture](#architecture)
2. [Data model](#data-model)
3. [Phases](#phases)
4. [Open questions](#open-questions)
5. [Setup needed from Jeremy](#setup-needed-from-jeremy)
6. [Reference: the current site](#reference-the-current-site)

---

## Architecture

### Framework choice: Astro (not React Router v7)

I stayed with **Astro 7 + `@astrojs/cloudflare` 14**. React Router v7 on Workers would work too, but it isn't clearly better
here:

- Most of the site is content pages and tables that need no JavaScript. Astro sends none by default; RR7 hydrates every
  page.
- Astro 7 has route caching built in, with a Cloudflare provider that tags responses and purges by tag
  (`cache.purge({ tags })`). That is exactly "cache public pages at the edge, purge when the admin publishes".
- The admin is one big React island (or a few), so the demo's components carry over with little change either way.

The one thing RR7 does better is a single router across the whole admin. A client-side router inside the admin island
covers that.

### Request flow

```
                       ┌───────────────────────── Cloudflare (free) ───────────────────────────┐
 browser ─► www.tempevb.com ─► static assets (dist/client: CSS, JS, fonts, icons)  ◄── free, unmetered
                       │        └─ miss ─► Worker "tempe-volleyball-production"
                       │                    ├─ public pages  (Astro SSR + edge route cache, purged on publish)
                       │                    ├─ /admin/*      (Astro shell + React islands, no cache, auth required)
                       │                    ├─ /api/*        (JSON: admin mutations, forms, Stripe webhook, health)
                       │                    └─ scheduled()   (hourly cron: expiries, email queue)
                       │                         │        │         │
                       │                        D1       R2      Workers Logs
                       │                     (tempevb-  (media)
                       │                      production)
                       └────────────────────────────────────────────────────────────────────────┘
   external: Stripe Checkout + webhooks · Resend (email) · Turnstile · Revolutionise (VNSW membership, link only)
   GitHub Actions: CI, preview versions, deploy staging → production, nightly D1 export to R2
```

### Key decisions

| Area                | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rendering           | `output: 'server'`. Public pages read D1 and are cached at the edge by Astro route caching (`cacheCloudflare()`), tagged per league/season/page; an admin publish purges the affected tags. Pages that rarely change can opt into `prerender = true`. **Verify in Phase 2** that the Worker cache layer and tag purge work on the free plan. Fallback: `Cloudflare-CDN-Cache-Control: s-maxage=60, stale-while-revalidate=86400`, which bounds staleness at a minute with near-zero cost. Note: no edge caching happens on `*.workers.dev`, only after the custom domain is attached. |
| CPU (10 ms/request) | No password hashing on the server. The fixtures scheduler (simulated annealing + Hungarian) runs **in the admin's browser**; the server validates the shape and saves it. Ladders are computed per request from one indexed query per season (≤ 100 matches) and cached.                                                                                                                                                                                                                                                                                                              |
| D1 limits           | One `db.batch()` per mutation where possible, never a query per row, and at most 50 queries per request. Indexes on every foreign key and slug.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Auth                | **Better Auth** (supports D1 through Drizzle). Sign-in by **email OTP or magic link** (no passwords), plus the **twoFactor (TOTP)** plugin. Roles, invites and the audit log are our own tables on top (see [Data model](#auth-and-admin)). Session lookups use Better Auth's signed cookie cache so most admin requests don't hit D1. Phase 3 measures sign-in CPU time against the 10 ms limit before going further.                                                                                                                                                                |
| Images              | Resized **in the browser** (canvas → WebP at 400/800/1600 px widths) before upload to R2 via the Worker; `<img srcset>` picks the size. No Cloudflare Images. Before cutover, media is served through the Worker at `/media/*`; after cutover, from an R2 custom domain (`media.tempevb.com`) so image requests don't count toward the Worker's 100k requests/day.                                                                                                                                                                                                                    |
| Email               | `sendEmail()` in `src/server/email/` with a Resend implementation and a console one for local dev. Every email goes into `email_outbox` first; a daily counter caps sends at 95/day (under Resend's 100), and the hourly cron drains the rest. Sender: `noreply@mail.tempevb.com` (subdomain, so the main domain's mail records are untouched).                                                                                                                                                                                                                                       |
| Payments            | `PaymentProvider` interface (`createCheckout`, `handleWebhook`, `refund?`) with `stripe` (Checkout, SDK `fetch` client, `constructEventAsync`) and `payid` (manual: show PayID + unique reference, admin marks paid). Money is integer cents in AUD.                                                                                                                                                                                                                                                                                                                                  |
| Bot protection      | Turnstile on every public form, verified server-side before any D1 write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Time and money      | Store instants as UTC ISO strings; store match dates as `YYYY-MM-DD` and times as `HH:MM` **Sydney wall-clock**. Format with `Australia/Sydney` and `en-AU`, AUD (`src/lib/time.ts`).                                                                                                                                                                                                                                                                                                                                                                                                 |
| Search engines      | Real URLs, `<title>` and meta description per page, Open Graph, JSON-LD (`SportsOrganization`, `SportsEvent` for upcoming fixtures, `BreadcrumbList`), a sitemap of real pages only (not 480 match stubs), and 301s from every old URL. Non-production environments send `X-Robots-Tag: noindex` and a disallow-all `robots.txt`.                                                                                                                                                                                                                                                     |
| Analytics           | Keep GA4 (same tag) and Google Search Console (verified by DNS TXT), add the Cloudflare Web Analytics beacon, drop Jetpack. Phase 6 adds an admin Stats page fed by a daily cron; see [docs/admin.md](docs/admin.md#2-analytics-and-the-stats-page). GA4 sets cookies, so "no cookie banner" needs checking.                                                                                                                                                                                                                                                                          |
| Observability       | Workers Logs (`observability.enabled`). Structured `console.info/error` with a request id. Add Sentry's free plan only if this proves too thin.                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Code layout

```
src/
  worker.ts             Worker entry: Astro fetch handler + scheduled() for crons
  middleware.ts         noindex outside production; later: auth guard for /admin and /api/admin
  pages/                Astro routes: public pages, /admin, /api/*
  layouts/ components/  Astro components for public pages (no JS by default)
  admin/                React islands for the admin (ported demo components live here)
  lib/                  Pure, UI-free, runtime-free logic + tests (scheduler, ladder, finals, time, money …)
  server/               Code that needs bindings: db/ (Drizzle schema + client), email/, payments/, auth/, cron.ts
migrations/             SQL generated by drizzle-kit, applied by wrangler d1 migrations apply
scripts/                One-off tools, e.g. the WordPress importer (runs locally with Node)
docs/reference/         Screenshots of the old site; docs/baseline/ Lighthouse baseline
```

### Environments

| Env              | Worker                                | D1                                | R2 (media)                 | URL                                                   |
| ---------------- | ------------------------------------- | --------------------------------- | -------------------------- | ----------------------------------------------------- |
| local            | (wrangler/vite dev)                   | local SQLite in `.wrangler/state` | local                      | `localhost:4321`                                      |
| preview (per PR) | preview version of the staging Worker | staging                           | staging                    | `pr-<n>-tempe-volleyball-staging.<sub>.workers.dev`   |
| staging          | `tempe-volleyball-staging`            | `tempevb-staging`                 | `tempevb-media-staging`    | `tempe-volleyball-staging.<sub>.workers.dev`          |
| production       | `tempe-volleyball-production`         | `tempevb-production`              | `tempevb-media-production` | `*.workers.dev` until cutover, then `www.tempevb.com` |

Backups go to a separate private bucket, `tempevb-backups` (30-day lifecycle rule).

### CI/CD (GitHub Actions)

- **`ci.yml`** (every PR): lint, format check, typecheck, test, build, then upload a **preview version** of the staging
  Worker with alias `pr-<n>` and post its URL in the job summary. Previews use the staging database and **don't** run
  migrations.
- **`deploy.yml`** (merge to `main`): check → migrate and deploy **staging**, then smoke-test `/api/health` → migrate and deploy
  **production** automatically, then smoke-test. A failure at any step stops the run before production. There's no manual
  approval step (decided 2026-10-17); one can be added later as required reviewers on the `production` environment. Migrations run before the new code goes live, so each one must work with the code that's already deployed
  (add first, remove in a later release).
- **`backup.yml`** (nightly, 03:30 Sydney in summer): `wrangler d1 export` of production → gzip → `tempevb-backups/d1/production/<date>.sql.gz`.
  D1 Time Travel covers point-in-time restore for 7 days.
- All three jobs skip their Cloudflare steps until the repo variable `CLOUDFLARE_READY` is `true`, so CI stays green
  before the accounts exist.

---

## Data model

D1 (SQLite) through Drizzle. Conventions:

- IDs are text (`crypto.randomUUID()`), except join tables.
- Money is integer cents (AUD). Instants are UTC ISO-8601 text. Dates are `YYYY-MM-DD` and times `HH:MM`, both Sydney
  local time.
- Imported rows keep `wp_id` so the importer can re-run idempotently and build redirects.
- Every table has `created_at` and `updated_at`. Content tables also have `updated_by` (the user id).

**Phase 6 additions** (migration `0003_phase6_programmes`, documented column by column in
[docs/data-model-phase6.md](docs/data-model-phase6.md)):

- `leagues` becomes the **programmes** table (exported as `programmes` too), with `kind` (league, training,
  development, event), `category_id`, `status` (draft, active, retired), schedule, description, summary line, menu
  visibility and enrolment defaults (switch, window, form, team and player caps, price, waitlist).
- New tables: `categories` (seeded with the four), `development_terms`, `programme_sessions`, `events`,
  `enrolment_forms`, `page_data_refs`, `analytics_daily`, `analytics_fetches` and `analytics_state`.
- Enrolment reuses `products` (one per season, session, term or event, carrying that instance's caps and overrides),
  `registrations` (waitlist, offers, free agents, manual paid) and `groups` (team entries with status and waitlist).
- Fixtures parity: postponed and TBD matches, whole-night status and `original_date` on `match_days`, outcome
  overrides, withdrawn teams, and tie-break order and withdrawn policy in `seasons.settings`.
- `menu_items` gains `category` items (automatic dropdowns), placement before or after the automatic links, and
  `hidden`.

### Competition

| Table                | Key columns                                                                                                                                                                                                                                                                                                                                                                                     | Notes                                                                                                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `venues`             | id, name, slug, address, map_url, directions                                                                                                                                                                                                                                                                                                                                                    | The **places**: Robyn Webster Sports Centre (Tempe), MLC School (Burwood), Five Dock Leisure Centre.                                                                                                        |
| `courts`             | id, venue_id, name, sort                                                                                                                                                                                                                                                                                                                                                                        | SportsPress "venues" were really courts: Court 1, Court 2, Court 3, MLC.                                                                                                                                    |
| `leagues`            | id, code (`TNL` `FNL` `SNL` `SAL` `TVSL`), name, slug, weekday, default_venue_id, **format** (`social` \| `super`), sort, active                                                                                                                                                                                                                                                                | `social`: 2 sets, draws allowed, team duty. `super` (TVSL): best of 5 sets, 90-min slots, VNSW referees, **no duty**.                                                                                       |
| `seasons`            | id, league_id, name ("TNL Q4 2026"), slug, year, quarter, start_date, status (`draft` \| `published` \| `archived`), **settings** (JSON: the demo's `Settings` minus teams: sessions, session_minutes, meetings, include_finals, seed, skip_dates, default court ids), points_win/draw/loss (default 3/2/1), sets_per_match (2 or 5), duty_enabled, generated_from, edited, published_at, wp_id | Several leagues run seasons at the same time; one row per league per quarter.                                                                                                                               |
| `teams`              | id, name, slug, wp_id                                                                                                                                                                                                                                                                                                                                                                           | Teams persist across seasons (SportsPress has 88).                                                                                                                                                          |
| `season_teams`       | season_id, team_id, sort                                                                                                                                                                                                                                                                                                                                                                        | Who's in a season.                                                                                                                                                                                          |
| `match_days`         | id, season_id, date, kind (`regular` \| `semi` \| `final` \| `skip`), number, note, court_overrides (JSON keyed by `session:position`), results_published_at                                                                                                                                                                                                                                    | The demo's `Week`.                                                                                                                                                                                          |
| `matches`            | id, season_id, match_day_id, session, position, start_time, court_id, home_team_id \| home_label, away_team_id \| away_label, duty_team_id \| duty_label, stage_title ("Semi Final 1", "3rd Place Playoff"), status (`scheduled` \| `played` \| `forfeit` \| `cancelled`), slug, wp_id                                                                                                          | A side is either a team **or** a placeholder label ("2nd", "Loser SF1"), resolved by the ported `makeResolver`. This replaces typing placeholders and duty into match titles. Byes are derived, not stored. |
| `match_results`      | match_id, kind (`draft` \| `published`), home_sets, away_sets, set_scores (JSON `[[25,21],[19,25]]`, up to 5), home_points, away_points, updated_by                                                                                                                                                                                                                                             | Two rows per match mirror the demo's `result` and `publishedResult`. The ladder and website read only `published`. Point totals are derived from set scores when present.                                   |
| `ladder_adjustments` | id, season_id, team_id, points, reason                                                                                                                                                                                                                                                                                                                                                          | For penalties, and to reconcile imported SportsPress tables that were hand-adjusted.                                                                                                                        |

The ladder is **computed, not stored**: Pos, Team, Pts, P, W, D, L, S+, S−, P+, P−, Ratio (P+ ÷ (P+ + P−), as on the
current site). The ladder page heading ("Week 4 of 9", "Updated 16/10/2026") comes from `match_days` and
`results_published_at`, so nobody edits it by hand again.

### Content

| Table            | Key columns                                                                                                                                                                                             | Notes                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pages`          | id, path (unique, e.g. `/about`), title, meta_description, og_image_id, template (`content` \| `home` \| `contact` …), body (JSON blocks from the editor + sanitised HTML), status, published_at, wp_id | Ladder and fixture pages are routes driven by league data, not pages.                                                    |
| `page_revisions` | id, page_id, body, title, created_by, created_at                                                                                                                                                        | Keep the last ~20 per page so edits can be undone.                                                                       |
| `posts`          | id, slug, title, excerpt, body, cover_media_id, category, status, published_at, wp_id                                                                                                                   | News (23 posts today).                                                                                                   |
| `menu_items`     | id, parent_id, label, kind (`page` \| `url` \| `league_ladder` \| `league_fixtures`), page_id, league_id, url, sort                                                                                     | Two levels, like the current menu. League items always point at the current season.                                      |
| `media`          | id, key_base, filename, alt, mime, width, height, variants (JSON widths), bytes, uploaded_by, wp_id, wp_url                                                                                             | Files at `media/<id>/<width>.webp` plus the original. `wp_url` lets the importer rewrite old image links in page bodies. |
| `redirects`      | from_path (unique), to_path, status (301), source (`wp-import` \| `manual`), hits, last_hit_at                                                                                                          | Checked in middleware only when no route matches, so it costs nothing on normal requests.                                |
| `site_settings`  | key, value (JSON)                                                                                                                                                                                       | Contact details, PayID, social links, Revolutionise URL, announcement banner. **Exists already** (Phase 1).              |

### Auth and admin

Better Auth owns `user`, `session`, `account`, `verification` and `two_factor`. We generate these into the Drizzle schema
with its CLI so they go through the same migrations. On top of that:

| Table / column  | Notes                                                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user.role`     | `owner` > `admin` > `editor` (additional field). Editors manage content and results; admins also manage seasons, products, payments and editors; owners also manage admins and owners.                                 |
| `admin_invites` | id, email, role, token_hash, invited_by, expires_at (7 days), accepted_at, revoked_at. Accepting creates the user with that role.                                                                                      |
| `audit_log`     | id, at, actor_user_id, action (`role.grant`, `role.revoke`, `invite.create`, `invite.revoke`, `user.remove`, `payment.mark_paid`, `results.publish` …), target_type, target_id, before, after (JSON), ip. Append-only. |

Rules, enforced in one server-side module (`src/server/auth/roles.ts`) with tests:

- You can only grant or revoke roles **strictly below** your own. Only an owner can create or demote another owner.
- The last owner can't be removed or demoted (checked inside the same `batch` as the write).
- Invites expire. The hourly cron marks them expired, and acceptance checks the expiry too.
- Every role change and invite writes `audit_log` in the same batch.
- TOTP is available to everyone and **required for owners**: an owner without TOTP enrolled is sent to enrolment before
  any admin page.

### Registrations and payments

| Table               | Key columns                                                                                                                                                                                                                                                        | Notes                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `products`          | id, kind (`season_entry` \| `training_session` \| `adp_term` \| `jdp_term`), name, slug, description, price_cents, capacity (training: 40), starts_on, ends_on, opens_at, closes_at, season_id?, payment_methods (JSON: `stripe`, `payid`), active                 | One payment covers one player and one product. No team fees.                                                                            |
| `players`           | id, first_name, last_name, email, phone, birth_year?, guardian_name/email/phone (JDP), emergency_contact, notes                                                                                                                                                    | Matched by email so returning players aren't duplicated.                                                                                |
| `groups`            | id, kind (`team` \| `group`), name, captain_player_id, product_id                                                                                                                                                                                                  | Replaces the "new team or group" Google Form. Each member still registers and pays individually, linked by `group_id`.                  |
| `registrations`     | id, product_id, player_id, group_id?, status (`pending_payment` \| `paid` \| `cancelled` \| `expired` \| `refunded` \| `waitlist`), reference (unique, short, e.g. `TVB-7K3Q`), hold_expires_at, answers (JSON: skill level, preferred division …), vnsw_confirmed | Capacity is checked with a conditional insert in a batch, so two people can't take the last spot. Unpaid holds expire through the cron. |
| `payments`          | id, registration_id, provider (`stripe` \| `payid`), amount_cents, currency (`AUD`), status, provider_ref (Checkout Session / PaymentIntent id), marked_paid_by, paid_at                                                                                           | PayID payments are marked paid by an admin (audited).                                                                                   |
| `stripe_events`     | id (Stripe event id), type, received_at                                                                                                                                                                                                                            | Makes the webhook idempotent.                                                                                                           |
| `email_outbox`      | id, to, template, payload, status (`queued` \| `sent` \| `failed`), attempts, send_after, sent_at, provider_id, error                                                                                                                                              | Sends go over the daily cap into a queue, so none are dropped.                                                                          |
| `email_daily_count` | day (Sydney date), sent                                                                                                                                                                                                                                            | Enforces the Resend daily cap.                                                                                                          |

Volleyball NSW membership stays external: the forms link to Sydney Uni's Revolutionise portal and ask the player to
confirm they're a member (`vnsw_confirmed`).

---

## Phases

Each phase ends with something deployed to staging and production.

### Phase 1: Skeleton and deploy ✅ (code done; deploy waits on accounts)

- Astro 7 + Cloudflare adapter, Tailwind v4, Vitest, oxlint, Prettier, Drizzle + D1 (one `site_settings` table to prove
  migrations), a custom Worker entry with a cron stub, `/api/health`, a placeholder home page, noindex outside production.
- `wrangler.jsonc` with staging and production; CI, deploy and backup workflows; `.dev.vars.example`.
- Lighthouse baseline of the live site (`docs/baseline/`) and design screenshots (`docs/reference/`).
- **Done when:** staging and production `*.workers.dev` return 200 from `/api/health` with `"db":"ok"`.

### Phase 2: Migration and a read-only public site that matches the old one

- `scripts/import-wp.ts`: pulls the public WordPress and SportsPress REST APIs (pages 64, posts 23, media 236, events 480,
  teams 88, leagues 11, seasons 15, venues 4, tables 14, calendars 21) into a local D1, then pushes to staging and
  production with `wrangler d1 execute --file`. Idempotent by `wp_id`.
  - Parses placeholder and duty text out of match titles ("3RD PLACE PLAYOFF – (LOSER SF1) vs (LOSER SF2) – DUTY LOSER
    GF") into labels and `stage_title`. Placeholder teams come through as `-1` in the API.
  - Results come from `performance` (set points `one`…`five`, `sets`). Each imported season's ladder is compared with the
    SportsPress table, and any differences go into `ladder_adjustments` with a reason.
  - Media is downloaded, resized to the fixed widths and uploaded to R2; image links in page bodies are rewritten.
- Public routes: home, content pages, `/leagues/<league>` (current season fixtures + ladder), `/leagues/<league>/<season>`
  (archive), news, venues. Same header (logo over the hero photo, blue nav with amber active item), blue tables with amber
  captions, dark footer with ladder widgets, amber copyright bar.
- Self-host Lato and Noto Sans (Droid Sans's successor) with `font-display: swap` and size-adjusted fallbacks, which fixes
  most of the 0.42 CLS.
- Turn on route caching and check tag purge on the free plan (see Rendering above).
- **Done when:** every public page of the old site has an equivalent on staging with the same content, and staging scores
  better than the baseline in Lighthouse.

### Phase 3: Admin login and roles, plus page, menu and media editing

- Better Auth (email OTP / magic link, TOTP), roles, invites, audit log, owner TOTP enforcement. Michael is seeded as the
  owner. Measure CPU per auth request.
- `/admin` shell (React): pages (rich-text editor, likely TipTap, storing JSON + sanitised HTML, with revisions,
  draft/publish and SEO fields), menu editor (drag to reorder, two levels), media library (browser resize → R2), news posts,
  site settings, admin users.
- Publishing purges the edge cache for the affected pages.
- **Done when:** Michael can sign in, invite an editor, and change any page, the menu and images without a developer.

### Phase 4: Fixtures and results, ported from the demo

- Copy `src/lib` from `volleyball-registration-page` with its tests, then close the gaps:
  - **several leagues at once**: seasons are scoped by league, and court clashes across leagues on the same night and
    venue are flagged;
  - **the TVSL format**: `duty_enabled = false` skips the duty step in the scheduler and validation, 90-minute sessions,
    best of 5 sets;
  - **set-by-set scores** (up to 5) in `Result`, alongside sets and points;
  - **the database instead of localStorage**: `storage.ts` is replaced by API calls. The draft/published split, the
    published-results-only rule and the hash-routed editor become `/admin/seasons/<id>/<tab>` routes.
- The scheduler keeps running in the browser (a Web Worker so the UI stays responsive); the server validates the result and
  saves it in one batch.
- Public fixtures and ladder pages read the new tables; the "Week N of M" and "Updated" lines are generated.
- **Done when:** Michael creates a real next-quarter season for each league, publishes it, and enters a week's results
  that appear on the site.

### Phase 5: Registration and payments (parked, 2026-10-18)

**Update:** enrolment without online payment (forms, caps, waitlists, manual paid/unpaid) moved to Phase 6. Only payment
processing (Stripe, PayID automation, refunds) stays parked.

Michael says payments are his smallest pain point today and he'd rather revisit them later. **Nothing in this phase is
being built now**, but the groundwork stays so it can be picked up without a migration:

- **Kept:** the `products`, `players`, `groups`, `registrations`, `payments`, `stripe_events` tables (in
  `0001_full_schema`), the PayID and Revolutionise URL site settings, the outbox email path and the `PaymentProvider`
  design in Key decisions. Don't drop these tables or settings, and keep new code compatible with them.
- **Not built yet:** the `src/server/payments/` providers, Stripe Checkout and `/api/stripe/webhook`, products and
  registrations admin screens, the public sign-up forms (the three Google Forms stay in use until then), Turnstile on those
  forms, holds, waitlist and the hold-expiry cron job.
- No Stripe account or Stripe secrets are needed until this is picked up again.

When it's picked up, the original scope still applies:

- Products admin (price, capacity, dates, payment methods). Built-in forms replace the three Google Forms (new player, new
  team or group, training sessions), protected by Turnstile.
- Stripe Checkout + `/api/stripe/webhook` (`constructEventAsync`, idempotent via `stripe_events`), PayID instructions with
  a unique reference, and an admin "mark as paid" action.
- Capacity holds, a waitlist, hourly expiry of unpaid holds, and confirmation emails through the outbox. Stripe sends the
  receipts.
- Admin views: registrations per product, CSV export, payment status, refunds (per the policy decided below).
- **Done when:** a test player can register for a training session and pay by Stripe (test mode) and by PayID, and
  capacity is enforced.

### Phase 6: Admin upgrade

**Scope lives in [docs/admin.md](docs/admin.md).** In short:

- **Parity with SportsPress first:** everything Michael relies on in the old admin must exist before the cutover
  (league management, venues and courts, postponed/TBD matches, bulk postpone or cancel a night, a cross-league match list,
  withdrawn teams, tie-break order, Ladder and Fixtures blocks for pages, fixture lists and iCal feeds, CSV import).
- **Programmes and categories** ([docs/admin.md §3](docs/admin.md#3-programmes-categories-and-how-pages-link-to-them)):
  leagues, training, development programmes and events become records in admin-managed categories. Menus, category
  pages, `/enrol` and page blocks are generated from them and stay editable by hand. **Enrolment (without online
  payment)** moves here from Phase 5: forms, caps, waitlists, manual paid/unpaid. The 37 imported pages are remapped
  into the new structure.
- **Analytics:** keep GA4 and Search Console, add Cloudflare Web Analytics, drop Jetpack, and build an admin Stats page fed
  by a daily cron.
- **Admin UI/UX** improvements, still being written.
- **Done when:** every "must have" row in docs/admin.md is Done, and Michael can run a night without SportsPress.

### Phase 7: Public site UI/UX and SEO

The public website only; the admin is Phase 6.

- Meta descriptions, Open Graph, JSON-LD, sitemap (real pages only), one H1 per page, fix the homepage's first line.
- UX: a real contact form (with Turnstile), the sidebar/footer ladder duplication from the QA review, mobile layout of
  long fixtures tables, and the small Lighthouse leftovers (responsive hero/logo sizes, render-blocking CSS).
- Accessibility fixes from the baseline (contrast on blue tables, labelled menu button, heading order, descriptive link
  text), kept at Lighthouse 100.
- Remove or redirect stale pages: 2021 Monday leagues, COVID guidelines, "Sample Page", duplicates (two Thursday fixtures
  pages, two Sunday afternoon pages), year-stamped slugs like `/2023-enrolment/`.
- **Done when:** every public page passes Lighthouse SEO and accessibility (apart from the deliberate noindex outside
  production) and Michael is happy with how the site looks on desktop and phone.

### Phase 8: Migration and cutover

- **Gate:** don't cut over until Phase 6's parity list in [docs/admin.md](docs/admin.md) is complete.
- **Production data**: run the importer against production (it deliberately has no production target yet; add one only
  with explicit go-ahead), or copy staging's cleaned data, so production starts from the same content Michael has
  checked on staging. Bootstrap Michael as owner on production.
- **Email**: Resend's DNS records for `mail.tempevb.com` and `RESEND_API_KEY` on production, so sign-in codes are sent.
- **Redirect map**: `/team/<slug>/`, `/table/<slug>/`, `/event/<slug>/`, `/calendar/<slug>/`, every old page slug
  (`/fixtures/`, `/ladders/`, `/fnl-ladder/`, `/sal/` …), `/wp-admin` → `/admin`, plus feeds and attachment URLs. All are
  301s generated from `wp_id` mappings and checked by a script against the live sitemap and a crawl of the old site.
- **Cutover** (only with explicit go-ahead): copy every DNS record from the current host (especially MX, SPF, DKIM, DMARC
  and any verification TXT), add the zone to Cloudflare, check that the records match, switch nameservers at the
  registrar, attach `www.tempevb.com` and the apex to the production Worker, redirect apex to www, add the Web Analytics
  beacon, verify Search Console by TXT, and submit the sitemap. Check edge caching and tag purge on the real domain. Keep
  WordPress read-only for 30 days as a fallback.
- **Close the uncached back door:** set `workers_dev: false` on the production environment in `wrangler.jsonc` at the
  cutover, once www.tempevb.com serves it. The production Worker is reachable on `*.workers.dev` today, where Cloudflare
  never caches Worker responses, so every request there renders from D1. (Staging keeps workers.dev.)
- **Rate-limit the Worker** with the free WAF rate-limiting rule (Cloudflare setup item 8 below) once the zone is on
  Cloudflare.

---

## Open questions

These don't block Phase 1 or 2.

1. _(Parked with Phase 5.)_ **Payment provider:** Stripe only, PayID only, or both? Does Michael have an ABN? (Stripe Australia can onboard an
   individual or sole trader without one, but an ABN affects GST on fees and how payouts are reported.)
2. _(Parked with Phase 5.)_ **Refunds and cancellations:** what are the rules? Are training sessions paid per session, per term, or both?
3. _(Parked with Phase 5.)_ **Season entry:** what exactly does it include, and what does each product cost?
4. **Analytics:** which numbers does Michael actually look at today (Jetpack Stats, Site Kit)? Jetpack history probably
   can't be moved over.
5. **News:** keep posting, or treat the 23 posts as an archive?
6. **Domain and email:** who controls tempevb.com (registrar login) and its DNS today, and where is email hosted? (The
   site lists a Gmail address, but the domain may still have MX records.) Needed before the cutover so mail doesn't break.
7. **Drawn matches (found by the importer, 2026-10-18):** on the old site, a social match level on sets (1–1) was
   decided on total points: SportsPress recorded it as "draww"/"drawl" and the ladder counted it as a win (3) or a loss
   (1); only a match level on points too was a draw (2). The ported fixtures library counts every 1–1 as a draw. The
   importer reproduces the old ladders with `ladder_adjustments` (reason `wp-import reconciliation`), but Michael needs
   to confirm the rule for new seasons. Relatedly, the short third set is recorded as set points but doesn't always
   count as a set, so the importer keeps SportsPress's sets/points totals and drops set scores that disagree.
8. Smaller ones, for later phases:
   - Do mixed leagues need gender on registrations (for team balance)?
   - Do JDP juniors need guardian consent wording or a Working With Children note?
   - Should old match stub pages (`/event/<slug>/`) redirect to the season fixtures page or to a new match page?
   - Do historical seasons before 2023 need importing, or only what the API has?

---

## Setup needed from Jeremy

I haven't created or guessed any of these. Everything below is free unless noted.

### Cloudflare

**Done 2026-10-17** (steps 1–5, on the account for jezzah2g0@gmail.com). Steps 6 and 7 are still to do.

1. A **Cloudflare account** that will own the site (ideally Michael's, or a shared one with Michael as Super
   Administrator), on the Workers **Free** plan.
2. The **workers.dev subdomain** you choose (Workers & Pages → Overview). I'll put it into `SITE_URL` in `wrangler.jsonc`.
3. **R2 enabled.** This needs a card on file but stays $0 within 10 GB. Then create three buckets:
   `tempevb-media-staging`, `tempevb-media-production`, and `tempevb-backups` (private), with a 30-day delete lifecycle
   rule on `tempevb-backups` (`npx wrangler r2 bucket lifecycle add tempevb-backups ...` or the dashboard).
4. **Two D1 databases**: `npx wrangler d1 create tempevb-staging` and `npx wrangler d1 create tempevb-production`. Send me
   the two `database_id`s (they go in `wrangler.jsonc` and aren't secret), or tell me to run the commands once you've done
   `npx wrangler login`.
5. An **API token** for GitHub Actions, from the "Edit Cloudflare Workers" template plus **D1: Edit** and
   **Workers R2 Storage: Edit**, scoped to that one account. Also send the **Account ID**.
6. **Before enrolment opens on production** (Phase 6 enrolment, built): a **Turnstile** widget (site key + secret) with
   hostnames `*.workers.dev` for now, and tempevb.com at cutover. Secrets `TURNSTILE_SITE_KEY` and
   `TURNSTILE_SECRET_KEY` for production; staging and development fall back to Cloudflare's test keys. Without them
   production's enrolment form says it's unavailable (docs/api/enrolment.md).
7. For the admin Stats page (built in Phase 6, waiting for these): a **Web Analytics** site (manual snippet) for
   `www.tempevb.com`, giving the beacon token and site tag (at the cutover, Phase 8), and an API token with **Account →
   Account Analytics → Read** (secret `CF_ANALYTICS_TOKEN`). Steps in docs/admin.md §2.3.
8. **At the cutover (Phase 8), once tempevb.com is a Cloudflare zone:** one free **WAF rate-limiting rule**
   (Security → WAF → Rate limiting rules; the Free plan allows one). Suggested: requests whose path doesn't start with
   `/_astro/`, `/fonts/` or `/media/`, counted per IP, more than 60 in 10 seconds → Block for 10 seconds. It caps
   anyone hammering uncached URLs, which would otherwise eat the Worker's 100k requests and D1's 5M rows a day
   (docs/admin.md §3.14). Also set `workers_dev: false` on production then (Phase 8).

### Google (Phase 6 Stats page)

1. A Google Cloud **service account** with the Analytics Data API and Search Console API enabled, added as **Viewer** on
   the GA4 property and as a **Restricted** user on the Search Console property. Its JSON key goes in with
   `wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env production`. Steps in docs/admin.md §2.3.
2. The **GA4 property ID** and the **Search Console property name**, entered in Admin → Settings → Analytics.

### GitHub

**Done 2026-10-17.** The repo is `tempe-volleyball/tempe-volleyball` (public).

1. The **repository**, in a free organisation.
2. **Environments**: `preview`, `staging`, `production` (`staging` and `production` limited to `main`, with no required
   reviewers).
3. **Secrets** (repo or environment level): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
4. **Variables**: `STAGING_URL`, `PRODUCTION_URL` (the workers.dev URLs), and `CLOUDFLARE_READY=true` once the steps
   above are done. This switches on the deploy steps.

### Resend (Phase 3)

1. A **Resend account** (free plan) and a sending domain **`mail.tempevb.com`**. Its DNS records (SPF, DKIM, and
   optionally a DMARC TXT) can only be added by whoever controls the tempevb.com DNS today. They're new records on a
   subdomain and don't touch existing mail.
2. An **API key** with "Sending access" only. It goes in with `wrangler secret put RESEND_API_KEY --env <env>`. Don't send
   it to me in chat; run the command yourself, or put it in your local `.dev.vars`.

### Stripe (Phase 5, parked: not needed for now)

1. A **Stripe account** in Michael's name (the money goes to him personally), activated for Australia, with his bank
   account for payouts. **Test-mode** keys are enough until launch.
2. Later, the live **secret key** and a **webhook endpoint** for `https://<prod>/api/stripe/webhook` (events:
   `checkout.session.completed`, `checkout.session.expired`, `charge.refunded`). Its signing secret goes in with
   `wrangler secret put`.

### Secrets per environment (set with `wrangler secret put <NAME> --env staging|production`)

`BETTER_AUTH_SECRET` (Phase 3), `RESEND_API_KEY` (Phase 3), `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (Phase 5, parked),
`TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` (Phase 6 enrolment; required in production, test keys elsewhere), `GOOGLE_SERVICE_ACCOUNT_JSON` and `CF_ANALYTICS_TOKEN` (Phase 6 Stats page; optional,
each source shows "not connected yet" without them). None are needed for the Phase 1 deploy.

### Cron trigger limit

The free plan allows 5 cron triggers per account. This project uses 2 (one hourly trigger each for staging and
production).

---

## Reference: the current site

Audited 2026-10-17. Screenshots are in `docs/reference/`, and the Lighthouse baseline is in `docs/baseline/README.md`
(mobile performance 48–51, CLS 0.42, LCP 5.8–7.2 s, no meta descriptions).

**Design tokens** (from computed styles):

| Token      | Value                                                                       | Used for                                                                                        |
| ---------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| brand      | `#104293`                                                                   | nav bar, table bodies                                                                           |
| accent     | `#FFA800`                                                                   | links, table captions, 4 px rule under the header and under H1s, copyright bar, active nav item |
| ink        | `#222222`                                                                   | body text                                                                                       |
| paper      | `#E4E4E4`                                                                   | page background                                                                                 |
| header-row | `#555555`                                                                   | table header rows                                                                               |
| footer     | `#111111`                                                                   | footer widget area                                                                              |
| brand-soft | `#87A0C9`                                                                   | muted numbers in tables (fails contrast)                                                        |
| fonts      | Lato 400/700 (headings, uppercase nav at 18px/700), Droid Sans (body, 16px) |                                                                                                 |

**Layout:** a full-width hero photo (players at the net) with the logo ("Tempe Volleyball, the one and only since 2005" +
Sydney Uni Volleyball Club badge) on the left and a two-row blue nav block on the right. The content area has a main
column and a right sidebar (calendar, ladder widgets). The dark footer has four league ladder widgets plus "Contact Us"
(Michael 0414 911 544, tempevb@gmail.com, Instagram tempe.volleyball) and "Where We Play", then an amber copyright bar. On
mobile, the nav collapses to an amber bar with a hamburger above the hero.

**Current menu:** Home · Junior Dev Program (JDP) · Adult Dev Program (ADP) · Mixed Leagues (League Ladders: TNL, FNL,
SNL, SAL; League Fixtures: TNL, FNL, SNL, SAL) · Super League (TVSL) (Fixtures and Results, Ladder) · Enrolment (Juniors &
Social Mixed Leagues Enrolment `/2023-enrolment/`, JDP, Scrim & Coached Training Sessions) · About (About Tempe VB, Where
We Play, Contact, Rules, FAQ) · Login · Instagram.

**Old URL patterns to redirect:** `/team/<slug>/`, `/table/<slug>/`, `/event/<slug>/`, `/calendar/<slug>/`, and page
slugs such as `/fixtures/`, `/ladders/`, `/fnl-ladder/`, `/saturday-night-league-standings/`, `/sunday-pm-league-ladder/`,
`/fnl-fixtures-and-results/`, `/snl-fixtures-and-results/`, `/sal/`, `/saturday-night-endorsed-league/`,
`/sunday-super-league-fixtures-and-results/`, `/sunday-super-league-week-1-of-6/`, `/2023-enrolment/`,
`/junior-development-program-jdp/`, `/junior-development-program-jdp-volleyjoeys/`, `/adult-development-program-adp/`,
`/adults-social-training/`, `/about-tempe-vb/`, `/where-we-play/`, `/contact/`, `/rules/`, `/faq/`.
