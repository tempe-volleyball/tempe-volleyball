# Seasons, draws and results API

The server half of Phase 4: what the admin's fixtures and results screens call. Everything lives under `/api/admin`,
answers JSON, and is implemented in `src/server/competition/` (routes in `src/pages/api/admin/{leagues,seasons,teams}`).
The fixtures library (`src/lib/fixtures`) is the shared vocabulary: the API sends and takes its `Competition`,
`Settings`, `Week`, `Game`, `Ref` and `Result` types, so the browser can run `generate()`, `validate()`, `standings()`,
`courtClashes()` and the edit helpers on exactly what it loaded.

Leagues themselves (create, edit, status, delete), training, development, events, categories and venues are in
[programmes.md](programmes.md).

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
| a match day's results (save, publish, undo, status) | `matchDays[weekId].updatedAt` from the season GET |
| a whole night, withdrawing or reinstating a team    | `season.updatedAt`                                |
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

| Method and path                                           | Role   | Body                                                                                                           | Returns                                     |
| --------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `GET /api/admin/leagues`                                  | editor |                                                                                                                | `{ leagues: LeagueListItem[] }`             |
| `POST /api/admin/seasons`                                 | admin  | `{ leagueId, year, quarter, startDate?, name?, copyFrom? }`                                                    | `SeasonView` (201)                          |
| `GET /api/admin/seasons/:id`                              | editor |                                                                                                                | `SeasonView`                                |
| `PATCH /api/admin/seasons/:id`                            | admin  | `{ baseUpdatedAt, settings: SettingsPatch }`                                                                   | `SeasonView & { cache }`                    |
| `DELETE /api/admin/seasons/:id?baseUpdatedAt=…`           | admin  | (or `{ baseUpdatedAt }`)                                                                                       | `{ ok: true }`                              |
| `PUT /api/admin/seasons/:id/draw`                         | admin  | `{ baseUpdatedAt, weeks, generatedFrom?, edited?, settings? }`                                                 | `{ season, issues, matchDays, cache }`      |
| `PUT /api/admin/seasons/:id/teams`                        | admin  | `{ baseUpdatedAt, teamIds }`                                                                                   | `SeasonView`                                |
| `POST /api/admin/seasons/:id/status`                      | admin  | `{ baseUpdatedAt, status }`                                                                                    | `SeasonView & { cache }`                    |
| `GET /api/admin/seasons/:id/clashes?from=&to=`            | editor |                                                                                                                | `ClashDraws`                                |
| `PUT /api/admin/seasons/:id/match-days/:dayId/results`    | editor | `{ baseUpdatedAt, results: { [matchId]: Result \| null } }`                                                    | `{ matchDay }`                              |
| `POST /api/admin/seasons/:id/match-days/:dayId/publish`   | editor | `{ baseUpdatedAt }`                                                                                            | `{ matchDay, cache }`                       |
| `POST /api/admin/seasons/:id/match-days/:dayId/undo`      | editor | `{ baseUpdatedAt }`                                                                                            | `{ matchDay }`                              |
| `POST …/match-days/:dayId/matches/:matchId/status`        | editor | `{ baseUpdatedAt, status, note?, forfeitedBy? }` (see Game statuses)                                           | `{ matchDay, match, result?, cache }`       |
| `PATCH …/match-days/:dayId/matches/:matchId`              | editor | `{ baseUpdatedAt, referee }` (match day token)                                                                 | `{ matchDay, match, cache }`                |
| `POST /api/admin/seasons/:id/matches/:matchId/move`       | admin  | `{ baseUpdatedAt, toWeekId \| date, session, position }` or `{ baseUpdatedAt, action: 'undo' }` (season token) | `SeasonView & { warnings, created, cache }` |
| `POST …/match-days/:dayId/night`                          | admin  | `{ baseUpdatedAt, action, note?, pushBack? }` (season token)                                                   | `SeasonView & { cache }`                    |
| `POST /api/admin/seasons/:id/teams/:teamId/withdraw`      | admin  | `{ baseUpdatedAt, reason, cancelFixtures?, from? }`                                                            | `WithdrawResult & { cache }`                |
| `POST /api/admin/seasons/:id/teams/:teamId/reinstate`     | admin  | `{ baseUpdatedAt }`                                                                                            | `ReinstateResult & { cache }`               |
| `GET /api/admin/matches?from=&to=&league=&season=&team=…` | editor |                                                                                                                | `MatchList`                                 |
| `GET /api/admin/seasons/:id/adjustments`                  | editor |                                                                                                                | `{ adjustments }`                           |
| `POST /api/admin/seasons/:id/adjustments`                 | admin  | `{ teamId, points, reason }`                                                                                   | `{ adjustments, cache }` (201)              |
| `PATCH /api/admin/seasons/:id/adjustments/:adjustmentId`  | admin  | `{ points?, reason? }`                                                                                         | `{ adjustments, cache }`                    |
| `DELETE /api/admin/seasons/:id/adjustments/:adjustmentId` | admin  |                                                                                                                | `{ adjustments, cache }`                    |
| `GET /api/admin/teams`                                    | editor |                                                                                                                | `{ teams: TeamListItem[] }`                 |
| `POST /api/admin/teams`                                   | admin  | `{ name }`                                                                                                     | `{ team: TeamListItem }` (201)              |
| `PATCH /api/admin/teams/:id`                              | admin  | `{ name }`                                                                                                     | `{ team, cache }`                           |
| `POST /api/admin/teams/:id/merge`                         | admin  | `{ mergeId }`                                                                                                  | `{ team, merged, seasons, cache }`          |

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
  the number of sessions or the number of courts is `409 draw_locked`. Name, session times, session length, points,
  default courts and the ladder rules below can change.
