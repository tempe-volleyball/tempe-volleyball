# Season rosters API

Who plays in each team each season (docs/interest.md "Season rosters"), and where a new season's teams come from.
Implemented in `src/server/competition/rosters.ts`; routes in `src/pages/api/admin/seasons/[id]/`. The season builder
(Setup → Teams, `src/admin/seasons/SeasonTeams.tsx`) is the only client.

## Basics

- **Admins and owners only**, on reads too, with the role re-read from D1 (`requireRole(…, 'admin', { fresh: true })`):
  rosters carry names, emails and phones. Editors can open a season's Results tab but never see a roster. Below admin:
  `403 forbidden`.
- **Roster changes save straight away** and are independent of the season's working copy: they don't take or change
  `season.updatedAt`, so an unsaved Setup tab never conflicts with them, and they work on draft, **published and
  archived** seasons (a roster doesn't change the draw or the public site). Like ladder adjustments there's no
  concurrency token; a change aimed at a row someone just removed is a `404` or `409 roster_changed`.
- **Team list changes stay with the season's Save** (`PUT /teams` below), so the season's concurrency token keeps
  meaning what it did.
- **One team per season.** A player is on at most one roster per season. Adding someone who's in another team is
  `409 already_in_team` with `players: [{ playerId, name, teamId, teamName }]`, unless the request says `move: true`.
- **Captains.** At most one per team.
- **EOIs.** Placing a player from an individual EOI marks that EOI's programme row for this league `placed` (with the
  season and team); moving them updates the team; removing or replacing them reverts it to `contacted`. This happens
  whenever a player with an open (new or contacted) EOI for the league is added, however they were picked.
- Every change is one batch, audited as `roster.update` (target: the season), within D1's limits: rows go in as one
  JSON parameter (`INSERT … SELECT FROM json_each`), so no statement binds more than a handful of parameters.

## Reading

### `GET /api/admin/seasons/:id/rosters`

```ts
{
  seasonId, leagueId, status,
  rosters: { teamId, teamName, withdrawn, players: RosterPlayer[] }[],   // the season's teams, in order
  placed: number,          // players on a roster this season
  openInterest: number,    // open individual EOIs for this league whose player isn't placed this season
  sources: {               // left out with ?sources=0
    lastSeason: { id, name } | null,   // the league's latest season starting before this one
    teams: SourceTeam[],               // every team that has played, grouped and newest first
    interests: TeamInterest[],         // open team EOIs for this league, newest first
  }
}
RosterPlayer = { playerId, firstName, lastName, email, phone, gender, retired, role: 'captain' | 'player', sort,
                 interest: { id, reference } | null, fromSeason: { id, name } | null, level, position }
SourceTeam   = { teamId, teamName, group: 'last' | 'league' | 'other', seasons,
                 from: { seasonId, seasonName, startDate, leagueCode, withdrawn },   // the roster that would be copied
                 players: { playerId, name, role, retired }[] }
TeamInterest = { interestId, reference, teamName, createdAt, status, level,
                 captain: { playerId, name, email, phone } | null,
                 members: { playerId, name, role, retired }[],
                 matchedTeam: { id, name } | null }   // an existing team with the same name (case-insensitive)
```

A source team's `from` is last season for `last`, its newest season in this league for `league`, and its newest
season anywhere for `other`. `withdrawn` says it withdrew from that season ("Add all of last season's teams" leaves
those out). About ten D1 queries.

### `GET /api/admin/seasons/:id/players`

The player picker's list: `competitionDirectory()` (`src/server/players/directory.ts`) for this season's league, with
this season as the target (so "Last season" is the one before it). Each player has `group` (`interest` / `last` /
`past` / `retired` / `other`), `lastInLeague`, `lastAnywhere`, their newest open EOI (`level`, `position`) and
`inSeason`. The browser filters and searches it (`src/admin/seasons/roster-helpers.ts`).

### `GET /api/admin/seasons/:id/rosters.csv`

Team, Role, First name, Last name, Email, Phone, Gender: one row per player, team by team. Every cell is quoted and
text starting with `= + - @` (or a tab or CR) gets a leading apostrophe (`src/lib/enrolment/csv.ts`). Audited as
`roster.export`. `Cache-Control: no-store`.

## Changing a roster

### `POST /api/admin/seasons/:id/rosters`

One change, `{ action, teamId, … }`, where `teamId` is a team in the season (`409 team_not_in_season` otherwise, for
example a team added in the working copy and not saved yet):

| `action`  | Body                                                                     | Does                                                                                                         |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `add`     | `playerIds?: string[]`, `newPlayers?: NewPlayer[]`, `move?: boolean`     | Adds existing competition players (training players are refused) and new ones; anyone already in the team is skipped. At most 40 ids and 20 new players. |
| `remove`  | `playerId`                                                               | Takes them off the roster.                                                                                   |
| `move`    | `playerId`, `toTeamId`                                                   | To the end of another team's roster; a captain stays captain only if that team has none.                     |
| `replace` | `playerId`, `withPlayerId` or `newPlayer`, `move?: boolean`              | The new player takes the old one's role and place.                                                           |
| `captain` | `playerId`, `captain?: boolean` (default true)                           | Makes them captain (the old captain becomes a player), or not.                                               |
| `order`   | `playerIds`: the team's whole roster in its new order                    | `409 roster_changed` if the list isn't exactly the roster.                                                   |

`NewPlayer = { firstName, lastName?, email?, phone?, gender? }` (gender one of `male`, `female`, `non_binary`,
`prefer_not_to_say`). A new player is matched to an existing competition player with the same email and name
(`matchPeople`), else created in the competition pool with `source: 'admin'`.

The answer is the `GET` body without `sources`, plus `done: { action, added, created, moved }`.

## The team list's Save

### `PUT /api/admin/seasons/:id/teams` (docs/api/seasons.md) takes `rosterFrom`

```ts
{ baseUpdatedAt, teamIds, rosterFrom?: { [teamId]: { seasonId } | { interestId } } }
```

In the same batch as the new team list:

- **Teams leaving** lose their roster for this season, and EOIs placed into them go back to `contacted`.
- **Teams joining** with a `rosterFrom` entry get a roster: `{ seasonId }` copies that team's roster in that season
  (roles and order kept, `fromSeasonId` recorded); `{ interestId }` copies a team EOI's members (the captain as
  captain, `interestId` recorded) and marks the EOI's programme row for this league `placed` in this season and team.
  Copies skip retired players and anyone already in a team this season (the first team in `teamIds` wins), and
  copied players' own open individual EOIs become placed.
- Entries for teams already in the season are ignored (they keep their own roster); an entry for a team that isn't
  in `teamIds` is a `400`, and so is copying from the same season.

The answer is the season view plus `rosterCopy: { copied, skipped: { name, team, reason: 'retired' | 'placed' }[] }`.
A dozen teams of ten players is about 15 D1 queries.

Creating a team from a team EOI uses `POST /api/admin/teams` first (or the existing team with the same name), then
adds it to the working copy with `{ interestId }`.

### Other places rosters follow

- **New season copying the latest** (`POST /api/admin/seasons`, `copyFrom`): the copied teams bring their rosters
  (minus retired players), in one `INSERT … SELECT`. EOIs aren't touched.
- **Team merges** (`POST /api/admin/teams/:id/merge`): B's roster rows and EOI placements move to A before B is
  deleted (a row that would collide with one of A's is dropped; merges across one season are refused anyway, and
  roster seasons count for that check). The undo record keeps B's roster seasons and EOI rows, so undo puts them back.
