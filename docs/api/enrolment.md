# Enrolment API

Enrolment without online payment (docs/admin.md §3.7): forms per programme, caps by players and/or teams, waitlists
with emailed offers, paid/unpaid marked by hand, and CSV export. The code is in `src/server/enrolment/` (server),
`src/lib/enrolment/` (pure: form definitions, validation, defaults, references, CSV), `src/components/enrolment/`
(public islands) and `src/admin/enrolment/` (admin screens). Data model: docs/data-model-phase6.md.

## Concepts

- **Target:** what someone enrols in. One of `season` (league), `session` (a training session not inside a term),
  `term` (development) or `event`. Written `{ kind, id }`; admin URLs use `/:kind/:id`.
- **Product:** one row per target (`products.season_id/session_id/term_id/event_id`, each unique). Sessions, terms
  and events get theirs when they're created; a season gets its own the first time someone enrols or its settings are
  saved (`ensureProduct`; a GET never writes). It holds the per-instance overrides: player cap (`capacity`), team cap
  (`capacityTeams`), price, form, waitlist on/off and offer hours, team entries and free agents on/off, email
  confirmation (`emailConfirm`), and an open/close window that can only narrow the programme's. `null` = use the
  programme's value.
- **Label:** every screen and email names a target the same way, built from its row each time (`targetLabel()` in
  `src/lib/enrolment/targets.ts`, joined in SQL by `core.ts` `targetLabelColumns`/`joinTargetRows`): "TNL Q4 2026",
  "Thu 22 Oct 2026, 6–8pm", "Term 4 2026". `products.name` is never shown. Times use the one format from
  `src/lib/time.ts` `formatTimeRange` ("6–8pm", "11am–1pm") everywhere.
- **Entry types:** `player` (training, development), `team` and `free_agent` (leagues and events, each switchable).
  A team entry is a `groups` row plus the captain's registration; a free agent is a registration with
  `free_agent = 1` that the admin places into a team entry (`group_id`).
- **Spot-holding statuses:** registrations `confirmed`, `offered` (plus the parked `pending_payment`, `paid`); groups
  `confirmed`, `offered`. `waitlist` waits; `pending_email` (both) waits for its emailed confirm link and holds
  nothing; `cancelled`, `expired`, `refunded` are closed. Paid or unpaid is `paid_at`, separate from the status.
- **Waitlist place:** `waitlist_position` is only an ordering key (it keeps gaps when someone leaves the list). What
  people and the admin see is the rank, counted in order (`core.ts` `waitlistRankSql`, `waitlistRanks`), so the next
  in line after an offer is "number 1".
- **Reference:** `TVB-` plus four characters from a 30-letter alphabet without look-alikes (`TVB-7K3Q`), unique
  (retried on a clash). Shown on screen and in every email.

## How caps stay exact

`createEntry()` (`submit.ts`) inserts the entry as `confirmed` and, **in the same `db.batch()`** (one transaction; D1
runs one at a time), a conditional UPDATE moves it to the end of the waitlist when the spot-holding count is now over
the cap, or when others are already waiting (so nobody jumps the queue). With the waitlist off, a conditional DELETE
refuses it instead (`409 full`) and removes any player row it created. Two people can't take the last spot: whichever
batch runs second sees the first one's row. Team entries check the team cap and the player cap. The SQL is in
`core.ts` (`settleStatements`, `individualMustWait`, `teamMustWait`); tests simulate concurrent submissions.

Confirming an email address settles a `pending_email` entry the same way (`confirm.ts` `settlePendingStatements`):
the conditional UPDATE to `confirmed` plus `settleStatements` in one batch, so a pending entry joins the end of the
waitlist when it's confirmed after the spots went, and with the waitlist off it's cancelled as full (kept, not deleted,
with the reason "Full when the email address was confirmed").

Offers work the same way: `offerNext()` works out the free room inside the UPDATE, so concurrent calls can't
over-offer. One call offers at most `OFFER_BATCH_MAX` (5) individuals and 5 teams, to keep a request's emails inside
the 50-query limit; the hourly cron offers the rest.

## Public

### `POST /api/enrol`

```jsonc
{
  "target": { "kind": "session", "id": "…" },
  "entryType": "player", // 'player' | 'team' | 'free_agent'; default: the first the target allows
  "person": { "firstName": "Pat", "lastName": "Lee", "email": "pat@example.com", "phone": "0400 000 000" },
  "answers": { "skill_level": "beginner", "emergency_contact": { "name": "Sam", "phone": "0411 111 111" } },
  "turnstileToken": "…",
}
```

