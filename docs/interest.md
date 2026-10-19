# Expressions of interest, players and rosters

The decision record for the sign-up overhaul (2026-10-20). It replaces league enrolment as the default for
competitions. docs/admin.md §3.7 (enrolment) still applies to training sessions and development terms.

## Why

Competitions don't take enrolments. People tell Michael they're interested, as a player or as a team, he contacts
them, takes a PayID deposit and builds the next season from returning teams, new teams and individuals placed into
teams. The old site did this with two Google Forms (`/new-player-2023`, `/new-team-group-2023`) that are open all
year. Our league pages said "Enrolment … is closed right now" between seasons, which is when most people ask.

## Decisions

### Sign-up mode per programme

- `leagues.signup_mode`: `interest` (expressions of interest, EOIs) or `enrolment` (capped enrolment with a waitlist,
  §3.7). Null = the kind's default: **leagues and events → interest**, training and development → enrolment. Michael
  can switch any programme; the enrolment machinery (products, caps, waitlist) is kept for all kinds.
- `leagues.interest_open` (default on): whether an interest programme is taking EOIs. It isn't time-windowed: EOIs
  are welcome all year. Off = the programme isn't offered on the EOI form and its page says nothing about joining.
- Deposits: `leagues.deposit_player_cents`, `leagues.deposit_team_cents` (null = no deposit). Shown on the form with
  the PayID details (Settings → PayID); Michael marks each EOI paid or unpaid by hand, with a note.
- `leagues.interest_text`: an optional public line for the programme page's join section (else generated).

### The public form

- **One EOI form**, at `/interest`, and per programme at `/interest/<programme slug>` (the same form with that
  programme ticked). Path segments, not query strings: the public site 301s query strings to the canonical URL.
- **Two entry types**, like the old forms: **a player** (on their own, to be placed in a team) or **a team**
  (a team name, the contact as captain, and team members). The entry type is picked at the top.
- **Programmes:** a tick box per active `interest` programme with `interest_open`, grouped by category. At least one;
  Settings → Interest → "Most programmes per entry" (default none).
- **Questions:** the built-in person fields (first, last, email, phone), then an enrolment form (the existing form
  builder, Admin → Enrolments → Enrolment forms) chosen in Settings → Interest → "Form" (default: a built-in
  default copied from the Google Form: age or year of birth, gender, suburb, playing level, position, willing to
  captain, experience/questions, where they heard of us, guardian for under-18s, acknowledgements and the waiver).
  New mapped field types: `gender` → players.gender, `suburb` → players.suburb, `vnsw_number` → players.vnsw_number.
- **Team members:** up to Settings → Interest → "Most team members" (default 8, counting the captain), each with
  first and last name and, as Settings → Interest → "Member details" chooses, email, phone, gender, year of birth and
  VNSW number (each off / optional / required). Members are optional: a team can send just its name and captain.
- Turnstile, D1 rate limits (per IP before Turnstile, per canonical mailbox after), a body cap, and the log scrubber,
  exactly as `/api/enrol` and `/api/contact`.
- **The answer is always the same** ("Thanks, we'll be in touch"), plus the form's confirmation text and the deposit
  and PayID details when a deposit applies. No reference or "already registered" on the page.
- **Emails** (through the outbox, never priority): an acknowledgement to the contact with what they sent and its
  reference (Settings → Interest → "Send an acknowledgement", default on), and a notification to the contact address
  and Settings → Interest → "Notify" addresses (default the contact email). Off-by-default spam risk is the same as
  the contact form's auto-reply: the acknowledgement only goes to the address typed, at most the mailbox limits.
- **No email confirmation by default** (no spot is held, and Michael contacts everyone anyway): Settings → Interest
  → "Ask people to confirm their email" can turn it on later. Unconfirmed details never overwrite a player record
  (below), so a forged EOI can't change anyone's details.

### Players

- **Every form saves its people as players** (`players`), and **competition players are kept apart from training
  players**: `players.pool` is `competition` (leagues and events, whatever their sign-up mode) or `training`
  (training and development). A person in both is two rows, one per pool, on purpose: Michael asked for them to be
  separate. The pool is set by the programme the form was for; an EOI for several programmes uses `competition` if
  any is a league or event, else `training` (and EOIs are only offered for interest-mode programmes, so in practice
  `competition`).
- **Matching:** within a pool, by lower-cased email and first and last name (case-insensitive), as enrolment does
  today, so siblings sharing a parent's email stay separate. Team members without an email match by name only
  within the team's previous rosters, else are new players.
- **Public forms never overwrite a player:** a new person creates a player row with what they typed; an existing
  player keeps their details and the form's details are kept on the EOI (`interest_members.details`) for Michael to
  compare and apply ("Use these details") in the admin.
- New columns: `gender`, `suburb`, `vnsw_number`, `retired_at` (Michael's "retired" flag; retired players are hidden
  from pickers unless asked for), `source` (`interest` / `enrolment` / `admin` / `import`), and `pool`.