- **Ladder rules** (Setup → Ladder rules). Both only affect the ladder, so they can change on published seasons too:
  - `tieBreaks: TieBreakRule[]` is the order after ladder points. The rules are `setDiff`, `setRatio` (S+ ÷ all
    sets), `setsFor`, `pointDiff`, `pointRatio` (P+ ÷ all points), `pointsFor`, `wins`, `headToHead` (ladder points
    earned in the games between the teams still tied at that point, so it works for three-way ties) and `name`,
    which is always last (`tieBreakOrder()` cleans the list). Missing means `DEFAULT_TIE_BREAKS` (`setDiff`,
    `pointDiff`, `wins`, `name`), the order before Phase 6. Ladder adjustments count before any tie-break.
  - `withdrawn: { ladder: 'mark' | 'hide', results: 'keep' | 'void', fixtures?: 'bye' | 'cancelled' }`. A withdrawn
    team is shown last and marked "(withdrawn)", or left off. Its played games still count, or count for nobody
    (both sides). Its cancelled games show as cancelled, or as a bye for the opponent. Missing means
    `{ mark, keep, cancelled }` (`withdrawnPolicy()`).
  - `levelSets: 'draw' | 'points'` is the 1–1 rule: a match level on sets is a draw (missing; the demo's rule), or
    decided on total rally points as SportsPress did (level on points too is still a draw). It's the lib's
    `outcome(result, levelSetsRule(settings))`, used by `standings()`, head to head, `makeResolver()` and the finals
    check in `publishProblem()` (a 1–1 final decided on points can publish).
  - `forfeit: { winnerSets, loserSets, winnerSetPoints, loserSetPoints, lossPoints }` is what a game marked forfeit
    counts as (`forfeitRule(settings, setsPerMatch)` fills in the defaults: every set the winner needs 25–0, so 2–0
    social and 3–0 best of 5, and `lossPoints: true`). `winnerSets + loserSets ≤ setsPerMatch` and the winner gets more
    sets (`forfeitRuleProblem()`, else `400`). Set points both 0 records the sets with no set scores. With
    `lossPoints: false` the losing side of a game whose status is `forfeit` gets 0 ladder points instead of the loss
    points, on every published forfeit, straight away.
  - A season copied from another (`copyFrom`) keeps all four.

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
- Ignored in the payload: `result`, `publishedResult`, `resultsPublishedAt`, and the fields the server fills in:
  `Game.status`, `Game.statusNote`, `Week.status`, `Week.originalDate`.
- `source: 'csv'` (drafts only) marks a draw that came from a CSV import. It's audited as `fixtures.import`
  instead of `season.draw_save`. See CSV fixture import below.
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
- `Result` is the lib's: `{ home, away, homePoints?, awayPoints?, sets?, outcome?, note? }`. With `sets`, sets won and
  point totals are derived from them (`effectiveResult`) and what's stored always agrees. Checked: whole numbers ≥ 0,
  set points ≤ 99, totals ≤ 999, `setScoresProblem(sets, setsPerMatch)` (so at most 2 sets in social leagues, 5 in
  TVSL), and `home + away ≤ setsPerMatch`.
- **Decided by hand:** `outcome: 'home' | 'away' | 'draw'` (stored in `match_results.outcome`) is who won whatever the
  scores say, e.g. a walkover; `note` (≤ 200, `match_results.note`) is why, and is required with an outcome (`400`
  without). A result can be just an outcome: missing sets and points then count as 0 (`completeResult`). The ladder,
  head to head and finals use it; the public fixtures show "W - L" / "L - W" / "Draw" when there are no sets, and
  "<team> awarded the win: <note>" (or "Declared a draw: …") under the result. Publish copies both columns.
- A result for a **cancelled** game is `400` (clearing it with `null` is fine).

`POST …/match-days/:dayId/publish { baseUpdatedAt }`

- Needs a complete draft result for every game on the day that isn't cancelled (the lib's `dayPublishProblem()`,
  which is `publishProblem()` without the cancelled games), and finals can't be draws: otherwise `422 not_ready` with
  the lib's message. A day where every game was cancelled can be published.
