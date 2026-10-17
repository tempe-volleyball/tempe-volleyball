# Enrolment API

Enrolment without online payment (docs/admin.md §3.7): forms per programme, caps by players and/or teams, waitlists
with emailed offers, paid/unpaid marked by hand, and CSV export. The code is in `src/server/enrolment/` (server),
`src/lib/enrolment/` (pure: form definitions, validation, defaults, references, CSV), `src/components/enrolment/`
(public islands) and `src/admin/enrolment/` (admin screens). Data model: docs/data-model-phase6.md.

## Concepts

- **Target:** what someone enrols in. One of `season` (league), `session` (a training session not inside a term),
  `term` (development) or `event`. Written `{ kind, id }`; admin URLs use `/:kind/:id`.
- **Product:** one row per target (`products.season_id/session_id/term_id/event_id`, each unique), created the first
  time the target is enrolled in or opened in the admin (`ensureProduct`). It holds the per-instance overrides: player
  cap (`capacity`), team cap (`capacityTeams`), price, form, waitlist on/off and offer hours, team entries and free
  agents on/off, and an open/close window that can only narrow the programme's. `null` = use the programme's value.
- **Entry types:** `player` (training, development), `team` and `free_agent` (leagues and events, each switchable).
  A team entry is a `groups` row plus the captain's registration; a free agent is a registration with
  `free_agent = 1` that the admin places into a team entry (`group_id`).
- **Spot-holding statuses:** registrations `confirmed`, `offered` (plus the parked `pending_payment`, `paid`); groups
  `confirmed`, `offered`. `waitlist` waits; `cancelled`, `expired`, `refunded` are closed. Paid or unpaid is
  `paid_at`, separate from the status.
- **Reference:** `TVB-` plus four characters from a 30-letter alphabet without look-alikes (`TVB-7K3Q`), unique
  (retried on a clash). Shown on screen and in every email.

## How caps stay exact

`createEntry()` (`submit.ts`) inserts the entry as `confirmed` and, **in the same `db.batch()`** (one transaction; D1
runs one at a time), a conditional UPDATE moves it to the end of the waitlist when the spot-holding count is now over
the cap, or when others are already waiting (so nobody jumps the queue). With the waitlist off, a conditional DELETE
refuses it instead (`409 full`) and removes any player row it created. Two people can't take the last spot: whichever
batch runs second sees the first one's row. Team entries check the team cap and the player cap. The SQL is in
`core.ts` (`settleStatements`, `individualMustWait`, `teamMustWait`); tests simulate concurrent submissions.

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

Order of checks: rate limit → Turnstile → target exists, isn't draft and is open → entry type allowed → answers
validated against the target's form → duplicate / team name → cap. `201`:

```jsonc
{
  "status": "confirmed", // or 'waitlist'
  "reference": "TVB-7K3Q",
  "position": null, // 1-based waitlist place when waitlisted
  "teamName": null,
  "amountCents": 2000, // null = no fee
  "message": null, // the form's confirmation text
  "programme": "Scrim & Coached Training",
  "target": "Tue 27 Oct 2026, 6:30pm–8pm",
}
```

A confirmation or waitlisted email is sent through the outbox (a mail failure never fails the enrolment).

| Status | `error`            | When                                                                                                |
| ------ | ------------------ | --------------------------------------------------------------------------------------------------- |
| 400    | `invalid_input`    | Bad target or entry type, or answers fail validation: `fieldErrors: { [key]: message }`             |
| 403    | `turnstile_failed` | The Turnstile token didn't verify (network failures fail closed)                                    |
| 404    | `not_found`        | No such target, or its programme is a draft                                                         |
| 409    | `closed`           | Enrolment is off, outside its window, or the target is over/cancelled (`message` says which)        |
| 409    | `full`             | Over the cap with the waitlist off                                                                  |
| 409    | `duplicate`        | The same person (email + first and last name, case-insensitive) already has a live entry here       |
| 409    | `team_name_taken`  | Another live team entry has that name (trimmed, case-insensitive); `fieldErrors.team_name`          |
| 429    | `rate_limited`     | Over a limit; `retryAfter` (seconds)                                                                |
| 503    | `unavailable`      | No Turnstile keys (production without `TURNSTILE_SECRET_KEY`): online enrolment is off, fail closed |

**Duplicates** match on email _and_ name so siblings can share a parent's email; the partial unique index (one live
registration per product and player) backs it up. An existing player row is reused, and a public form only fills its
blank columns, never overwriting details someone else entered.

**Rate limits** (`ENROL_LIMITS` in `submit.ts`, fixed windows in the `rate_limits` table): 20 per IP per hour, 6 per
email per hour, 15 per email per day. Every attempt counts, including failed and duplicate ones, and they're counted
before Turnstile so a flood costs one upsert each. Keys are a salted SHA-256 prefix (salt: `BETTER_AUTH_SECRET`), never
the IP or email. The cron deletes ended windows.

**Turnstile** (`src/server/turnstile.ts`): `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` secrets. Development and
staging fall back to Cloudflare's always-pass test keys. **Production needs real keys** (Cloudflare dashboard →
Turnstile → add the `www.tempevb.com` and `*.workers.dev` hostnames, then `wrangler secret put TURNSTILE_SITE_KEY --env
production` and the same for `TURNSTILE_SECRET_KEY`); without them the form shows "unavailable" and the API answers 503.

### `POST /api/enrol/offer`

