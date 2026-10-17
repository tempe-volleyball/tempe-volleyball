# Seasons, draws and results API

The server half of Phase 4: what the admin's fixtures and results screens call. Everything lives under `/api/admin`,
answers JSON, and is implemented in `src/server/competition/` (routes in `src/pages/api/admin/{leagues,seasons,teams}`).
The fixtures library (`src/lib/fixtures`) is the shared vocabulary: the API sends and takes its `Competition`,
`Settings`, `Week`, `Game`, `Ref` and `Result` types, so the browser can run `generate()`, `validate()`, `standings()`,
`courtClashes()` and the edit helpers on exactly what it loaded.

## Basics

- **Auth.** The middleware answers `401 { error: 'unauthenticated' }` without a session, and `403 { error: 'totp_required' }`
  for owners without TOTP. Unsafe methods must be same-origin (`403 bad_origin` otherwise). `src/admin/api.ts`'s `api()`
  already does all of this.
- **Roles.** Editors can read everything here and enter, publish and undo **results**. Admins (and owners) can also
  create and change seasons, settings, draws, team lists, teams, status and ladder adjustments. Below the required role:
  `403 { error: 'forbidden' }`. On writes the role is re-read from D1, so a demotion takes effect at once.
- **Errors** are `{ error: code, message }` with the status below; `message` is written for the organiser and can be
  shown as is. Some carry extra fields (`issues` on `invalid_draw` and on some `not_ready`). Note that `api()` in
  `src/admin/api.ts` currently drops extra fields; read the body yourself (or extend `ApiError`) to show `issues`.
- **Cache.** Writes that change the public site return `cache: 'purged' | 'disabled' | 'failed' | 'nothing'`, as the
  content API does. `disabled` is normal on `*.workers.dev`; `failed` means the public page may lag up to 5 minutes.
- **Times.** Dates are `YYYY-MM-DD` and times `HH:MM`, Sydney local. Instants (`updatedAt`, `publishedAt`,
  `resultsPublishedAt`) are UTC ISO strings, except inside `competition`, where the lib uses epoch milliseconds for
  `updatedAt` and `publishedAt`.
- **The server never generates a draw.** `generate()` runs in the browser (ideally in a Web Worker); the server checks
  and stores what it's sent.

## Concurrency

Every write takes a `baseUpdatedAt`: the `updatedAt` the client last loaded. If someone saved since, the write is
refused with `409 conflict` and nothing changes. Reload, re-apply, retry.

| What you're changing                                | Token                                             |
| --------------------------------------------------- | ------------------------------------------------- |
| settings, draw, team list, status, deleting a draft | `season.updatedAt`                                |
| a match day's results (save, publish, undo)         | `matchDays[weekId].updatedAt` from the season GET |
| ladder adjustments, teams                           | none (small, independent rows)                    |

Every successful write returns the new token(s); use them for the next write without reloading:

- season writes return a new `season.updatedAt` (and the full view, except `PUT /draw`, which returns `season` plus
  new `matchDays` tokens);
- results writes return `matchDay.updatedAt`.

Results and season tokens are independent, so an editor entering results doesn't conflict with an admin changing
settings. The exception: a court change on a published draw re-stamps the **days whose courts changed** (and only
those), so results being typed for such a day will get a `409` on the next save.

## IDs

- The lib's `uid()` is now `crypto.randomUUID()`. Week ids become `match_days.id` and game ids `matches.id`, so a
  draw keeps its ids through save and reload, and results stay attached to their matches.
- Team ids are `teams.id`. Imported rows have UUID-shaped ids too (`stableId()` in `scripts/wp/ids.ts`).
- The server accepts ids matching `/^[A-Za-z0-9_-]{1,64}$/`, unique within the draw. An id already used by another
  season is a `400`: regenerate to get fresh ones.
- `competition.id` is the season id.

## Endpoints