- Cancelled games publish **without** a result, so a result they had before leaves the ladder.
- Copies the day's draft results over its published ones, stamps `resultsPublishedAt` (the ladder's "Updated" line),
  marks scheduled games `played`, audits `results.publish` and purges the season, its league and the ladder widgets.
- Republishing after edits works the same way. `weekResultsState(week)` tells the UI which button to show.

`POST …/match-days/:dayId/undo { baseUpdatedAt }` throws away unpublished edits (draft := published, except that
cancelled games stay blank).

All three return `{ matchDay: { id, updatedAt, resultsPublishedAt } }`. Keep the lib's `Week` in sync locally
(`setResult`, `publishWeekResults`, `undoWeekResultChanges`) or reload the season.

### Game statuses

`POST …/match-days/:dayId/matches/:matchId/status { baseUpdatedAt, status, note? }` (editor), with `status` one of:

| `status`    | Stored as                                               | Effect                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cancelled` | `cancelled`                                             | Its draft result is deleted; it needs no result to publish the day; the next publish drops its published result (if any)                                                                                                                                                                                                                                                           |
| `postponed` | `postponed`                                             | To be replayed. Like cancelled, except a draft result is kept for when it's played                                                                                                                                                                                                                                                                                                 |
| `tbd`       | `tbd`                                                   | Date or time still to be decided. Same rules as postponed                                                                                                                                                                                                                                                                                                                          |
| `forfeit`   | `forfeit`                                               | Labels the game "(forfeit)" on the fixtures. With `forfeitedBy: 'home' \| 'away'`, the draft result becomes the season's forfeit score (`forfeitResult(forfeitRule(settings), side)`, decided by hand for the other side, note "Forfeit") and is returned as `result`; without it the result is left alone. Either way it's an ordinary result to publish, and can be edited first |
| `played`    | `played` if it has a published result, else `scheduled` | Undoes any of the above                                                                                                                                                                                                                                                                                                                                                            |

- `note` (≤ 200 characters) is the public reason ("Venue unavailable"). It's stored in `matches.status_note` and shown
  under the status on the fixtures. Leaving it out keeps the current note; `played` clears it.
- Cancelled, postponed and TBD are the lib's "off" statuses (`OFF_STATUSES`, `isOffStatus()`). No result can be saved
  for an off game (`400`), and off games don't hold up publishing their match day.
- The token is the match day's (`matchDays[weekId].updatedAt`), like results: a status change bumps it, and a stale one
  is `409 conflict`. Season must be published and not archived; skipped weeks `400`, unknown match `404`.
- The public fixtures read `matches.status` directly (the status in the Results column when there's no published
  result, the note under it, "(forfeit)" under a score), so this purges the season, its league and the ladder
  widgets straight away.
- Audited as `match.status` (status and note, before and after). Sending the status and note it already has does
  nothing (no audit, no purge).
- Returns `{ matchDay, match: { id, status, statusNote }, cache }`. The client keeps `SeasonView.matches[id]` in step
  and, for `cancelled`, clears the game's `result` locally.
- The ladder (`standings()`) only reads the status for forfeits (the season's `forfeit.lossPoints`): an off game simply
  has no published result. `progress()` and `isFinished()` skip cancelled games.

### Referee

`PATCH …/match-days/:dayId/matches/:matchId { baseUpdatedAt, referee }` (editors, match day token) sets
`matches.referee` (free text ≤ 80, spaces tidied; `''` or `null` clears it). It's `Game.referee` in the view, "Referee:
…" on the public fixtures and in calendar feeds. Season must be published and not archived. Audited as `match.update`;
purges the season's pages. Returns `{ matchDay, match: { id, referee }, cache }`.

### Moving one game to another night

`POST /api/admin/seasons/:id/matches/:matchId/move { baseUpdatedAt, toWeekId | date, session, position }` (admins,
published seasons, season token) moves one game. The plan is the lib's `moveToNight(settings, weeks, gameId, target)`
(`src/lib/fixtures/move.ts`), which the admin previews with:

- The game can't have a published result. The target is another night of this season by id (not a week off, not a
  postponed or cancelled night), or a `date`: the season's night on that date, or a **new catch-up night** (same kind
  and match day number as the game's night; it doesn't add a week to "Week X of Y").
- The slot (`session`, `position` within the season's sessions and courts) must be free with a court, and no other
  game may use that court then. Refused: either team, or the duty team, already plays at that time. Warnings (returned
  as `warnings`): a double header, or a duty team that doesn't play that night.
- Then the other leagues at the venue that night are checked with `courtClashes()`; a clash is refused.
- The game keeps its id, draft result, duty and title. A postponed or TBD game becomes scheduled (its note is cleared).
  `matches.original_match_day_id` keeps the night it was **first** on (moving it back there clears it). The view's
  `Game.originalWeekId` carries it; the old night lists the game as "Moved" ("Moved to 30/10/2026", fixture row kind
  `moved`, not a calendar event), the new one as "(moved from …)". Byes ignore moved games on both nights.
- One batch (32 queries in all, with the clash check), audited as `match.move` with the game's old night, slot, start time, court, status,
  note and original night.
- `{ baseUpdatedAt, action: 'undo' }` puts back the last move exactly (`match.move_undo`) and deletes a catch-up night
  it emptied; `409 cannot_undo` once the game has moved again, has a published result, or its old slot is taken.
- Errors: `409 cannot_move` with the reason; `409 season_not_published` on drafts (drag the game on the Fixtures tab
  instead); `409 conflict` on a stale token.

### A whole night (bulk postpone or cancel)

`POST …/match-days/:dayId/night { baseUpdatedAt, action, note?, pushBack? }` is for admins on published seasons (a
draft is `409 season_not_published`, an archived season `409 season_archived`). The token is the **season's**
`updatedAt`, because a push-back moves many match days. The season and every match day it touches get new tokens,
and the response is the whole `SeasonView`. `note` is the public reason. Each action is one `db.batch()` and is
audited.

- **`postpone` / `cancel`** sets `match_days.status` and every game on the night that doesn't already have that
  status. The note goes on the night. Cancel also deletes the games' draft results. The date stays. Audited as
  `match_day.postpone` / `match_day.cancel`, with the night's old status and note and each game's old status.
- **With `pushBack: true`** the games aren't marked. The lib's `pushBack()` (`src/lib/fixtures/calendar.ts`) moves
  this night and every later playing night (finals too) at least a week later. They keep their order and match day
  numbers, and step over weeks off and `settings.skipDates`. The old date becomes a week off (kind `skip`, status
  postponed or cancelled, note "Postponed – reason") and is added to `skipDates`. Skip dates the moved nights now
  step over get a week off of their own. A moved night keeps `original_date`, the first date it had. Games keep their
  ids, so results, duty and courts stay attached. Audited as `season.push_back` on the new week off, recording every
  moved night's old date and original date and the old `skipDates`.
- **`restore`** on a postponed or cancelled night puts it back to scheduled, each game back to the status the audit
  log recorded (or `played`/`scheduled`), and the old note back. On a week off made by a push-back it deletes that
  week off (and any weeks off the push-back added), moves the nights back to their old dates and restores
  `skipDates`. Audited as `match_day.restore`.
- The admin previews the push-back with the same `pushBack()` in the browser; the server re-runs it on its own copy.
- Errors: `409 has_results` when the night already has published results (mark its games one at a time instead).
  `409 cannot_move` when a later night has published results (`pushBackProblem()` says which). `409 cannot_undo`
  when the moved nights have moved again or got published results since, or when the week off wasn't made by a
  push-back. `409 bad_transition` when restoring a night that isn't off.
- Dates move in two statements whatever the number of nights: all to a temporary `'~' || date`, then a `case` to the
  new dates. That way the `(season_id, date)` unique index never sees two nights on one date mid-batch.
- The public fixtures show the week off with its note, and "(moved from 22/10/2026)" under a moved night's date.

### Withdrawn teams

`POST …/teams/:teamId/withdraw { baseUpdatedAt, reason, cancelFixtures?, from? }` is for admins on published seasons
(on a draft, take the team off the team list instead). It sets `season_teams.withdrawn_at` and `withdrawn_reason`.
With `cancelFixtures` (default true), every game the team plays on or after `from` (default: today in Sydney) that has
no published result and isn't already off becomes `cancelled`, and its draft result is deleted. Games the team has
**duty** on are left alone and counted in `dutyGames`, so the admin can find another referee. Returns the view plus
`{ cancelled, dutyGames }`. Audited as `team.withdraw`, with the ids and old statuses of the games it cancelled.

`POST …/teams/:teamId/reinstate { baseUpdatedAt }` clears the withdrawal and puts back exactly the games the last
withdrawal cancelled, if they're still cancelled. Returns `{ restored }`. Audited as `team.reinstate`.

How a withdrawn team shows is the season's `settings.withdrawn` policy (see Settings), so it can change at any time
without touching the data.

### CSV fixture import

The fallback to the generator, for draft seasons. It all runs in the browser (`importFixturesCsv()` in
`src/lib/fixtures/csv-import.ts`, tested in Node). The admin pastes the CSV or picks a file (≤ 512 KB) and sees
every problem with its line number and a preview. "Use this draw" makes it the working copy, and Save sends the
ordinary `PUT /draw` with `source: 'csv'`.

- One row per game. Columns are found by their header, in any order or case: `Date` (YYYY-MM-DD or DD/MM/YYYY),
  `Time` (20:00, 8pm, 8:30 pm), `Home`, `Away`, `Court`, and optionally `Duty` (or Ref, Referee), `Stage` ("Semi
  Final 1", "Grand Final" …) and `Note`. Commas, tabs or semicolons; quoted fields are fine.
- A row with a date and no teams is a week off; its `Note`, or a "No games: reason" Stage, is the reason. Rows whose
  Stage is "Bye" are skipped, so the season's own CSV download imports as is. Finals placeholders go in brackets,
  `(1ST)` or `(Winner SF1)`, as the export writes them.
- Team and court names must match the season's teams and the known courts (case doesn't matter); an unknown name is
  a line error. The import also sets the settings the draw implies (start date, weeks off, session times, default
  courts by position, finals, meetings), so the draw isn't stale.
- Errors block "Use this draw": CSV errors, the lib's `validate()` errors (clashes, a team playing twice in a night,
  teams playing different numbers of games) and `settingsErrors()`. Warnings (no duty team, pairs meeting a different
  number of times, byes) are listed but don't block. A CSV draw meets the same bar as a generated one, so publishing
  works the same way.

### Cross-league match list

`GET /api/admin/matches?from=&to=&league=&season=&team=&venue=&court=&status=&drafts=1` (editors; the admin's
Matches screen) lists every game in the date range across all leagues. The range defaults to today plus six days and
is at most 366 days. Rows come in date, time and league order. Filters: league, season, team (playing **or** on
duty), venue (a game without a court counts as at its league's venue), court and status. Draft seasons are left out
unless `drafts=1`.

It returns `MatchList` (`src/server/competition/match-list.ts`): `{ from, to, rows: MatchListRow[], truncated,
options }`, with at most 500 rows (`truncated` says there were more). Each row has the night's status, the
published result and an `unpublished` flag for a draft result that hasn't been published. `options` holds the lists
the filters choose from. The admin links each row to `/admin/seasons/<seasonId>/results#results-<matchDayId>`, which
scrolls to that match day.