The waitlist offer page (`/enrol/offer#<token>`, island `OfferResponse.tsx`) posts `{ token, action }` with `action`
`view` (default), `accept` or `decline`. The token travels in the URL fragment and a POST body, never in a URL the
server logs. Answers `{ state: 'live' | 'accepted' | 'gone', firstName, programme, target, reference, teamName,
expiresAt }`. Accepting confirms the spot (and the captain's registration for a team) and emails a confirmation;
declining cancels it and offers the spot to the next person. `404 not_found` for a bad or tampered token,
`409 offer_gone` when it lapsed or was already answered (accepting twice is fine).

Tokens (`tokens.ts`) are `o1.<r|g>.<id>.<offeredAt base36>.<HMAC-SHA-256>`, keyed from `BETTER_AUTH_SECRET` with their
own label. Nothing is stored; a token stops working as soon as the offer is answered, re-offered or lapses, because the
server checks `offered_at` and the status. Offer emails are in `SENSITIVE_TEMPLATES` (their payload is scrubbed), and
the outbox drops an offer email whose offer lapsed before it could be sent.

### Public form component

`src/components/enrolment/EnrolmentForm.tsx`, default export, rendered as an island:

```astro
---
import EnrolmentForm from '../components/enrolment/EnrolmentForm'
import { loadEnrolmentForm } from '../server/enrolment/public'
import { getTurnstileKeys } from '../server/services'
const props = await loadEnrolmentForm(db, programme.id, getTurnstileKeys()?.siteKey ?? null) // null = nothing open
---

{props ? <EnrolmentForm client:load {...props} initialTargetId={Astro.url.searchParams.get('session') ?? undefined} /> : <p>…</p>}
```

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
juniors' and guardians'. Editors get `403` and don't see the Enrolments or Forms screens (docs/admin.md §3.7). Every
change is audited in the same batch. Anything that frees a spot (cancel, delete, move away, a raised cap, a declined or
lapsed offer) offers it straight away and emails the offer.

| Method and path                                          | What                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /enrolment/targets?all=1&programmeId=`              | `{ targets: TargetSummary[] }`: every target with `caps`, `counts { players, waitlist, offered, teams, teamsWaitlist, unpaid }` and `open`. Default hides archived seasons and old dates.                                            |
| `GET /enrolment/targets/:kind/:id`                       | `TargetDetail` + `paymentMethods`: summary, product, effective settings, form (retired questions too), registrations with player details, team entries, `moveTargets`.                                                               |
| `GET /enrolment/targets/:kind/:id/export.csv?status=all` | CSV, a column per question (retired ones too), formula-escaped. Default leaves out cancelled and expired.                                                                                                                            |
| `POST /enrolment/targets/:kind/:id/registrations`        | Add by hand: `{ entryType, person, answers, status?: 'confirmed' \| 'waitlist', notify? }`. No Turnstile or window; required questions optional. `status` forces past the cap.                                                       |
| `POST /enrolment/targets/:kind/:id/groups`               | A team entry with no captain (to place free agents in): `{ name }`.                                                                                                                                                                  |
| `PATCH /enrolment/products/:id`                          | Settings: `{ capacity, capacityTeams, priceCents, formId, waitlistEnabled, waitlistOfferHours, allowTeamEntries, allowFreeAgents, opensAt, closesAt, active, baseUpdatedAt }`. `null` clears. Returns `{ product, offered, cache }`. |
| `POST /enrolment/registrations/:id`                      | `{ action, … }`, below.                                                                                                                                                                                                              |
| `POST /enrolment/groups/:id`                             | `{ action, … }`, below.                                                                                                                                                                                                              |
| `GET /forms`, `POST /forms`                              | List (with where each is used, the default questions per kind, the programmes); create `{ name, description?, fields? \| template?: kind, confirmationText? }`.                                                                      |
| `GET/PATCH/DELETE /forms/:id`                            | Read; save `{ baseUpdatedAt, name?, description?, fields?, confirmationText?, archived? }` (bumps `version`); delete only when unused and unanswered, else archive.                                                                  |
| `PUT /forms/:id/programmes`                              | Make this the default form for exactly `{ programmeIds }`.                                                                                                                                                                           |

Registration actions: `mark_paid { method: payid|cash|bank|card|other, note? }`, `mark_unpaid { note? }`,
`cancel { reason?, notify? }`, `reinstate` (back through the cap check), `offer` (a waitlisted person, now),
`confirm { notify? }` (promote from the waitlist past the cap), `resend_offer`, `move { to: { kind, id }, force? }`
(within the programme; `force` skips the cap), `place { groupId | null }` (free agents), `edit { person?, birthYear?,
guardian?, emergencyContact? }` (the audit records which fields changed, not the values), `delete` (for good, with the
player row if nothing else uses it). Group actions: `cancel`, `reinstate`, `offer`, `confirm`, `resend_offer`,
`rename { name }`, `notes { notes }`, `link_team { teamId }`, `delete`. A captain's registration is changed through its
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
when there's a fee), `enrolment.waitlisted` (with the position), `enrolment.offer` (the accept/decline link and the
deadline in Sydney time; sensitive), `enrolment.cancelled` (by the admin with `notify`, a decline, or a lapsed offer).

## Cron

`runEnrolmentCron()` (`offers.ts`) runs first in the hourly cron, before the outbox drain, so its emails go out the
same run. It expires lapsed offers (they're told), then offers spots on products with room and a waitlist. An idle
run is one query; a busy one is bounded (`CRON_LAPSED_LIMIT` 3, `CRON_PRODUCT_LIMIT` 1, `CRON_OFFER_LIMIT` 3: about 20
queries), and that hour the drain sends 5 emails instead of 10 and analytics waits an hour, so the invocation stays
inside 50 D1 queries. It's skipped without `BETTER_AUTH_SECRET` (no key to sign offer links).