| Method and path                                           | Role   | Body                                                           | Returns                                |
| --------------------------------------------------------- | ------ | -------------------------------------------------------------- | -------------------------------------- |
| `GET /api/admin/leagues`                                  | editor |                                                                | `{ leagues: LeagueListItem[] }`        |
| `POST /api/admin/seasons`                                 | admin  | `{ leagueId, year, quarter, startDate?, name?, copyFrom? }`    | `SeasonView` (201)                     |
| `GET /api/admin/seasons/:id`                              | editor |                                                                | `SeasonView`                           |
| `PATCH /api/admin/seasons/:id`                            | admin  | `{ baseUpdatedAt, settings: SettingsPatch }`                   | `SeasonView & { cache }`               |
| `DELETE /api/admin/seasons/:id?baseUpdatedAt=…`           | admin  | (or `{ baseUpdatedAt }`)                                       | `{ ok: true }`                         |
| `PUT /api/admin/seasons/:id/draw`                         | admin  | `{ baseUpdatedAt, weeks, generatedFrom?, edited?, settings? }` | `{ season, issues, matchDays, cache }` |
| `PUT /api/admin/seasons/:id/teams`                        | admin  | `{ baseUpdatedAt, teamIds }`                                   | `SeasonView`                           |
| `POST /api/admin/seasons/:id/status`                      | admin  | `{ baseUpdatedAt, status }`                                    | `SeasonView & { cache }`               |
| `GET /api/admin/seasons/:id/clashes?from=&to=`            | editor |                                                                | `ClashDraws`                           |
| `PUT /api/admin/seasons/:id/match-days/:dayId/results`    | editor | `{ baseUpdatedAt, results: { [matchId]: Result \| null } }`    | `{ matchDay }`                         |
| `POST /api/admin/seasons/:id/match-days/:dayId/publish`   | editor | `{ baseUpdatedAt }`                                            | `{ matchDay, cache }`                  |
| `POST /api/admin/seasons/:id/match-days/:dayId/undo`      | editor | `{ baseUpdatedAt }`                                            | `{ matchDay }`                         |
| `GET /api/admin/seasons/:id/adjustments`                  | editor |                                                                | `{ adjustments }`                      |
| `POST /api/admin/seasons/:id/adjustments`                 | admin  | `{ teamId, points, reason }`                                   | `{ adjustments, cache }` (201)         |
| `PATCH /api/admin/seasons/:id/adjustments/:adjustmentId`  | admin  | `{ points?, reason? }`                                         | `{ adjustments, cache }`               |
| `DELETE /api/admin/seasons/:id/adjustments/:adjustmentId` | admin  |                                                                | `{ adjustments, cache }`               |
| `GET /api/admin/teams`                                    | editor |                                                                | `{ teams: TeamListItem[] }`            |
| `POST /api/admin/teams`                                   | admin  | `{ name }`                                                     | `{ team: TeamListItem }` (201)         |
| `PATCH /api/admin/teams/:id`                              | admin  | `{ name }`                                                     | `{ team, cache }`                      |

`:dayId` is a week id (`Week.id`). Holiday suggestions stay client-side: `holidaysOnGameNights(startDate, weeks)` in the lib.

### Shapes

```ts
type LeagueListItem = League & {
  // League: id, code ('TNL' | 'FNL' | 'SNL' | 'SAL' | 'TVSL'), name, slug, weekday (0 = Sunday), format ('social' | 'super'),
  // defaultVenueId, sort, active, …
  venue: { id; name; slug } | null
  courts: { id; name; sort }[] // the venue's courts
  seasons: SeasonListItem[] // newest first: { id, leagueId, name, slug, year, quarter, startDate, status, publishedAt, updatedAt }
}

type SeasonView = {
  season: {
    id
    leagueId
    name
    slug
    year
    quarter
    startDate
    status: 'draft' | 'published' | 'archived'
    setsPerMatch: number // 2 social, 5 TVSL
    dutyEnabled: boolean
    generatedFrom: string | null // shapeKey() the draw was generated from
    edited: boolean
    publishedAt: string | null
    createdAt: string
    updatedAt: string // the concurrency token
  }
  league: { id; code; name; slug; weekday; format; defaultVenueId }
  venue: { id; name; slug } | null
  /** What court names can be: the league venue's courts, plus any other court this season already uses. */
  courts: { id; name; venueId; venueName; atLeagueVenue: boolean }[]
  /** The lib's Competition, ready for generate/validate/standings/makeResolver. */
  competition: Competition
  /** By week id. */
  matchDays: Record<string, { updatedAt: string; resultsPublishedAt: string | null }>
  /** By game id: what Game doesn't carry. status: 'scheduled' | 'played' | 'forfeit' | 'cancelled'. */
  matches: Record<string, { status; startTime: string | null; courtId: string | null }>
  adjustments: { id; teamId; points; reason; createdAt; updatedAt }[]
}
```