The body is capped at 64 KB (`413 too_large`, checked while reading, with or without Content-Length; `readJson`'s
default outside `/api/admin`) and the answers at 32 KB of JSON. Order of checks: IP rate limit → Turnstile (token,
hostname and the widget's action `enrol`, with real keys) → email rate limits → target exists, isn't draft and is
open → entry type allowed → answers validated against the target's form → duplicate / team name → cap. `201`, one of
two answers, both "check your email", decided only by the target's email-confirmation setting:

```jsonc
{
  "status": "emailed", // 'pending_email' (confirmation on) | 'emailed' (off)
  "reference": null, // always null on the page: it's in the email
  "position": null, // always null on the page
  "teamName": null, // as submitted
  "amountCents": 2000, // null = no fee
  "message": null, // emailed: the form's confirmation text
  "programme": "Scrim & Coached Training",
  "target": "Tue 27 Oct 2026, 6:30–8pm",
  "confirmHours": 24, // pending_email only
}
```

- **`pending_email`** (the target asks for email confirmation, see below): nothing is held yet; the person is emailed a
  confirm link. No reference until they click it.
- **`emailed`** (no confirmation asked for): the entry is settled straight away (confirmed, or on the waitlist), and
  the `enrolment.confirmed` / `enrolment.waitlisted` email has the reference and the place (a mail failure never
  fails the enrolment). The page doesn't show them: a repeat gets exactly this answer too.

**Repeats don't say so** (docs/admin.md §3.7). A submission matching an entry that holds or waits for a spot (same
email and name) answers exactly as a new one would, instead of `409 duplicate`, so the form can't be used to find out
whether someone (possibly a junior) is enrolled; the address on file gets `enrolment.already` with its reference and
where it stands. With the waitlist off and no room, a repeat is refused `409 full`, as a new entry would be. **A
repeat of an unconfirmed (`pending_email`) entry replaces it**: the old one is cancelled with the reason "Replaced by
a newer form before the email address was confirmed" (its link stops working, its team entry is cancelled with it)
and the new submission is entered afresh with a new link, so the address owner confirms what was typed last.

**Unconfirmed details stay on the registration.** A `pending_email` entry writes nothing onto a player: its mobile,
year of birth, guardian and emergency contact are kept in `registrations.pending_details`, and a new player row gets
only the name and email. Confirming (the link, `verify`, or `confirm` from the admin) merges them into the player,
filling blanks only (`core.ts` `mergePendingDetailsStatements`, in the same batch), and clears them. The admin's
target detail shows them on the entry's player with `detailsUnconfirmed: true`.

### Email confirmation

