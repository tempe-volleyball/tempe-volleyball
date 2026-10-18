# Contact form and messages API

The public contact form and the admin's inbox (docs/admin.md §3.15). Code: `src/lib/contact.ts` (pure: validation,
CSV, the reply link), `src/server/contact/messages.ts` (submit, inbox, prune), the Contact form block
(`src/lib/content/data-blocks.ts` `renderContactForm`, with `src/components/ContactFormScript.astro`) and
`src/admin/screens/Messages.tsx`. Table: `contact_messages` (migration 0008).

## The form

A **Contact form** page block (`{ type: 'contactForm', attrs: { title, defaultTopic, showTopic, submitLabel } }`) renders
a plain HTML form at view time from Settings → Contact form (topics, on/off), Contact details and the Turnstile site
key. A body with one gets `ContactFormScript.astro` (a few KB, no React), which renders Turnstile (action `contact`)
when the form nears the viewport or on first focus, posts JSON to `/api/contact`, shows field errors under their
fields and swaps the form for the thank-you text. Without Turnstile keys (production before they're set) or with the
form switched off, the block shows the contact email and phone instead. No `page_data_refs` row: a settings save
purges `site`, which every page carries.

## `POST /api/contact` (public)

Body (JSON, at most 16 KB, else 413):

```json
{
  "name": "Pat Lee",
  "email": "pat@example.com",
  "topic": "Juniors",
  "message": "Is there room in JDP?",
  "pagePath": "/contact",
  "website": "",
  "turnstileToken": "…"
}
```

Order: IP limit (10 an hour, before anything else) → honeypot → Turnstile → validation → mailbox limit (5 an hour, 10
a day, on the canonical mailbox: `+tags` and Gmail dots count as one) → insert → notification emails → automatic
reply. Rate-limit keys are salted hashes (`src/server/ratelimit.ts`).

- **201** `{ status: 'sent', message }`, `message` being Settings → Contact form's thank-you text. A filled-in
  honeypot (`website`) gets the same answer, with nothing stored or sent and no Turnstile call.
- **400** `invalid_input` with `fieldErrors` (`name`, `email`, `topic`, `message`). `topic` must be one of the
  settings' topics while there are any; `pagePath` is kept only when it's a same-site path.
- **403** `turnstile_failed`. **429** `rate_limited` (with `retryAfter`). **503** `unavailable` (no Turnstile keys, or
  the form is switched off).

Emails go through `sendEmail()` as ordinary (non-priority) mail:

- `contact.notify` to Settings → Contact form's addresses (else the contact email), with the sender as **reply-to**
  and a link to `/admin/messages/<id>`. At most `notifyPerDay` messages a day are notified (a rolling 24-hour
  window, key `contact:notify-day`); later ones are still stored and counted on the admin home page.
- `contact.ack` to the sender, only with Settings → Contact form → "Send an automatic reply" on (off by default). It's
  limited per mailbox like the enrolment emails (5 an hour, then queued; 10 a day, then dropped).

About 15 D1 queries per message (tested).

## Inbox (admin+, role re-read from D1)

Messages are personal data, so editors get no access (like enrolments). Every route answers `no-store`.

- `GET /api/admin/messages?filter=open|new|read|handled|all&q=&topic=&before=` → `{ rows, counts, next, topics }`.
  `open` (the default) is new and read. Rows are newest first, 50 a page, with a 160-character one-line `preview`;
  `next` is the cursor for `before`. `counts` is per status; `topics` the topics in use. `q` searches name, email,
  topic and message.
- `POST /api/admin/messages` `{ action: 'status', ids, status }` or `{ action: 'delete', ids }` (at most 90 ids) →
  `{ changed }` / `{ deleted }`.
- `GET /api/admin/messages/:id` → the message, `handledByName` included. Opening a new one marks it `read`.
- `PATCH /api/admin/messages/:id` `{ status?: 'new' | 'read' | 'handled', note?: string | null }` → the message.
  Handled records `handled_at` and `handled_by`; back to new or read clears them.
- `DELETE /api/admin/messages/:id` → `{ deleted }`.
- `GET /api/admin/messages/export.csv?filter=` → CSV (Received in Sydney time, Name, Email, Topic, Status, Message,
  Page, Handled, Note), spreadsheet-safe cells, at most 5,000 rows.
- `GET /api/admin/messages/unread` → `{ unread }`, for the nav badge (admin+, one indexed count).

Audit: `message.delete` (how many and their ids; never names, addresses or text) and `message.export` (filter and
row count). Status changes and notes aren't audited (they're the inbox's normal use).

The admin home page (`GET /api/admin/dashboard`) has `messages: { unread, openCount, open }` for admins and owners
(two queries).

## Retention

The hourly cron's housekeeping batch deletes messages that were **handled** longer ago than Settings → Contact form
→ "Days to keep handled messages" (default 365, 30–3650): one bounded statement. Open messages are kept until
they're handled or deleted. The notification and automatic-reply emails (which hold the message) leave the outbox
after Settings → Enrolment → "Days to keep sent emails" (default 30), like every other email.