`competition` details:

- `settings.name` and `settings.startDate` are the season's; `settings.teams` is the season's team list in order;
  `settings.points` and `settings.duty` are always set; `settings.courts` are **court names** per slot position.
- `weeks` is `null` until a draw is saved. Weeks are sorted by date. Skipped weeks have `kind: 'skip'`, `matchDay: 0`
  and a `note`.
- `game.result` is the **draft** result, `game.publishedResult` the published one (what the ladder and site use).
- `week.courtOverrides` are **court names** keyed by `slotKey(session, position)`. For imported seasons they also
  include courts that only show in the matches (SportsPress stored a court per game).
- `status` is the lib's `'draft' | 'published'`; an **archived** season shows as `'published'` there (its draw is
  locked too). Use `season.status` for the real one.
- Placeholders (`{ label: '1st' }`, `'Winner SF1'`, imported `'TBC'`) are `Ref`s, never text in a title.

```ts
/** PATCH settings. Every field optional; only what's sent changes. A whole lib Settings object is accepted too. */
type SettingsPatch = {
  name?: string // ≤ 80
  startDate?: string
  skipDates?: { date: string; reason: string }[] // ≤ 20, sorted by the server
  courts?: string[] // default court NAME per slot position (≤ 12); '' = none
  sessions?: string[] // 'HH:MM' (≤ 8)
  sessionMinutes?: number // 15–240
  meetings?: number // 1–4
  includeFinals?: boolean
  seed?: number
  points?: { win: number; draw: number; loss: number } // 0–10 each
  duty?: boolean
  setsPerMatch?: number // 1–5
  teams?: (string | { id: string })[] // only checked: must equal the current list, else 400 (use PUT /teams)
}

type ClashDraws = {
  venue: string | null // the league's venue id: use it as SeasonDraw.venue for your own draw too
  from: string | null
  to: string | null
  draws: SeasonDraw[] // other seasons (any status) at the same venue with match days in [from, to], ≤ 10
}
```

### Creating a season

`POST /api/admin/seasons { leagueId, year, quarter, startDate?, name?, copyFrom? }`

- Always a **draft**. Slug `tnl-q1-2027`, name `TNL Q1 2027` (override with `name`).
- `startDate` defaults to the league's first game night in the quarter (Q1 starts 1 January).
- `copyFrom`: `'latest'` (default) copies the team list and settings (sessions, session length, meetings, finals,
  default courts, points, sets per match, duty) from the league's newest season; a season id copies from that one
  (same league only); `null` starts from the league format's defaults. A copy gets a **new seed** and no skip dates.
- `409 season_exists` if the league already has that quarter.

### Settings

`PATCH /api/admin/seasons/:id { baseUpdatedAt, settings }`

- Court names are mapped to court ids: an unchanged name keeps its court; otherwise courts the season already uses
  win, then the league's venue, then any court. An unknown name is `400`.
- If a draw exists, matches follow the new session times and default courts (slot overrides stay). The draw itself
  isn't touched, so after changing `startDate` or `skipDates` on a draft with a draw, send the re-laid weeks
  (`withSettings()`) **and** the settings together to `PUT /draw`.
- Published seasons: changing `startDate`, `skipDates`, `meetings`, `includeFinals`, `seed`, `duty`, `setsPerMatch`,
  the number of sessions or the number of courts is `409 draw_locked`. Name, session times, session length, points
  and default courts can change.

### Team list