Per programme (`leagues.enrolment_email_confirm`) with a per-instance override (`products.email_confirm`), like the
caps: `null` = automatic, **on when the instance has a player or team cap**; `true` always; `false` never. When it's
on, a public entry is inserted as `pending_email` (team entries: the group too) with `hold_expires_at` = now + Settings
→ Enrolment → "Hours to confirm an email address" (default 24). It holds no spot, isn't on the waitlist and isn't
counted against a cap; the admin sees it as "Awaiting email". The `enrolment.confirm_email` email carries a link
`/enrol/confirm#<token>`; the page shows the entry and a "Confirm my enrolment" button (opening the link alone changes
nothing, so mail scanners can't confirm). Clicking settles it against the caps (above), then emails the confirmation
or waitlist place. Admin-added entries never need it. The hourly cron expires unconfirmed entries past their deadline
(status `expired`, reason "Email address not confirmed in time"; no email, nothing is offered on), except while the
entry's confirm link is still queued in the outbox.

**The deadline starts when the link is sent.** The email's payload names the entry (`pending: { id, hours }`); when
the mailer actually sends it (straight away, or from the queue after the day's cap) it sets `hold_expires_at` to the
send time plus the hours (only ever later), and the email shows that deadline. The drain drops a queued link whose
entry is no longer `pending_email` (confirmed by hand, replaced, expired). Confirm links are mailed from their own
share of the reserve (see Emails).

| Status | `error`            | When                                                                                                |
| ------ | ------------------ | --------------------------------------------------------------------------------------------------- |
| 400    | `invalid_input`    | Bad target or entry type, or answers fail validation: `fieldErrors: { [key]: message }`             |
| 403    | `turnstile_failed` | The Turnstile token didn't verify (network failures fail closed)                                    |
| 404    | `not_found`        | No such target, or its programme is a draft                                                         |
| 409    | `closed`           | Enrolment is off, outside its window, or the target is over/cancelled (`message` says which)        |
| 409    | `full`             | Over the cap with the waitlist off                                                                  |
| 409    | `duplicate`        | Not from the public form (see below); the admin's "Add enrolment" when the person is already in     |
| 409    | `team_name_taken`  | Another live team entry has that name (trimmed, case-insensitive); `fieldErrors.team_name`          |
| 429    | `rate_limited`     | Over a limit; `retryAfter` (seconds)                                                                |
| 413    | `too_large`        | The body is over 64 KB or the answers over 32 KB                                                    |
| 503    | `unavailable`      | No Turnstile keys (production without `TURNSTILE_SECRET_KEY`): online enrolment is off, fail closed |

**Duplicates** match on email _and_ name so siblings can share a parent's email; the partial unique index (one live
registration per product and player) backs it up. An existing player row is reused, and a public form only fills its
blank columns, never overwriting details someone else entered.

**Rate limits** (`ENROL_LIMITS` in `submit.ts`, fixed windows in the `rate_limits` table): 20 per IP per hour, 6 per
email per hour, 15 per email per day. Only the IP limit is counted before Turnstile (so a flood costs one upsert each
and nobody can lock a person out by sending junk with their address); the email limits are counted once the check
passes, including duplicates. Email keys use the canonical mailbox (`canonicalMailbox()` in
`src/lib/enrolment/validate.ts`: lower-cased, `+tag` dropped, dots dropped for gmail.com / googlemail.com). Keys are a
salted SHA-256 prefix (salt: `BETTER_AUTH_SECRET`, required: `hashKey` throws without it), never the IP or email. The
cron deletes ended windows.

**Turnstile** (`src/server/turnstile.ts`): `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` secrets. Development and
staging fall back to Cloudflare's always-pass test keys. **Production needs real keys** (Cloudflare dashboard →
Turnstile → add the `www.tempevb.com` and `*.workers.dev` hostnames, then `wrangler secret put TURNSTILE_SITE_KEY --env
production` and the same for `TURNSTILE_SECRET_KEY`); without them the form shows "unavailable" and the API answers 503.
Production also refuses Cloudflare's test keys if they're set by mistake (treated as no keys). With real keys the
siteverify answer's `hostname` must be the host the form posted to, so a token solved on another site isn't accepted.

### `POST /api/enrol/confirm`

The confirm page (`/enrol/confirm#<token>`, island `ConfirmResponse.tsx`) posts `{ token, action: 'view' | 'confirm' }`
(64 KB body cap). Answers `{ state: 'pending' | 'confirmed' | 'waitlist' | 'full' | 'expired', firstName, programme,
target, teamName, expiresAt, reference, position, details }`; `reference` once confirmed or waitlisted; `details`
while pending: `{ phone, birthYear, guardianName, emergencyContact }` as sent with the form, which the page lists as
"Confirming also saves these details" (or null). The page re-reads the token on `hashchange` (a second link opened in
the same tab starts afresh); so does the offer page. Confirming twice is
harmless. `404 not_found` for a bad or tampered token. Tokens (`tokens.ts`) are `c1.<registration id>.<createdAt
base36>.<HMAC-SHA-256>` with their own key label; they're single-use because they only act while the registration is
still `pending_email` and inside its deadline. `enrolment.confirm_email` is a sensitive template (payload scrubbed).

### `POST /api/enrol/offer`

