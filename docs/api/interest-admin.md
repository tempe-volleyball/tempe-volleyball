# Interest admin API

What Admin → Interest calls (docs/interest.md, docs/admin.md §3.16). Routes are in `src/pages/api/admin/interest/`,
the logic in `src/server/interest/admin.ts` (tests in `admin.test.ts` and `routes.test.ts` next to it). The public
form (`POST /api/interest`) is documented with the public pages.

**Every route is admins and owners only**, with the role re-read from D1 on every request (`{ fresh: true }`), GETs
included: EOIs are personal data, so editors get `403` and a demoted admin loses access at once. Bodies are capped at
64 KB (`INTEREST_BODY_LIMIT`). Responses are `no-store`; nothing here is cached. Errors are `{ error, message }` as
everywhere else ([seasons.md](seasons.md#basics)).

## The inbox

`GET /api/admin/interest` with the filter in the query string (unknown values fall back to the defaults):

| Param       | Values                                                                                  | Default  |
| ----------- | --------------------------------------------------------------------------------------- | -------- |
| `programme` | a programme id                                                                          | all      |
| `status`    | `open` (new or contacted), `new`, `contacted`, `placed`, `declined`, `withdrawn`, `any` | `open`   |
| `kind`      | `player`, `team`                                                                        | both     |
| `since`     | `season`: sent since the programme's last season started; `all`                         | `all`    |
| `archived`  | `active` (not archived), `archived`, `all`                                              | `active` |
| `q`         | words matching a person's name, email or phone, the team name or the reference          | none     |
| `before`    | the `next` cursor of the previous page                                                  |          |

Status is **per programme**: with a programme chosen it's that programme's status on the EOI; without one an EOI
matches when any of its programmes has it. `since=season` uses `leagueWindow()` (src/lib/players/groups.ts) over the
programme's seasons: its latest season whose start date has passed (no season yet = any time), compared from Sydney
midnight that day. With no programme chosen, each programme uses its own window.

```ts
type InterestList = {
  rows: InterestListItem[] // newest first, 50 a page
  total: number // how many match
  next: string | null
  programmes: InterestProgrammeOption[] // interest-mode programmes, and any other with EOIs
  filter: InterestFilter // as parsed
}
type InterestListItem = {
  id
  kind: 'player' | 'team'
  reference: 'EOI-XXXX'
  teamName
  source: 'public' | 'admin' | 'import'
  depositCents: number | null
  paidAt
  archivedAt
  createdAt
  hasNote: boolean
  contact: { firstName; lastName; email; phone; playerId } | null // the player, or the team's captain
  members: number
  programmes: { programmeId; code; name; kind; status; seasonId; seasonName; teamId; teamName; updatedAt }[]
  level: string | null
  position: string | null // from the answers (playing_level, position)
}
type InterestProgrammeOption = {
  id
  code
  name
  kind
  status
  signupMode
  interestOpen
  depositPlayerCents
  depositTeamCents
  since: 'YYYY-MM-DD' | null
  lastSeason: { id; name } | null
  counts: Record<InterestStatus, number> // EOIs not archived
  openSince: number // open EOIs sent since `since`
}
```

`GET /api/admin/interest/count` → `{ new }`: EOIs with a programme still `new`, not archived (the nav badge).
`GET /api/admin/interest/options` → `{ programmes: InterestProgrammeOption[], form: { id, name, fields }, maxMembers }`
for the "Add EOI" dialog (the form is Settings → Interest's, else the built-in default; mapped fields left out).

`GET /api/admin/interest/export.csv?<the inbox's query>`: every matching EOI (at most 5000, `EXPORT_LIMIT`), one row
per person (the contact first, then team members) with the EOI's columns on every row and its answers on the
contact's row. One batch of four statements whatever the count: the EOIs, then their members, programmes and forms
with the filter as a subquery (grouped with maps). When more match, the file is named `…-first-5000.csv` and the
response has `X-Export-Truncated: 1`. Cells are quoted and formula-safe like the enrolment CSV (`csvCell`). Audited as
`interest.export` with the filter, counts and `truncated`.

## Bulk, add by hand, delete

`POST /api/admin/interest`:

- `{ action: 'create', kind, teamName?, programmeIds, members, answers?, note?, depositCents? }` adds an EOI by hand
  (a phone call) through `createInterest()` with source `admin` and the actor (audited `interest.create`); no
  Turnstile, no emails. `members` is the contact first, then team members (a player EOI is one person), each
  `{ firstName, lastName, email?, phone?, gender?, birthYear?, suburb?, vnswNumber?, guardianName?, guardianEmail?,
guardianPhone?, emergencyContact? }`; names are required and the contact needs an email or a phone. `answers` are
  checked against the EOI form with nothing required; unknown keys and unanswered questions are dropped. The pool is
  `competition` if any programme is a league or event. The deposit is the highest of the programmes' (player or team)
  deposits unless `depositCents` is sent (`null` = none). Existing players are matched and never changed. → `201
{ id, reference, createdAt, members }`.
- `{ action: 'status', ids, status, programmeId? }`: sets the status on every programme of those EOIs (or just
  `programmeId`), clearing placements; `placed` is refused (it needs a season: do it per EOI), and so is the whole
  request when one of the placed rows has its people on a roster because of it (`409 on_roster`, below).
  → `{ changed }`.
- `{ action: 'archive' | 'unarchive', ids }` → `{ changed }`.
- `{ action: 'delete', ids, keepPlayers? }` → `{ deleted, playersDeleted }`.

At most 90 ids. Every bulk action writes **one audit row per EOI** (one INSERT … SELECT FROM json_each), so each EOI's
history shows it; `after.bulk` is how many were in the request. Deleting is for good and audited (`interest.delete`,
one row per EOI) with its reference and how many people, never who. Unless `keepPlayers`, the player rows the EOIs
created (same `created_at`, source `interest` or `admin`) are deleted in the same batch when nothing else uses them (no
other EOI, enrolment, roster or team captaincy: `createdOnlyBy()`), so a spam EOI leaves nothing behind; people who
were already on file are kept. The ids go in as one JSON parameter, so every such player goes, however many people
the 90 EOIs had.

## One EOI

`GET /api/admin/interest/:id` → `InterestDetail`:

```ts
{
  interest: { id; kind; reference; teamName; answers; formId; formVersion; depositCents; paidAt; paidByName
              paymentNote; note; source; archivedAt; createdAt; updatedAt; updatedByName }
  members: { id; role: 'captain' | 'player'; sort; details: MemberDetails  // as sent
             player: { id; pool; firstName; …; retiredAt; createdAt; source } | null
             diff: { field; sent; current }[]   // sent details (not blank) that differ from the player record
             createdHere: boolean }[]           // the player row was created by this EOI
  programmes: InterestProgrammeRow[]
  answers: { key; label; text }[]               // in form order; questions the form no longer has last
  formName: string                              // or 'Built-in default'
  history: { at; action; actorEmail; after }[]  // the latest 20 audit rows for it
  pool: 'competition' | 'training'
}
```

Names compare case-insensitively, emails lower-cased and phones without spaces, so "sam" vs "Sam" isn't a difference.

`POST /api/admin/interest/:id` `{ action, … }` → `InterestDetail`, each audited as `interest.update` (what changed,
never personal values; a note is recorded as "changed"):

| Action                | Body                                                | Notes                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `note`                | `{ note }`                                          | ≤ 2000; empty clears                                                                                                                                                                                                                             |
| `mark_paid`           | `{ method: payid\|cash\|bank\|card\|other, note? }` | payment note "PayID: 12/10", like enrolments                                                                                                                                                                                                     |
| `mark_unpaid`         | `{ note? }`                                         |                                                                                                                                                                                                                                                  |
| `status`              | `{ programmeId, status, seasonId?, teamId? }`       | placed takes a season of that programme and a team in that season's team list (a team alone only for a programme with no seasons); other statuses clear them; leaving placed is `409 on_roster` while its people are on the roster because of it |
| `archive`/`unarchive` |                                                     | archived EOIs leave the inbox and start the retention clock                                                                                                                                                                                      |
| `team_name`           | `{ teamName }`                                      | team EOIs                                                                                                                                                                                                                                        |
| `add_programme`       | `{ programmeId, status? }`                          | `409` if already on it; `409 wrong_pool` for a programme of the other pool (a training EOI on a league or event, or the reverse)                                                                                                                 |
| `remove_programme`    | `{ programmeId }`                                   | `409` for the last one; `409 on_roster` as for status                                                                                                                                                                                            |
| `apply_details`       | `{ memberId, fields: DetailField[] }`               | "Use these details": copies those sent details onto the player; audited `player.update` with the field names                                                                                                                                     |

`DELETE /api/admin/interest/:id` (`?keepPlayers=1`) → `{ deleted, playersDeleted }`, as the bulk delete.

**`409 on_roster`**: a placed programme row can't leave `placed` (status change, bulk status, or removing the
programme) while a roster row in the season it was placed in came from this EOI (`season_team_players.interest_id`).
Taking someone off a roster should be deliberate, so the answer says who and where ("Take them out of ACES first")
with `rosters: [{ interestId, reference, programmeId, seasonId, seasonName, teamId, teamName, path }]` (`path` is the
season's Setup tab, `/seasons/<id>/setup`, where Teams is). Removing them from the team there puts the EOI back to
contacted itself. The EOI page links each placed programme to its season's rosters.

**"Matched by email and name, not verified"**: on a public EOI, a person matched to a player already on file (not
created by it) is marked so on the EOI page, and "Use these details" asks for a confirm first: anyone can send the
public form with someone else's email and name.

## Retention

The hourly cron's housekeeping batch deletes EOIs archived longer ago than Settings → Interest → "Delete archived
EOIs after" (`archivedRetentionDays`, default 365; 0 = keep), at most 200 a run, oldest archived first
(`pruneInterestsStatement`); members and programmes go with them (cascade). Just before, in the same batch,
`prunePlayersOfInterestsStatement` deletes the player rows those same EOIs created that nothing else uses (the
delete-for-good rule, `createdOnlyBy()`), so retention removes the person too; players on file before, or who have
enrolled, played or sent another EOI since, stay. Open (not archived) EOIs are never pruned.

**Cost:** the inbox is the programme options batch (3 reads), a batch of the page and its count, and a batch of the
page's members and programmes (≤ 50 ids). An EOI's page is one batch of four reads. Bulk actions are one statement plus
one audit statement (a row per EOI), after one read for the roster check; a delete is one read and one batch of three.
The export is the options batch, one batch of four and the audit row (tested at 3,000 EOIs).
