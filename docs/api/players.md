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

- **Competition** comes from `competitionDirectory()` (everyone in the pool, at most 3000, grouped in memory), so the
  groups match the season builder's player picker: `group` = `interest` (New interest), `last` (Last season), `past`
  (Past players), `retired`, `other`, or `all` (default). With `league` the groups are for that league (its window:
  `lastSeason`, `interestSince`); without, across all leagues. `retired` applies to `all` only (Retired is its own
  group). `groupCounts` has the count per group with the search and retired filter applied.
- **Training** is an SQL page: search, `programme` (has an enrolment in it), `retired`, sort. Each row has its
  enrolment count and latest enrolment's target label.

```ts
type PlayerList = {
  pool; rows: PlayerListItem[]; total; page; pages // 50 a page
  groupCounts: Record<'interest' | 'last' | 'past' | 'retired' | 'other' | 'all', number> | null
  league: { id; code; name } | null; lastSeason: { id; name; startDate } | null; interestSince: string | null
  programmes: { id; code; name; kind }[] // for the filter: leagues and events, or training and development
  truncated: boolean
}
type PlayerListItem = {
  id; firstName; lastName; email; phone; gender; retiredAt; createdAt
  group: PlayerGroup | null; lastSpot: RosterSpot | null; interest: { reference; kind; teamName; status; level; position; … } | null
  enrolments: number | null; lastEnrolment: { label; programmeName; createdAt } | null
}
```

`GET /api/admin/players/export.csv?<the list's query>`: every matching player (all pages, at most 5000), with the
group and last team for competition. Formula-safe cells. Audited as `player.export`.

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
  the duplicate's and notes are joined; then the duplicate is deleted. → `PlayerDetail & { merge: { registrationsMoved,
registrationsCancelled, interestsMoved, captaincies, rostersMoved, rosterDuplicatesDropped, filled } }`. Audited
  `player.merge` on the kept player, with the duplicate's id, name, source and created date in `before`.

`DELETE /api/admin/players/:id` → `{ deleted: true }` only when nothing references the player; otherwise
`409 in_use` with `references: { registrations, interests, rosters, captainOf }` (retire or merge instead). Audited
`player.delete` (pool and source only).

**Cost:** a competition list is the directory's five reads plus one; a training list two batches; a player's page one
batch of eight reads; a merge one batch of nine statements plus the audit row.