The waitlist offer page (`/enrol/offer#<token>`, island `OfferResponse.tsx`) posts `{ token, action }` with `action`
`view` (default), `accept` or `decline`. The token travels in the URL fragment and a POST body, never in a URL the
server logs. Answers `{ state: 'live' | 'accepted' | 'gone', firstName, programme, target, reference, teamName,
expiresAt }`. Accepting confirms the spot (and the captain's registration for a team) and emails a confirmation;
declining cancels it and offers the spot to the next person. `404 not_found` for a bad or tampered token,
`409 offer_gone` when it lapsed or was already answered (accepting twice is fine).

Tokens (`tokens.ts`) are `o1.<r|g>.<id>.<offeredAt base36>.<HMAC-SHA-256>`, keyed from `BETTER_AUTH_SECRET` with their
own label. Nothing is stored; a token stops working as soon as the offer is answered, re-offered or lapses, because the
server checks `offered_at` and the status. Offer emails are in `SENSITIVE_TEMPLATES` (their payload is scrubbed).

**The hold starts when the email goes.** An offer email's payload names the offer (`hold`); when the mailer actually
sends it (straight away, or from the queue after the day's cap) it sets `offer_expires_at` to the send time plus the
offer hours, never past `hold.latest`, and the email shows that deadline. The cron never lapses an offer whose email is
still queued (unless its `latest` has passed), and the drain drops an offer email whose offer was answered, cancelled
or re-offered meanwhile, or whose `latest` has passed. Resending an offer restarts its hold (still capped).

**Offers stop before the start.** Settings → Enrolment → `offerCutoffHours` (default 2): an offer is held until the
target's start minus that at the latest (`core.ts` `offerWindow` / `offerExpiry`), and once that point has passed
`offerNext()` makes none, the admin's `offer` action answers `409 offers_closed`, and the cron's work-finder skips the
product (so it can't take the run's one product slot every hour). The start (`targetStartSql`, Sydney wall clock):
a session's date and start time; an event's start date and time; a season's first match day that isn't a skipped
week, at the earliest game start that night, else the league's start time; midnight when no time is known. Terms have
none. `GET /enrolment/targets/:kind/:id` returns it as `offers: { latest, closed, startsAt, cutoffHours }`, and the
admin's target page says when offers stop or that they have.

### Public form component

`src/components/enrolment/EnrolmentForm.tsx`, default export, rendered as an island:

```astro
---
import EnrolmentForm from '../components/enrolment/EnrolmentForm'
import { loadEnrolmentForm } from '../server/enrolment/public'
import { getTurnstileKeys } from '../server/services'
const props = await loadEnrolmentForm(db, programme.id, getTurnstileKeys()?.siteKey ?? null) // null = nothing open
---

{props ? <EnrolmentForm client:visible {...props} initialTargetId={Astro.url.searchParams.get('session') ?? undefined} /> : <p>…</p>}
```

Pages use `client:visible`, so the island's JavaScript stays off the first load. Until it hydrates, the server-rendered
form is disabled with a "Getting the form ready…" line, so nothing typed early can be wiped by hydration.

Props (`EnrolmentFormProps` in `src/server/enrolment/public.ts`, plus two component-only ones):

| Prop               | Type                           | Notes                                                                                                                                                                                                            |
| ------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `programme`        | `{ id, name, code, kind }`     |                                                                                                                                                                                                                  |
| `targets`          | `PublicTarget[]`               | Open targets, soonest first: `{ kind, id, label, startsOn, formKey, entryTypes, amountCents, spotsLeft, teamSpotsLeft, waitlistOnly, full }`. One target shows no picker; several show radios with fee and room. |
| `forms`            | `Record<formKey, FormField[]>` | Active questions per form (targets can use different forms).                                                                                                                                                     |
| `turnstileSiteKey` | `string \| null`               | Null shows "online enrolment is unavailable".                                                                                                                                                                    |
| `endpoint`         | `string?`                      | Default `/api/enrol`.                                                                                                                                                                                            |
| `closedText`       | `string?`                      | Shown when `targets` is empty.                                                                                                                                                                                   |
| `preview`          | `boolean?`                     | Admin preview: no Turnstile, nothing sent.                                                                                                                                                                       |
| `initialTargetId`  | `string?`                      | Preselects a target.                                                                                                                                                                                             |

`listOpenEnrolments(db, now?, { programmeId? })` returns everything open, grouped by programme, for `/enrol`. Both
read only non-personal data, so the page around the form can be cached at the edge (purge `/enrol` and the programme
page when settings change; `updateProduct` returns those tags). Answers only ever go to `POST /api/enrol` (JSON, never a
URL, never stored in the browser, never sent to analytics), and its responses are `no-store`.

## Admin

All under `/api/admin`, **admin or owner only** (`requireRole(user, 'admin', …)`): this is personal data, including
juniors' and guardians'. Editors get `403` and don't see the Enrolments or Forms screens (docs/admin.md §3.7). The GETs
that return personal data (targets, a target, the CSV, forms) use `requireRole(…, { fresh: true })`, which re-reads
the role from D1 instead of trusting the 5-minute session cookie cache. Every change is audited in the same batch, and
so is each CSV download (`enrolment.export` with the target, the row count and whether cancelled entries were in it). Anything that frees a spot (cancel, delete, move away, a raised cap, a declined or
lapsed offer) offers it straight away and emails the offer.

| Method and path                                          | What                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /enrolment/targets?all=1&programmeId=`              | `{ targets: TargetSummary[] }`: every target with `caps`, `counts { players, waitlist, offered, teams, teamsWaitlist, pending, teamsPending, unpaid }` and `open`. Default hides archived seasons and old dates.                                                                       |
| `GET /enrolment/targets/:kind/:id`                       | `TargetDetail` + `paymentMethods`: summary, product (`null` until a season's settings are first saved), effective settings, form (retired questions too), registrations with player details (`waitlistRank`, `confirmBy`), team entries (`waitlistRank`), `moveTargets`. Never writes. |
| `PATCH /enrolment/targets/:kind/:id`                     | The target's settings, as `PATCH /enrolment/products/:id`, creating its product row first if it has none. What the admin screen uses.                                                                                                                                                  |
| `GET /enrolment/targets/:kind/:id/export.csv?status=all` | CSV, a column per question (retired ones too), formula-escaped. Default leaves out cancelled and expired. Audited (`enrolment.export`).                                                                                                                                                |
| `POST /enrolment/targets/:kind/:id/registrations`        | Add by hand: `{ entryType, person, answers, status?: 'confirmed' \| 'waitlist', notify? }`. No Turnstile or window; required questions optional. `status` forces past the cap.                                                                                                         |
| `POST /enrolment/targets/:kind/:id/groups`               | A team entry with no captain (to place free agents in): `{ name }`.                                                                                                                                                                                                                    |
| `PATCH /enrolment/products/:id`                          | Settings: `{ capacity, capacityTeams, priceCents, formId, waitlistEnabled, waitlistOfferHours, allowTeamEntries, allowFreeAgents, emailConfirm, opensAt, closesAt, active, baseUpdatedAt }`. `null` clears. Returns `{ product, offered, cache }`.                                     |
| `POST /enrolment/registrations/:id`                      | `{ action, … }`, below.                                                                                                                                                                                                                                                                |
| `POST /enrolment/groups/:id`                             | `{ action, … }`, below.                                                                                                                                                                                                                                                                |
| `GET /forms`, `POST /forms`                              | List (with where each is used, the default questions per kind, the programmes); create `{ name, description?, fields? \| template?: kind, confirmationText? }`.                                                                                                                        |
| `GET/PATCH/DELETE /forms/:id`                            | Read; save `{ baseUpdatedAt, name?, description?, fields?, confirmationText?, archived? }` (bumps `version`); delete only when unused and unanswered, else archive.                                                                                                                    |
| `PUT /forms/:id/programmes`                              | Make this the default form for exactly `{ programmeIds }`.                                                                                                                                                                                                                             |

Registration actions: `mark_paid { method: payid|cash|bank|card|other, note? }`, `mark_unpaid { note? }`,
`cancel { reason?, notify? }`, `reinstate` (back through the cap check), `offer` (a waitlisted person, now;
`409 offers_closed` once offers have stopped before the start),
`confirm { notify? }` (promote from the waitlist, an offer or a pending email, past the cap), `resend_offer`,
`verify { notify? }` (confirm a pending entry's email by hand: it's settled against the caps as if they'd clicked),
`resend_confirm` (email the confirm link again; the deadline restarts), `move { to: { kind, id }, force? }` (within the
programme; `force` skips the cap; refused while pending), `place { groupId | null }` (free agents), `edit { person?, birthYear?,
guardian?, emergencyContact? }` (the audit records which fields changed, not the values), `delete` (for good, with the
player row if nothing else uses it). Group actions: `cancel`, `reinstate`, `offer`, `confirm`, `resend_offer`,
`verify`, `resend_confirm`, `rename { name }`, `notes { notes }`, `link_team { teamId }`, `delete`. A captain's registration is changed through its
team entry. Stale state answers `409 conflict`; reload and retry.

## Forms

Field types (`src/lib/enrolment/forms.ts`): `text`, `textarea`, `email`, `phone`, `number`, `date`, `select`,
`radio`, `checkbox`, `checkboxes` (multi-select), `consent`, `guardian`, `emergency_contact`, `birth_year`,
`team_name`, `vnsw_membership`, and display-only `heading` and `paragraph`. Each can be required, have help text,
apply to some entry types only (`appliesTo`) and show only when another answer matches (`showIf`, one level). Name,
email and mobile are always asked first and aren't fields. `checkFormFields()` validates a definition on save: keys
are permanent (a saved key can't be deleted or change to an incompatible type; retire it instead), so old answers keep
their labels. Mapped types write to columns, not `answers`: guardian → `players.guardian_*` (only the name is asked;
the contact email and phone are the guardian's on a junior form), emergency contact, birth year (checked against the
programme's ages), team name → `groups.name`, VNSW → `registrations.vnsw_confirmed`.

Without a form of its own a programme uses its kind's defaults (`src/lib/enrolment/defaults.ts`): league (team name,
players, or skill level and gender for free agents, notes, code of conduct), training (skill level, emergency contact,
code of conduct), development (junior's year of birth, age group, guardian, emergency contact, guardian consent),
event (team name, players, notes, code of conduct). "New form" starts from a copy of one.

## Emails

Templates in `src/server/email/templates.ts`: `enrolment.confirmed` (with the fee and PayID details from Settings
when there's a fee), `enrolment.waitlisted` (with the place), `enrolment.offer` (the accept/decline link and the
deadline in Sydney time; sensitive), `enrolment.cancelled` (by the admin with `notify`, a decline, or a lapsed offer),
`enrolment.confirm_email` (the confirm link and its deadline; sensitive) and `enrolment.already` (a repeat
submission: the reference and where the entry stands).

The mailer (`src/server/email/mailer.ts`) treats enrolment email in three tiers. **Priority** (offers, cancellations,
admin actions, and anything after a confirmed address or an accepted offer; `sendEmail(…, { priority: true })`,
stored as `email_outbox.priority`) may use the whole general pool and isn't limited per recipient. **Confirm links**
(`enrolment.confirm_email`, not priority) may use `CONFIRM_LINK_RESERVE` (10) of the reserve. **Everything else**
(what an anonymous form triggers: `enrolment.already`, confirmations on uncapped forms) stops `PRIORITY_RESERVE` (20)
short of the general pool's daily cap, so junk entries can't hold up a real offer or confirm link. Both non-priority
tiers are limited per canonical mailbox: `ENROLMENT_PER_HOUR` (5; more are queued until the hour has passed) and
`ENROLMENT_PER_DAY` (10; more are dropped). The tier of a queued email is worked out again from its template and
`priority` when the cron drains it.

**No real email on the test keys.** `emailMode()` ignores `RESEND_API_KEY` (and logs instead) while the public forms
use Turnstile's always-pass test keys, i.e. in development and staging without real `TURNSTILE_*` keys: otherwise
`/api/enrol` would mail any address for anyone. Set real Turnstile keys there too before giving staging a Resend key.

## Cron

`runEnrolmentCron()` (`offers.ts`) runs first in the hourly cron, before the outbox drain, so its emails go out the
same run. It expires lapsed offers (they're told), then offers spots on products with room and a waitlist. An idle
run is one query; a busy one is bounded (`CRON_LAPSED_LIMIT` 3, `CRON_PRODUCT_LIMIT` 1, `CRON_OFFER_LIMIT` 3: about 20
queries), and that hour the drain sends 5 emails instead of 10 and analytics waits an hour, so the invocation stays
inside 50 D1 queries. It's skipped without `BETTER_AUTH_SECRET` (no key to sign offer links).

Housekeeping (`runHousekeeping()` in `src/server/cron.ts`) runs every hour too: one settings read and one batch that
expires unconfirmed entries past their deadline (at most 200 a run, never one whose link is still queued), deletes
unconfirmed entries that lapsed or were replaced more than Settings → Enrolment → "Days to keep sent emails" (default 30) ago (at most 90 a run, with their unconfirmed team entries; `confirm.ts` `pruneUnconfirmedStatements`), and
deletes sent and failed outbox rows older than that; then, when it pruned any, one statement deleting the player rows
they used that nothing else uses (`prunePlayersStatement`). With every job doing work an hourly run is about 27
queries (`confirm.test.ts` holds it to 35).