`PUT /api/admin/seasons/:id/teams { baseUpdatedAt, teamIds }` replaces a **draft** season's teams, in that order
(the order `shapeKey()` sees, so keep it stable or the draw goes stale). Published: `409 draw_locked`. Teams must
exist (create them with `POST /api/admin/teams`). It doesn't touch an existing draw: if it's now stale
(`isStale(competition)`), regenerate.

### Saving the draw

`PUT /api/admin/seasons/:id/draw { baseUpdatedAt, weeks: Week[] | null, generatedFrom?, edited?, settings? }`

- **Draft:** `weeks` replaces every match day and match (ids kept). `null` clears the draw. Send `generatedFrom:
shapeKey(settings)` after generating and `edited: true` after hand edits, as the lib's `withGenerated()` /
  edit flow sets them. `settings` (a `SettingsPatch`) is saved in the same batch.
- **Published:** send the whole draw back; only **court overrides** may differ (plus allowed `settings`). Anything
  else (who plays whom, sessions, positions, dates, duty, titles) is `409 draw_locked`. Results are untouched.
- **Checks:** shape (types, limits, unique ids and dates, slot keys like `"0:1"`), every team is in the season,
  sessions and positions exist, then the lib's `validate()`. Any error-level issue is `422 invalid_draw` with
  `issues: Issue[]` (the lib's type, with `weekId`/`gameIds` to highlight). Warnings don't block and come back in
  `issues`. On a published season only errors the change introduces block (imported seasons have old ones).
- Ignored in the payload: `result`, `publishedResult`, `resultsPublishedAt`.
- Limits: ≤ 30 weeks, ≤ 40 games a week, ≤ 160 games (a 12-team double round robin with finals is 136).
- Returns `{ season, issues, matchDays }` (new tokens), not the full view: the client already has the weeks.

### Status

`POST /api/admin/seasons/:id/status { baseUpdatedAt, status }`

| From → to            | Rule                                                                                                                                         | Audit              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| draft → published    | `settingsErrors()` clean, a draw with games, not stale (`generatedFrom === shapeKey(settings)`), no error-level issues; else `422 not_ready` | `season.publish`   |
| published → draft    | only while no results exist (draft or published); else `409 has_results`                                                                     | `season.unpublish` |
| published → archived | any time; the season becomes read-only                                                                                                       | `season.archive`   |
| archived → published | any time                                                                                                                                     | `season.unarchive` |
| anything else        | `409 bad_transition`                                                                                                                         |                    |

The public site shows a league's newest **published** season (drafts never), falling back to its newest archived one.

`DELETE /api/admin/seasons/:id` deletes a **draft** only (`409 not_draft` otherwise), with its draw.

### Results

Results go one match day at a time and need a **published** season (`409 season_not_published` on drafts,
`409 season_archived` on archived ones). Skipped weeks are `400`.

`PUT …/match-days/:dayId/results { baseUpdatedAt, results: { [matchId]: Result | null } }`

- Saves **draft** results only; the public site doesn't change. Matches left out are untouched; `null` (or an
  all-blank result) clears one. Every match must be on that day.
- `Result` is the lib's: `{ home, away, homePoints?, awayPoints?, sets? }`. With `sets`, sets won and point totals
  are derived from them (`effectiveResult`) and what's stored always agrees. Checked: whole numbers ≥ 0, set points
  ≤ 99, totals ≤ 999, `setScoresProblem(sets, setsPerMatch)` (so at most 2 sets in social leagues, 5 in TVSL), and
  `home + away ≤ setsPerMatch`.

`POST …/match-days/:dayId/publish { baseUpdatedAt }`

- Needs a complete draft result for every game on the day (the lib's `publishProblem()`), and finals can't be draws:
  otherwise `422 not_ready` with the lib's message.
- Copies the day's draft results over its published ones, stamps `resultsPublishedAt` (the ladder's "Updated" line),
  marks scheduled games `played`, audits `results.publish` and purges the season, its league and the ladder widgets.
- Republishing after edits works the same way. `weekResultsState(week)` tells the UI which button to show.

`POST …/match-days/:dayId/undo { baseUpdatedAt }` throws away unpublished edits (draft := published).

