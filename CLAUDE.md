# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

## What this is

The replacement for www.tempevb.com, the website of Tempe Volleyball, a social volleyball league in Sydney run by
Michael (the organiser). The old site is WordPress + SportsPress; this one is a single Cloudflare Worker that serves the
public site, the admin at `/admin` and the API at `/api`, and it must run on free tiers only. **PLAN.md** has the
architecture, data model, phases, open questions and the account setup still needed. Read it before starting a phase.

Stack: Astro 7 (`output: 'server'`) with `@astrojs/cloudflare` 14, React 19 islands, Tailwind v4 (tokens in
`src/styles/global.css`), D1 via Drizzle ORM, R2, Vitest 5, oxlint, Prettier. Node ≥ 22.22; CI uses Node 24.

## Commands

```sh
npm run dev                       # Astro dev server (runs in workerd with local D1/R2 from .wrangler/state)
npm test                          # vitest run
npx vitest run src/lib/time.test.ts   # one file;  npx vitest run -t "AEDT"  for tests matching a name
npm run lint                      # oxlint
npm run typecheck                 # wrangler types (regenerates worker-configuration.d.ts) + astro check
npm run format                    # prettier --write .   (format:check in CI)
npm run build                     # astro build -> dist/client (static) + dist/server (Worker + generated wrangler.json)
npm run preview                   # build, then wrangler dev on the built Worker (closest to production)
npm run check                     # everything CI runs, in order

npm run db:generate -- --name <what>   # drizzle-kit: schema.ts changes -> migrations/NNNN_<what>.sql
npm run db:migrate:local               # apply migrations to the local D1
npm run admin:bootstrap -- --email <email> --env local|staging|production   # create/promote an owner
npm run import:wp                      # import the old WordPress/SportsPress site into the local D1 + R2
npm run import:wp -- --remote-staging  # …and into staging too (never production). --sql-only, --skip-media, --refresh
```

Local admin sign-in: `npm run db:migrate:local`, bootstrap an owner, `npm run dev`, then open `/admin`. With no
`RESEND_API_KEY`, development and staging print every email (codes included) to the console / Workers Logs.

