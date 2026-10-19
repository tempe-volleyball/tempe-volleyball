# Players API

What Admin → Players calls (docs/interest.md "Players", docs/admin.md §3.16). Routes are in
`src/pages/api/admin/players/`, the logic in `src/server/players/admin.ts` (tests in `admin.test.ts` next to it); the
shared core (`createInterest`, `matchPeople`) and the competition directory are `core.ts` and `directory.ts`.

**Admins and owners only**, with the role re-read from D1 on every request, GETs included (personal data; editors
get `403`). Bodies are capped at 32 KB (`PLAYER_BODY_LIMIT`). Responses are `no-store`.

Competition players (leagues and events) and training players (training and development) are separate rows
(`players.pool`): someone in both is two players, on purpose. Nothing here moves a player between pools.

## Lists

`GET /api/admin/players?pool=competition|training&q=&group=&league=&programme=&retired=hide|only|any&sort=name|newest|updated&page=`

- **Competition** is an SQL page too: each player's group is a CASE from `groupContext()` (`directory.ts`), the same
  SQL the season builder's player picker uses, so the two always agree: `group` = `interest` (New interest), `last`
  (Last season), `past` (Past players), `retired`, `other`, or `all` (default). With `league` the groups are for that
  league (its window: `lastSeason`, `interestSince`); without, across all leagues (each league's own window). `retired`
  applies to `all` only (Retired is its own group). `groupCounts` has the count per group with the search and retired
  filter applied (one `GROUP BY`). Search is SQL `LIKE` over name, email and phone (case-insensitive, not
  accent-insensitive, like training). Only the page's 50 players get their latest roster spot (`lastSpot`: in the
  league, else anywhere) and newest open EOI. Reads grow with the number of players, never with seasons of history:
  open EOIs and last season's roster are read once, "has played" is one index probe per player.
- **Training** is an SQL page: search, `programme` (has an enrolment in it), `retired`, sort. Each row has its
  enrolment count and latest enrolment's target label.

```ts
type PlayerList = {
  pool; rows: PlayerListItem[]; total; page; pages // 50 a page
  groupCounts: Record<'interest' | 'last' | 'past' | 'retired' | 'other' | 'all', number> | null
  league: { id; code; name } | null; lastSeason: { id; name; startDate } | null; interestSince: string | null
  programmes: { id; code; name; kind }[] // for the filter: leagues and events, or training and development
  truncated: false // always now (both pools page in SQL); kept for older admin bundles
  exportLimit: 5000 // the screen says when `total` is more than the CSV writes
}
type PlayerListItem = {
  id; firstName; lastName; email; phone; gender; retiredAt; createdAt
  group: PlayerGroup | null; lastSpot: RosterSpot | null; interest: { reference; kind; teamName; status; level; position; … } | null
  enrolments: number | null; lastEnrolment: { label; programmeName; createdAt } | null
}
```

`GET /api/admin/players/export.csv?<the list's query>`: every matching player (all pages, at most 5000,
`EXPORT_LIMIT`), in the list's order, with the group and last team for competition (two queries: the players with
their group, and one window over the rosters for each player's latest spot). When more match, the file is named
`…-first-5000.csv` and the response has `X-Export-Truncated: 1`. Formula-safe cells. Audited as `player.export` (with
`truncated`).

## One player

`GET /api/admin/players/:id` → `PlayerDetail`: the row (all columns) with `updatedByName`; `interests` (every EOI
they're on, with its programmes' statuses); `enrolments` (every registration: target label via the enrolment
helpers, programme, status, team or free agent, amount, paid, and `target: { kind, id }` for `/enrolments/<kind>/<id>`);
`rosters` (season, league, team, captain); `captainOf` (team entries); `history` (latest 20 audit rows); and
`references` (counts of what stops a delete).

`POST /api/admin/players` `{ pool, firstName, lastName, email?, phone?, gender?, birthYear?, suburb?, vnswNumber?,
guardianName?, guardianEmail?, guardianPhone?, emergencyContact?, notes?, force? }` → `201 PlayerDetail` (source
`admin`, audited `player.create` with the field names). Names ≤ 80 and required. Email is lower-cased and optional for
competition players (team members may not have one; stored as `''`, never matched on) but required for training
players (enrolment matches by it). Phone, gender (`male`, `female`, `non_binary`, `prefer_not_to_say`), year of birth
(1900 to this year), VNSW number (letters, digits, spaces, hyphens) and the guardian's email are checked. A player
with the same name (and email, or none) already in the pool is `409 duplicate` with `duplicates: [{ id, firstName,
lastName, email }]`, unless `force: true`.

`PATCH /api/admin/players/:id` `{ baseUpdatedAt?, …fields }` → `PlayerDetail`. With `baseUpdatedAt`, `409` if someone
saved since. Audited `player.update` with the names of the fields that changed.

`POST /api/admin/players/:id`:

- `{ action: 'retire' | 'unretire' }`: retired players are only in the Retired group and hidden from pickers unless
  asked for. Audited.
- `{ action: 'merge', mergeId, fillBlanks? }`: merges the duplicate `mergeId` into this player (same pool only), in
  one batch: the duplicate's live enrolments for a target this player already has a live enrolment for are cancelled
  ("Duplicate player merged: …") rather than deleted, so payments keep their registration; every registration, EOI
  membership and team captaincy moves over; roster rows for the same season and team are folded into this player's
  (captain if either was), the rest move; with `fillBlanks` (default on) this player's empty details are filled from
  the duplicate's and notes are joined; then the duplicate is deleted. Both on rosters of one season but in different
  teams is refused, `409 two_teams` with `seasons: [{ seasonId, seasonName, keepTeam, mergeTeam }]` (a player plays
  for one team a season: take one out of their team first); a roster change racing the merge is `409 conflict`
  (the one-team-per-season index). → `PlayerDetail & { merge: { registrationsMoved, registrationsCancelled,
interestsMoved, captaincies, rostersMoved, rosterDuplicatesDropped, filled } }`. Audited `player.merge` on the kept
  player in the same batch (first, so its counts are what then moved): `before` has the duplicate's id, initials,
  source and created date (not their name), `after` the counts and the names of the fields filled.

`DELETE /api/admin/players/:id` → `{ deleted: true }` only when nothing references the player; otherwise
`409 in_use` with `references: { registrations, interests, rosters, captainOf }` (retire or merge instead). Audited
`player.delete` (pool and source only).

**Cost:** a competition list is two small reads (the league and its seasons), one batch (group counts, the page, the
programmes) and two reads for the page (latest spots, open EOIs); a training list two batches; a player's page one
batch of eight reads; a merge two reads and one batch of ten statements (the audit row included). A test seeds three
years of three leagues (3,600 roster rows, 1,500 players) and checks the list's query count, parameters, groups (against
`groupOf()`) and that no plan scans the roster table (`planOf` in `src/server/db/testing.ts`).
