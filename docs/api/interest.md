# Expressions of interest: the public form and API

The public side of expressions of interest (EOIs, docs/interest.md): the form at `/interest` and
`/interest/<programme slug>`, and `POST /api/interest`. Code: `src/lib/interest.ts` (pure: sign-up modes, the join
line, deposits, team-member checks), `src/server/interest/public.ts` (`loadInterestForm`, `submitInterest`),
`src/server/interest/route.ts` (the pages' route logic), `src/components/interest/` (`InterestForm.tsx`, the island,
and `InterestPage.astro`), `src/pages/interest/`, `src/pages/api/interest.ts`. Rows are written by
`createInterest()` (`src/server/players/core.ts`). The admin inbox is Admin → Interest (`/admin/interest/<id>`).

## What's offered

A programme is on the form when it's **active**, its sign-up mode is `interest` (`leagues.signup_mode`, null = the
kind's default: leagues and events take EOIs, training and development enrol) and `leagues.interest_open` is on
(`takesInterest()`). Grouped by category in category order, then programme order; programmes without a public
category come last. Drafts are never read.

`loadInterestForm(db, now, { programmeSlug?, turnstileSiteKey? })` → `{ form, slug, offered }`, one D1 batch
(programmes, categories, venues, settings, next start dates) plus the chosen form (only when Settings → Interest names
one):

- `form`: the island's props: `groups` (each programme's id, slug, kind, name, code, summary line, schedule, venue,
  "Next season starts …", deposits), `preselectedId`, `payid` (Settings → PayID when a PayID is set), `fields` (the
  enrolment form named by Settings → Interest → Form, active questions without `team_name`; a missing or archived
  form falls back to `defaultInterestFields()`), `formId`, `formVersion`, `confirmationText`, `maxProgrammes`,
  `maxMembers`, `memberFields`, `introText`, `successText`, `turnstileSiteKey`.
- `slug`: with a `programmeSlug`, `{ status: 'offered' | 'not_offered' | 'unknown', programme }`. A real programme
  that isn't taking EOIs (enrolment mode, EOIs off, retired) is `not_offered`; drafts and unknown slugs are `unknown`.

## The pages

| Path               | Shows                                                                    | Otherwise                                                    |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `/interest`        | The form. An intro page published at `/interest` adds its title and body | With nothing offered: "Nothing is taking EOIs right now"     |
| `/interest/<slug>` | "Join <name>", its summary and next start, the form with it ticked       | Not offered: **302** to `/interest`; unknown: redirects, 404 |

- **302, not 301**, for a programme that isn't taking EOIs: EOIs may open again, and a cached 301 would keep sending
  people away from its page for good.
- Canonical: each page's own path. Only `/interest` is in the sitemap (while something takes EOIs); the
  per-programme pages are the same form with one box ticked.
- `/interest` is a reserved prefix (no admin page under it) and an intro-page path (a page may live exactly there),
  like `/enrol` (`src/lib/content/paths.ts`).
- Edge-cached with `page:/interest` (every EOI page; also purged when an enrolment form changes, `formPurge`),
  `programmes`, `venues`, plus `page:/interest/<slug>` and `programme:<slug>`. A Settings save purges `site`.

## `POST /api/interest` (public)

Body (JSON, at most 64 KB, else 413; answers and members at most 32 KB each):

```jsonc
{
  "kind": "team", // 'player' (on their own, to be placed in a team) | 'team'
  "programmeIds": ["<tnl id>", "<fnl id>"],
  "person": { "firstName": "Pat", "lastName": "Lee", "email": "pat@example.com", "phone": "0412 345 678" },
  "answers": { "birth_year": 1995, "gender": "female", "playing_level": "intermediate", "waiver": true },
  "teamName": "Spike Lee", // teams only
  "members": [{ "firstName": "Jo", "lastName": "Park", "email": "jo@example.com" }], // teams only, besides the captain
  "website": "", // honeypot
  "turnstileToken": "…",
}
```

Order: IP limit (10 an hour) → honeypot → Turnstile (action `interest`, hostname checked with real keys) → mailbox
limit (5 an hour, 10 a day, on the canonical mailbox) → validation → `createInterest()` (one batch) → notification →
acknowledgement.

Validation, every error at once in `fieldErrors`:

- `kind`: player or team.
- `programmes`: at least one; each must be offered now; at most Settings → Interest → "Most programmes per entry"
  (0 = no limit).
- The contact person (`firstName`, `lastName`, `email`, `phone`) and the answers: `validateEnrolment(fields, kind ===
'team' ? 'team' : 'free_agent', …)`, so `appliesTo` works as on the enrolment form.
- `teamName`: required for teams, at most 80 characters.
- `members.<i>.<field>`: each row needs first and last name; email, phone, gender, year of birth and VNSW number
  follow Settings → Interest → "Member details" (off = dropped even if sent, optional, required). Completely blank
  rows are dropped; `members` when there are more than "Most team members" − 1.

What's saved: the pool is `competition` when any programme picked is a league or event, else `training`; the deposit
is the highest `deposit_team_cents` (teams) or `deposit_player_cents` (players) of the programmes picked; the contact
gets the mapped answers (gender, suburb, VNSW number, year of birth, guardian, emergency contact) as their
`MemberDetails`. Existing players are matched, never overwritten (docs/interest.md "Players").

Answers:

- **201** `{ status: 'sent', message, confirmationText, deposit }`, the same for every accepted form and a filled-in
  honeypot (nothing stored, no Turnstile call). `message` is Settings → Interest's thank-you text, `confirmationText`
  the form's. `deposit` is null, or `{ cents, amount, payid: { name, payId } | null, emailed }`: the page says to pay
  by PayID with "the reference in the email we've just sent you" (`emailed`, i.e. the acknowledgement is on), else
  with their name. **The reference is never on the page**, only in the email.
- **400** `invalid_input` with `fieldErrors`. **403** `turnstile_failed`. **413** `too_large`. **429** `rate_limited`
  (`retryAfter`). **503** `unavailable` (no Turnstile keys).

Emails go through `sendEmail()`, never priority:

- `interest.notify` to Settings → Interest → "Notify" addresses, or the contact email (Settings → Contact) when
  there are none, each once, with the contact as **reply-to**, what was sent and a link to `/admin/interest/<id>`. At most Settings →
  Interest → "Notification emails a day" (`notifyPerDay`, default 30) EOIs a rolling day are notified (key
  `interest:notify-day`); later ones are still saved.
- `interest.ack` to the contact (Settings → Interest → acknowledge, default on): the thank-you text, the reference,
  the deposit with PayID instructions (the reference as the payment description), the form's confirmation text and
  what they sent. Limited per mailbox like the enrolment emails (`isMailboxLimited`).

Logs never carry personal data (`describeError`). About 25 D1 queries per EOI with both emails (tested ≤ 30).