The importer (`scripts/import-wp.ts`) caches the API and media under `scripts/.cache/` (gitignored), writes chunked
upsert SQL to `scripts/.cache/sql/`, and prints a report (also `scripts/.cache/report.json`). Re-running is safe: ids
are derived from WordPress ids, and rows a previous run imported into a season that SportsPress no longer has are
pruned (so don't hand-edit imported seasons and then re-import).

Prettier uses `--no-semi --single-quote --print-width 140` (in `.prettierrc.json`, plus the Astro plugin).

To test the cron handler locally: `npx wrangler dev --test-scheduled`, then
`curl "localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"`.

## Structure

```
src/worker.ts        Worker entry: Astro's fetch handler + scheduled() (crons). wrangler.jsonc "main" points here.
src/middleware.ts    Runs on every SSR request: admin guard (server/auth/guard.ts) for /admin/* and /api/admin/*,
                     noindex unless production on www.tempevb.com.
src/admin/           The admin React app (one client:only island at /admin/*, wouter router with base /admin):
                     sign-in, TOTP enrolment, admin users, audit log, and content: pages (+ revisions), news,
                     menu (dnd-kit), media library, site settings. editor/ is the TipTap editor (lazy-loaded);
                     media/upload.ts resizes images to WebP in the browser. src/pages/admin/[...path].astro mounts it.
src/pages/           Routes. api/health.ts is the deploy smoke test. robots.txt.ts disallows all outside production.
                     Public: index (home page row), [...path] (content pages by pages.path, else the redirects table
                     → 301, else 404), leagues/ (index, [league] = current season #ladder/#fixtures, [league]/[season]
                     archive), news/, media/[id]/[file].ts (R2 MEDIA, immutable caching). Each calls cachePublic().
src/layouts/         BaseLayout.astro: the public shell (hero header + <details> menu, optional ladder sidebar, footer).
src/components/      Public Astro components: SiteHeader, SiteFooter, LadderTable/Widget, FixturesTable, SeasonView.
src/lib/             Pure logic with tests. No bindings, no `cloudflare:*` imports, no DOM. time.ts, indexing.ts.
src/lib/fixtures/    The demo's fixtures logic, ported (Phase 4): types, scheduler (+ rng, dates, holidays),
                     analysis (validate, teamStats), results (ladder, ratio, set scores, finals resolver, ladder
                     heading), edit, competition, export, clashes (court clashes across leagues), demo (sample
                     season). index.ts re-exports the public API. No storage: DB adapters live in src/server/.
src/lib/content/     Content rules shared by admin and Worker: render.ts (editor JSON -> sanitised HTML; the
                     server-side sanitiser), paths.ts (page paths, slugs, reserved prefixes), menu.ts (validate /
                     build the two-level tree), media.ts (widths, upload names, URLs), settings.ts (site_settings
                     keys, defaults, validation, per-key roles).
src/lib/wp-import/   Pure parts of the WordPress importer: title parser (finals labels, duty, byes, skip weeks),
                     SportsPress result mapping, route conventions + old-URL mapping (routes.ts), SQL upserts,
                     upload-link rewriting, ladder reconciliation.
scripts/             Node-only tools run with tsx: import-wp.ts (+ wp/: fetch, competition, content, media).
src/server/          Code that touches bindings: db/schema.ts + db/index.ts (Drizzle; AppDb + runBatch work for D1
                     and the test DB), cron.ts, health.ts, http.ts (JSON route helpers), services.ts (per-isolate
                     db/mailer/auth from `cloudflare:workers`; only routes/middleware import it), later payments/.
                     Public site: site.ts (loadSite: menu, venues, every league's current season + ladder in one
                     batch; page/redirect/post lookups), competition/ (load.ts batched season queries, adapter.ts
                     DB rows -> fixtures lib Settings/Week[] -> ladder rows (+ ladder_adjustments) and fixture rows),
                     cache.ts (route-cache tags + purgePage/purgeSeason/purgeSite/purgePost for admin publishes),
                     media.ts, public.ts (publicDb, redirect fallback). src/lib/content.ts tidies stored HTML.
                     auth/: auth.ts (Better Auth runtime config), options.ts (schema-shaping plugins),
                     passwordless-2fa.ts (TOTP challenge after email-code/magic-link sign-in, which Better Auth's
                     twoFactor doesn't do itself), roles.ts (all role/invite/audit rules), guard.ts, bootstrap.ts.
                     content/: pages, posts, menu, media (R2 streaming), settings: validation, batched writes,
                     audit, 301s on path changes. cache.ts: edge-cache tags + purge() after publishes.
                     email/: createMailer().sendEmail(to, template, data) via email_outbox + 95/day cap + Resend. db/schema.ts re-exports the tables in db/schema/ (one file per
                     area; enums.ts holds the `as const` value lists). db/testing.ts gives tests an in-memory
                     SQLite (node:sqlite) with every migration applied: `const { db } = createTestDb()`.
migrations/          Generated SQL (+ drizzle meta/). Never edit an applied migration; add a new one.
.github/workflows/   ci.yml (PR checks + preview), deploy.yml (staging -> production), backup.yml (nightly).
docs/reference/      Screenshots of the old site, the design to match.  docs/baseline/  Lighthouse baseline.
```

## Conventions

- **TypeScript:** strict, with `erasableSyntaxOnly` (so no enums, namespaces or parameter properties; use `as const`
  objects and union types) and `noUncheckedIndexedAccess`. Code ported from the demo may need small fixes for the latter.
- **Bindings:** read them with `import { env } from 'cloudflare:workers'` in routes and middleware. Pass `env.DB` and
  friends into functions in `src/server/` as arguments so tests can pass fakes; tests run in Node and can't import
  `cloudflare:*`.
- **Env types:** `worker-configuration.d.ts` is generated by `wrangler types` and committed. Rerun it (`npm run typecheck`
  does) after changing `wrangler.jsonc`. Secrets go in `.dev.vars` locally (copy `.dev.vars.example`), never in
  `wrangler.jsonc` and never committed.
- **Environments:** pick one at build time with `CLOUDFLARE_ENV=staging|production npm run build`; `wrangler deploy` then
  uses the generated `dist/server/wrangler.json`. Don't pass `--env` to `wrangler deploy`. The top level of
  `wrangler.jsonc` is local dev only. Bindings aren't inherited, so add new ones to every environment.
- **Migrations:** change `src/server/db/schema.ts`, run `db:generate`, commit the SQL. CI applies migrations **before**
  deploying new code, so a migration must also work with the code that's live: add tables and columns first, and only
  drop or rename in a later release. Avoid SQLite virtual tables (FTS5), because `wrangler d1 export` can't back them up.
- **Free-plan limits shape the code:**
  - Workers get 10 ms of CPU per request. Don't hash passwords and don't run the scheduler on the server; it runs in
    the admin's browser.
  - D1 allows 50 queries per request, 5M rows read and 100k rows written per day. Use `db.batch()`, indexes on foreign
    keys and slugs, and never loop a query over rows.
  - The Worker gets 100k requests a day; static files don't count. Keep CSS, JS, fonts and icons static, and cache
    public pages at the edge.
- **Time and money:** everything shown is in `Australia/Sydney` and AUD (`src/lib/time.ts`). Store instants as UTC ISO
  strings, match dates as `YYYY-MM-DD` and times as `HH:MM` in Sydney local time, and money as integer cents. Never
  format with the Worker's default time zone (UTC).
- **Don't use localStorage** for anything that matters. Data lives in D1. It's fine for UI niceties such as a collapsed
  panel.
- **Providers stay swappable:** email goes through `sendEmail()` (outbox + daily cap) and payments through the
  `PaymentProvider` interface. Don't call Resend or Stripe directly from routes.
- **SEO:** real URLs (no `#/` routes on public pages), one H1 per page, a title and meta description on every page, and
  canonical URLs on `https://www.tempevb.com` (`site` in `astro.config.mjs`). Only production on `www.tempevb.com` is indexable (`src/lib/indexing.ts`); everything else, including production on `*.workers.dev`, sends `noindex`.
- **Page and post bodies:** the server never stores HTML from the browser. The editor sends TipTap JSON blocks and
  `renderBlocks()` (src/lib/content/render.ts) writes `body.html` from an allowlist. A new editor node or mark needs a
  case there too, or it's dropped on save. Imported bodies have `blocks: []` and HTML from the importer's sanitiser.
- **Edge cache purges from the admin:** content mutations in src/server/content/ return the cache tags they touch
  (`site` for menu, settings and page path/status changes; `page:<path>`; `news`, `page:/` and `post:<slug>`), and
  the route calls `purge(context.cache, …)`, which reports the outcome back to the admin.
- **D1 batch gotcha:** inside `runBatch`, use query builders, not ``db.run(sql`…${param}`)``: drizzle's D1 batch can't bind
  a raw statement's parameters (it crashes with "reading 'bind'"), and the node:sqlite test DB doesn't catch it.
  D1 also caps bound parameters at 100 per statement, so chunk multi-row inserts.
- **Don't touch the tempevb.com domain or DNS** until the cutover in Phase 6 is explicitly approved.

## Domain rules

### Leagues, seasons and places

- Several leagues run at the same time, each on its own night: **Thursday (TNL)**, **Friday (FNL)**, **Saturday (SNL)**,
  **Sunday afternoon (SAL)** and the **Super League (TVSL**, called SSL in some old pages). Each league starts a new
  season every quarter, named like "TNL Q4 2026".
- **Places** (venues): Robyn Webster Sports Centre (Tempe, Holbeach Ave), MLC School (Burwood, Rowley St), Five Dock
  Leisure Centre (William St). **Courts** are within a place: Court 1, Court 2, Court 3, MLC. (In SportsPress, the
  "venues" were really courts.)
- **Social leagues:** a match is **2 sets**, so draws happen. Teams referee each other ("duty").
- **TVSL:** best of **5 sets**, **90-minute** slots, **Volleyball NSW referees**, and **no team duty**.
- Results are stored as points per set (up to five sets) plus sets won. Ladder columns: Pos, Team, Pts, P, W, D, L, S+,
  S−, P+, P−, Ratio.
- The ladder heading ("Week 4 of 9", "Updated 16/10/2026") is generated from the season's match days and the last
  results publish. Nobody types it.
- Duty teams and finals placeholders are **data** (team or label fields on the match), never text in a match title.
  (The old site typed things like "3RD PLACE PLAYOFF – (LOSER SF1) vs (LOSER SF2) – DUTY LOSER GF".)
- Volleyball NSW membership is paid externally through Sydney Uni's **Revolutionise** portal. We only link to it.
- **Payments:** one payment covers **one player and one product** (a season entry, a training session, or an ADP or JDP
  term). There are no team fees. Products have a price, a capacity (training is capped at **40 per session**) and dates.
  The money goes to Michael personally, by Stripe Checkout or by PayID (manual; an admin marks it paid).
  **Parked (2026-10-18):** payments and sign-up forms aren't being built yet (PLAN.md Phase 5). Keep the tables,
  settings and `PaymentProvider` design; don't remove them.
- **Admin roles:** owner > admin > editor. You can only grant or remove roles below your own, the last owner can't be
  removed or demoted, invites expire, every role change is audited, and TOTP is required for owners. Owners manage
  everyone, other owners included. The rules are in `src/lib/roles.ts` (pure) and enforced in
  `src/server/auth/roles.ts`, which re-reads the actor's role from D1 (the session cookie cache can be 5 minutes stale).
  Sign-up is disabled: users come only from invites or `admin:bootstrap`.

### Fixtures rules (agreed with the organiser in the demo; keep them)

These come from `/home/jeremy/code/volleyball-registration-page/CLAUDE.md`, whose `src/lib` is being ported here.

- Each team plays exactly once per night. With an odd number of teams, one team has a bye each week.
- Every pair meets `settings.meetings` times.
- **Duty** (refereeing) always goes to a team playing in an _adjacent_ session that night, never the bye team. Duties
  are shared evenly across the season, and where possible a duty team refs on the same court it plays on. (Not for
  TVSL, which has no duty.)
- **Finals:** a semi-final week, then a finals week, with only the top 4 playing.
  - Semi-final week runs back to back: SF1 is 2nd v 3rd (refereed by 4th), then SF2 is 1st v 4th (refereed by the SF1
    loser).
  - Finals week runs the Grand Final first, then 3rd place (refereed by the GF loser).
  - Finals use placeholder refs (`{ label: '2nd' }`, `'Winner SF1'` …) that `makeResolver` turns into teams.
- Ladder points are win 3, draw 2, loss 1 by default (`DEFAULT_POINTS`), editable per season.
- `Game.court` is a slot _position_, not a court name. The name comes from the week's court override for that slot,
  falling back to the season's default court for that position. Overrides belong to the slot, not the game, so a game
  dragged into a slot plays on that slot's court.
- **Draft vs published results:** `result` is what's being typed in; `publishedResult` is what counts. Standings, finals
  seeding, the website and exports only ever read published results. Results are published per match day.
- A published season's draw is locked; changes to settings that would need a new draw (teams, session count, meetings,
  finals, duty on/off) are blocked. Court names can still change.