The games query runs on its own, outside `db.batch()`: D1's batch returns rows as objects keyed by column name, so
joined columns that share a name (`id`, `name` …) overwrite each other. A plain query reads raw arrays.

### Ladder adjustments

`POST|PATCH|DELETE …/adjustments`: `points` is a non-zero whole number from −100 to 100 (negative = penalty),
`reason` is required (≤ 200). The team must be in the season. Each change audits `ladder.adjust` and returns the full
list. The public ladder is `ladderRows(competition, adjustments)` in `src/server/competition/adapter.ts`, the lib's
`standings()` plus these. Imported seasons have adjustments with reason `wp-import reconciliation`: leave them alone
unless the organiser asks.

### Teams

`GET /api/admin/teams` lists all teams (88 imported) sorted by name, each with `seasons` (how many it's been in),
`lastSeason` and `history` (every season, newest first: `{ id, name, year, quarter, leagueId, leagueCode, status,
withdrawnAt }`). `POST` creates one (`409 team_exists` for a name that differs only in case); its slug is made from
the name, numbered if taken. `PATCH` renames: the name changes everywhere (ladders, fixtures, archived seasons), the
slug doesn't (old `/team/<slug>/` URLs keep redirecting), and every public page is purged.

`POST /api/admin/teams/:id/merge { mergeId }` merges the duplicate `mergeId` into team `:id` (Admin → Teams). Its
`season_teams`, matches (home, away and duty), ladder adjustments and enrolment groups move to `:id`, and it's deleted.
`409 same_season` when both were in one season. `:id` keeps its name and slug; the duplicate's team calendar feeds
(`/leagues/<league>/teams/<slug>.ics`, per league it played in) get 301 redirects to `:id`'s (the feed route follows
the redirects table when a team slug is unknown), and redirects that pointed at them are repointed. Its `wp_id` moves
to `:id` when `:id` has none. One batch of single-statement updates (2 parameters each), whatever the number of
games: 14 queries. Audited as `team.merge` (the duplicate's id, name, slug, wp id and seasons); purges the site.
Returns `{ team, merged: { id, name }, seasons, cache }`.

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
| 409    | `season_not_published` | Results, a whole-night action or a withdrawal on a draft season                  |
| 409    | `season_exists`        | Creating a quarter the league already has                                        |
| 409    | `has_results`          | Unpublishing a season with results; postponing a night with published results    |
| 409    | `cannot_move`          | Pushing nights back past one with published results; a game move that's refused  |
| 409    | `cannot_undo`          | Undoing a push-back or a game move after things changed since                    |
| 409    | `same_season`          | Merging two teams that played in the same season                                 |
| 409    | `bad_transition`       | e.g. draft → archived                                                            |
| 409    | `not_draft`            | Deleting a published or archived season                                          |
| 409    | `team_exists`          | Team name taken (case-insensitive)                                               |
| 422    | `invalid_draw`         | The draw has error-level issues; body has `issues: Issue[]`                      |
| 422    | `not_ready`            | Season or match day can't be published yet (message says why; may have `issues`) |

## Audit actions

`season.create`, `season.update`, `season.draw_save`, `season.teams`, `season.publish`, `season.unpublish`,
`season.archive`, `season.unarchive`, `season.delete`, `results.publish`, `match.status`, `ladder.adjust`,
`team.create`, `team.rename`, `match_day.postpone`, `match_day.cancel`, `match_day.restore`, `season.push_back`,
`team.withdraw`, `team.reinstate`, `fixtures.import`, `match.update` (referee), `match.move`, `match.move_undo`,
`team.merge`. Draft result saves and undo aren't audited (nothing public changes). The audit screen
(`src/admin/screens/Audit.tsx`) labels them all.

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
| whole night: postpone, cancel or restore              | 23         |
| whole night: push back or undo it (biggest season)    | 24–26      |
| withdraw or reinstate a team                          | 24         |
| move one game, with the clash check (undo)            | 32 (25)    |
| referee                                               | 9          |
| merge two teams                                       | 14         |
| match list                                            | 7          |

Every statement binds ≤ 100 parameters (multi-row inserts are chunked by `chunkByParams()`), and each write is one
`db.batch()` (one transaction). The server's CPU work is shape checks and one `validate()` pass.
