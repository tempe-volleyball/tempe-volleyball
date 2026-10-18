import { csvCell } from './enrolment/csv'
import { isEmail, normaliseEmail } from './enrolment/validate'
import { sydneyDateTime } from './time'

// The public contact form (docs/admin.md §3.15, docs/api/contact.md), the pure half: validating a submission and
// writing the inbox's CSV. No bindings, so it's tested without a database and shared by the Worker and the admin.

/** Bounds on what a message may carry. The request body itself is capped at CONTACT_BODY_LIMIT. */
export const CONTACT_LIMITS = { name: 100, email: 254, topic: 60, message: 5000, pagePath: 300 } as const

/** The largest request body POST /api/contact reads (the fields above plus a Turnstile token fit in a fraction). */
export const CONTACT_BODY_LIMIT = 16 * 1024

/**
 * The hidden field bots fill in. Named like a real field so form-filling bots take it; people never see it (it's
 * off-screen, aria-hidden and out of the tab order).
 */
export const HONEYPOT_FIELD = 'website'

export type ContactInput = {
  name?: unknown
  email?: unknown
  topic?: unknown
  message?: unknown
  pagePath?: unknown
  turnstileToken?: unknown
  [HONEYPOT_FIELD]?: unknown
}

export type ContactValue = { name: string; email: string; topic: string; message: string; pagePath: string | null }

export type ContactCheck = { ok: true; value: ContactValue } | { ok: false; errors: Partial<Record<keyof ContactValue, string>> }

const oneLine = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')

/** Keeps line breaks (paragraphs matter in a message) but drops control characters and trailing space on lines. */
const multiLine = (v: unknown) =>
  typeof v === 'string'
    ? v
        .replace(/\r\n?/g, '\n')
        // oxlint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{4,}/g, '\n\n\n')
        .trim()
    : ''

/** A same-site path to remember where the form was ("/contact"), or null. */
const pathOf = (v: unknown) => {
  const s = typeof v === 'string' ? v.trim() : ''
  return /^\/(?!\/)[\w\-./%]*$/.test(s) && s.length <= CONTACT_LIMITS.pagePath ? s : null
}

/**
 * Checks a submission against the topic list (Settings → Contact form). With topics set, the topic must be one of
 * them; without, it's ignored. Field errors are worded for the form.
 */
export function validateContact(input: ContactInput, topics: readonly string[]): ContactCheck {
  const name = oneLine(input.name)
  const email = normaliseEmail(input.email)
  const message = multiLine(input.message)
  const rawTopic = oneLine(input.topic)
  const errors: Partial<Record<keyof ContactValue, string>> = {}
  if (!name) errors.name = 'Enter your name.'
  else if (name.length > CONTACT_LIMITS.name) errors.name = 'That name is too long.'
  if (!email) errors.email = 'Enter your email address, so we can reply.'
  else if (!isEmail(email)) errors.email = "That email address doesn't look right."
  if (!message) errors.message = 'Write your message.'
  else if (message.length > CONTACT_LIMITS.message) errors.message = `That's too long: at most ${CONTACT_LIMITS.message} characters.`
  let topic = ''
  if (topics.length > 0) {
    const match = topics.find((t) => t.toLowerCase() === rawTopic.toLowerCase())
    if (match) topic = match
    else errors.topic = 'Choose what your message is about.'
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, value: { name, email, topic, message, pagePath: pathOf(input.pagePath) } }
}

/** Did a bot fill in the hidden field? */
export const isHoneypotFilled = (input: ContactInput) => {
  const v = input[HONEYPOT_FIELD]
  return typeof v === 'string' ? v.trim() !== '' : v !== undefined && v !== null && v !== false
}

export type CsvMessage = {
  createdAt: string
  name: string
  email: string
  topic: string
  status: string
  message: string
  pagePath: string | null
  handledAt: string | null
  note: string | null
}

/** "2026-10-19 14:05" in Sydney time, for the CSV. */
const when = (iso: string | null) => (iso ? sydneyDateTime(new Date(iso)) : '')

/** The inbox as CSV (spreadsheet-safe cells, Sydney times), newest first as given. */
export function messagesCsv(rows: readonly CsvMessage[]): string {
  const head = ['Received', 'Name', 'Email', 'Topic', 'Status', 'Message', 'Page', 'Handled', 'Note']
  const lines = rows.map((r) =>
    [when(r.createdAt), r.name, r.email, r.topic, r.status, r.message, r.pagePath ?? '', when(r.handledAt), r.note ?? '']
      .map(csvCell)
      .join(','),
  )
  return `${[head.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`
}

/**
 * A mailto: link that replies to a message: the sender's address, "Re: <topic>" (or "Re: your message"), and the
 * message quoted below. Long messages are cut so the link stays within what mail apps accept.
 */
export function replyMailto(m: Pick<ContactValue, 'name' | 'email' | 'topic' | 'message'>, opts: { siteName?: string } = {}): string {
  const subject = `Re: ${m.topic ? `${m.topic} – ` : ''}your message to ${opts.siteName ?? 'Tempe Volleyball'}`
  const quoted = m.message.length > 1500 ? `${m.message.slice(0, 1500)}…` : m.message
  const body = `Hi ${m.name.split(' ')[0] ?? m.name},\n\n\n\n> ${quoted.split('\n').join('\n> ')}\n`
  return `mailto:${encodeURIComponent(m.email).replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