- **Admin → Players** (admin+): two tabs, **Competition** and **Training**, each a searchable list with filters, a
  player page (details, every EOI, enrolment and season roster they've been on, notes), add by hand, edit, retire
  and un-retire, merge two duplicates, delete (only with no history), and CSV export (audited, like enrolment CSVs).
- **Competition player groups** (shown as filters on the Players screen and as tabs in the season builder's player
  picker), worked out when shown, never stored:
  - **New interest:** an open EOI (status `new` or `contacted`) for the league, sent since its last season started
    (its latest season whose start date has passed; no season yet = any time).
  - **Last season:** on the roster of the league's most recent season (when building a new season, the latest season
    before it).
  - **Past players:** on an earlier roster of the league, or of another league (shown with where and when).
  - **Retired:** `retired_at` set. A retired player is only in this group.
    On the Players screen, without a league chosen, the groups are across all leagues ("Last season" = on the roster of
    any league's most recent season).

### Expressions of interest (EOIs)

- `interests`: one per form sent: `kind` (`player` / `team`), `reference` (`EOI-XXXX`), team name, answers, the form
  and version, deposit owed (cents, from the programmes' deposits: the highest of those picked), paid at / by / note,
  an admin note, `source` (`public` / `admin` / `import`), `archived_at`.
- `interest_members`: the people on it, the contact first (`role` captain for a team, `player` for a player EOI),
  each linked to a player row and keeping the details as sent (JSON).
- `interest_programmes`: one row per programme picked, with its own status, because Michael may place someone in TNL
  and turn down FNL: `new` → `contacted` → `placed` / `declined` / `withdrawn`, plus the season and team they were
  placed into. Placing a player or team on a season roster from the EOI sets `placed` automatically.
- **Admin → Interest** (admin+; editors can't see personal details): the inbox, newest first, filtered by programme
  (default: everything open), status, kind and "since the last season started"; each EOI's page with its people,
  answers, programmes and statuses, deposit (mark paid / unpaid with method and note), note, "Add to season" (the
  team or the player, into a chosen draft season and team), archive, delete; add an EOI by hand (phone calls); CSV
  export (audited). The dashboard shows new EOIs. Retention: Settings → Interest → "Delete archived EOIs after" days
  (default 365, 0 = keep); the privacy policy says so.

### Season rosters

- `season_team_players` (season, team, player, `role` captain/player, sort, where they came from: an EOI or a
  previous season): who played in each team each season. Rosters are admin-only (never public: they're personal
  data) and stay editable after a season is published (they don't change the draw). Removing a team from a season
  deletes its roster for that season; team merges move rosters to the kept team.
- **The season builder** (season Setup → Teams) gets:
  - **Add all of last season's teams**, with their rosters (one click; skips withdrawn teams, which stay offered).
  - **Returning teams:** a list of teams from this league's earlier seasons (newest first, with when they last
    played) and from other leagues, to add one by one with last time's roster.
  - **Team EOIs:** teams from open EOIs for this league, to add with their members as the roster (creating the team
    if it's new, or matching an existing team by name); the EOI becomes `placed`.
  - **New team** by name (as today).
  - **Each team's roster:** players with captain marked, remove, make captain, move to another team, and **replace**
    (swap one player for another). Adding or replacing opens the **player picker**: tabs for New interest, Last
    season, Past players, Retired and All (search), each row showing the name, last team and season, gender, level
    and position (from their EOI), and whether they're already in a team this season; "add a new player" inline.
  - Counts: players per team, players placed this season, and open individual EOIs not yet placed.
- Roster changes save straight away (not part of the season's Save), are audited, and work on published seasons.

## Status: public side done (2026-10-20)

Built on branch `eoi-public` (docs/api/interest.md, docs/public-site.md "Joining"): the form at `/interest` and
`/interest/<slug>`, `POST /api/interest`, the acknowledgement and notification emails, join sections on interest
programmes' pages, "Taking sign-ups" badges and Register interest buttons, `/enrol`'s interest section, the Programme
list filter, the sitemap, and the old sign-up URLs (`INTEREST_REDIRECTS`) going to `/interest`. Decisions made on the
way (the more robust or configurable option each time):

- `/interest/<slug>` of a real programme that isn't taking EOIs is a **302** (not 301) to `/interest`: EOIs may open
  again, and browsers keep 301s.
- `/interest` is an intro-page path (a page published there adds a title, intro and meta description) as well as
  Settings → Interest → Intro; `/interest/*` is reserved.
- Notifications go to the contact email **and** the Notify addresses (each once), at most Settings → Interest →
  `notifyPerDay` (new, default 30, 1–50) a day, like the contact form.
- A honeypot field, as on the contact form (bots get the normal answer, nothing is stored).
- A chosen form's `team_name` question is dropped (the team name is the form's own field); an archived or missing
  form falls back to the built-in questions. Programme age limits aren't checked (an EOI can name several programmes).
- `interest_text`, when set, replaces the join section's whole text; otherwise the next start plus a generic line.
- Interest-mode programmes never show enrolment on the public site (their page has no enrolment form even if the old
  enrolment switch is on). `POST /api/enrol` itself is unchanged.
- `/2023-enrolment` was an EOI page too ("interested in playing … submit one of the below entries"), so every old
  sign-up URL goes to `/interest`; the content map repoints rows earlier runs aimed at `/enrol` (unless edited).