All three return `{ matchDay: { id, updatedAt, resultsPublishedAt } }`. Keep the lib's `Week` in sync locally
(`setResult`, `publishWeekResults`, `undoWeekResultChanges`) or reload the season.

### Ladder adjustments

`POST|PATCH|DELETE …/adjustments`: `points` is a non-zero whole number from −100 to 100 (negative = penalty),
`reason` is required (≤ 200). The team must be in the season. Each change audits `ladder.adjust` and returns the full
list. The public ladder is `ladderRows(competition, adjustments)` in `src/server/competition/adapter.ts`, the lib's
`standings()` plus these. Imported seasons have adjustments with reason `wp-import reconciliation`: leave them alone
unless the organiser asks.

### Teams

`GET /api/admin/teams` lists all teams (88 imported) sorted by name, each with `seasons` (how many it's been in)
and `lastSeason`. `POST` creates one (`409 team_exists` for a name that differs only in case); its slug is made from
the name, numbered if taken. `PATCH` renames: the name changes everywhere (ladders, fixtures, archived seasons), the
slug doesn't (old `/team/<slug>/` URLs keep redirecting), and every public page is purged.

### Court clashes

`GET /api/admin/seasons/:id/clashes?from=&to=` returns the other seasons' draws at this league's venue with match
days in the range (default: the span of this season's saved draw; pass the range of an unsaved draw). Then:

```ts
const { venue, draws } = await api<ClashDraws>(`/api/admin/seasons/${id}/clashes?from=${first}&to=${last}`)
const clashes = courtClashes([{ seasonId: id, label: name, venue: venue ?? '', settings, weeks }, ...draws])
```

## Error codes

| Status | `error`                | When                                                                             |
| ------ | ---------------------- | -------------------------------------------------------------------------------- |
| 400    | `invalid_input`        | Bad or missing field, unknown court name, outsider match id, bad id …            |
| 401    | `unauthenticated`      | No session (middleware)                                                          |
| 403    | `forbidden`            | Role too low                                                                     |
| 404    | `not_found`            | Season, match day, adjustment or team doesn't exist                              |
| 409    | `conflict`             | `baseUpdatedAt` is stale                                                         |
| 409    | `draw_locked`          | Changing a published season's draw, team list or draw-shaping settings           |
| 409    | `season_archived`      | Any write to an archived season                                                  |
| 409    | `season_not_published` | Results on a draft season                                                        |
| 409    | `season_exists`        | Creating a quarter the league already has                                        |
| 409    | `has_results`          | Unpublishing a season with results                                               |
| 409    | `bad_transition`       | e.g. draft → archived                                                            |
| 409    | `not_draft`            | Deleting a published or archived season                                          |
| 409    | `team_exists`          | Team name taken (case-insensitive)                                               |
| 422    | `invalid_draw`         | The draw has error-level issues; body has `issues: Issue[]`                      |
| 422    | `not_ready`            | Season or match day can't be published yet (message says why; may have `issues`) |

## Audit actions

`season.create`, `season.update`, `season.draw_save`, `season.teams`, `season.publish`, `season.unpublish`,
`season.archive`, `season.unarchive`, `season.delete`, `results.publish`, `ladder.adjust`, `team.create`,
`team.rename`. Draft result saves and undo aren't audited (nothing public changes). The audit screen
(`src/admin/screens/Audit.tsx`) needs labels for the new ones.

## Free-plan budget

Measured in `src/server/competition/seasons.test.ts` with the test DB's query counter (each statement in a batch
counts), plus 1 for the route's role check:

| Request                                               | D1 queries |
| ----------------------------------------------------- | ---------- |
| `GET` season                                          | 9          |
| `PUT /draw`, 12 teams (13 weeks, 70 games)            | 23         |
| `PUT /draw`, 12 teams × 2 meetings (136 games)        | 33         |
| `PUT /draw`, published (courts only, imported season) | 10         |
| results save / publish                                | 8 / 10     |
| clashes                                               | 8          |

Every statement binds ≤ 100 parameters (multi-row inserts are chunked by `chunkByParams()`), and each write is one
`db.batch()` (one transaction). The server's CPU work is shape checks and one `validate()` pass.