- **TVSL / no duty:** `settings.duty === false` (missing = on). The scheduler then skips duty assignment and the
  duty-feasibility filter in `sessionPatterns`, finals get `duty: null`, and `validate()` doesn't ask for duty.
- **Set scores:** `Result.sets` (`[home, away][]`, up to `MAX_SETS` = 5). When present, sets won and P+/P− are derived
  from them (`effectiveResult`/`completeResult`); always read results through those, not `r.home` directly.
- **Scheduler** (`fixtures/scheduler.ts`): a circle-method round robin repeated `meetings` times; `sessionPatterns` allows only
  splits where every game can get an adjacent-session ref (bipartite matching in `dutyFeasible`); simulated annealing
  moves and swaps games between sessions and re-solves each night's duties optimally with the Hungarian algorithm
  (`minCostAssignment`); then courts are assigned so duty teams stay on their court, and dates are laid out around
  skipped weeks. Generation is seeded (`settings.seed`, mulberry32), so a seed reproduces a draw. If you change the
  optimiser, run a wide seed sweep, not just the tests. It runs **in the browser**, never in the Worker.
- NSW public holidays on game nights are suggested as skip weeks (`holidays.ts`); the organiser confirms each one.
- Dialogs use native `<dialog>`. A dialog's `close` event fires after React may already have unmounted it, so clear
  parent state in the action handler, not in `onClose`.
