import { and, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { isHoneypotFilled, messagesCsv, validateContact, type ContactInput, type ContactValue } from '../../lib/contact'
import { canonicalMailbox } from '../../lib/enrolment/validate'
import { runBatch, type AppDb } from '../db'
import { auditLog, contactMessageStatuses, contactMessages, user, type ContactMessage, type ContactMessageStatus } from '../db/schema'
import { audit, auditEntry, likeEscaped, likePattern, notFound, type Editor } from '../content/common'
import { getSettings } from '../content/settings'
import type { Mailer } from '../email'
import { HttpError } from '../http'
import { describeError } from '../log'
import { hashKey, hit, take, type Limit } from '../ratelimit'
import { TURNSTILE_ACTIONS, verifyTurnstile } from '../turnstile'

// The contact form and its inbox (docs/admin.md §3.15, docs/api/contact.md).
//
// POST /api/contact: IP limit → honeypot → Turnstile → validate → mailbox limit → store → notify → auto-reply. The
// message is stored before any email goes, so nothing is lost without Resend or past the daily cap. Notifications go
// to the organiser's addresses (Settings → Contact form, else the contact email) through sendEmail, as ordinary
// (non-priority) mail, and at most notifyPerDay a day, so a burst of spam can't use up the day's emails. The
// automatic reply is off by default: it's mail to an address nobody has confirmed, so it's limited per mailbox like
// enrolment emails (mailer.ts).
//
// The inbox (admins and owners): list, read (opening marks it read), handled, a note, delete for good, CSV export.
// Every query is bounded; bulk actions take at most MAX_BULK ids (one statement each, under D1's 100 parameters).

/** Public form limits (fixed windows). Only the IP is counted before Turnstile, like the enrolment form. */
export const CONTACT_RATE = { perIpHour: 10, perEmailHour: 5, perEmailDay: 10 } as const

const HOUR = 3_600_000

/** Bulk actions (handled, delete) take at most this many messages per request. */
export const MAX_BULK = 90

/** A page of the inbox. */
export const PAGE_SIZE = 50

export type PublicContactDeps = {
  db: AppDb
  mailer: Pick<Mailer, 'sendEmail'>
  /** BETTER_AUTH_SECRET: salts the rate-limit keys. */
  secret: string | undefined
  /** For the "open in the admin" link. */
  siteUrl: string
  /** Null when Turnstile isn't configured (production without keys): the form is unavailable. */
  turnstileSecret: string | null
  /** The host a real token must have been solved on (null with the test keys). */
  turnstileHostname?: string | null
  ip: string | null
  fetch?: typeof fetch
  now?: Date
}

export type PublicContactResult = { status: 'sent'; message: string }

const rateLimited = (retryAfter: number) =>
  new HttpError(429, 'rate_limited', 'Too many messages from here just now. Please wait a while and try again, or email us.', {
    retryAfter,
  })

/** POST /api/contact. Answers the same for a stored message and a discarded bot (honeypot), so bots learn nothing. */
export async function submitContact(deps: PublicContactDeps, input: ContactInput): Promise<PublicContactResult> {
  const { db } = deps
  const now = deps.now ?? new Date()
  if (!deps.secret) throw new Error('submitContact: no secret (BETTER_AUTH_SECRET is not set)')
  if (!deps.turnstileSecret)
    throw new HttpError(503, 'unavailable', 'The contact form is unavailable right now. Please email or phone us instead.')

  if (deps.ip) {
    const byIp = await hit(
      db,
      [{ key: `contact:ip:${await hashKey(deps.ip, deps.secret)}`, max: CONTACT_RATE.perIpHour, windowMs: HOUR }],
      now,
    )
    if (!byIp.ok) throw rateLimited(byIp.retryAfter)
  }

  const settings = await getSettings(db)
  const cf = settings.contactForm
  const answer: PublicContactResult = { status: 'sent', message: cf.successText }
  // A filled-in hidden field is a bot: say "sent" and keep nothing (no Turnstile call, no row, no email).
  if (isHoneypotFilled(input)) return answer
  if (!cf.enabled) throw new HttpError(503, 'unavailable', 'The contact form is turned off just now. Please email or phone us instead.')

  const human = await verifyTurnstile(deps.turnstileSecret, input.turnstileToken, deps.ip, deps.fetch, {
    hostname: deps.turnstileHostname ?? null,
    action: deps.turnstileHostname ? TURNSTILE_ACTIONS.contact : null,
  })
  if (!human.ok) throw new HttpError(403, 'turnstile_failed', 'Please complete the "are you human" check and try again.')

  const check = validateContact(input, cf.topics)
  if (!check.ok) throw new HttpError(400, 'invalid_input', 'Please check the highlighted fields.', { fieldErrors: check.errors })
  const m = check.value

  const h = await hashKey(canonicalMailbox(m.email), deps.secret)
  const limits: Limit[] = [
    { key: `contact:email:${h}`, max: CONTACT_RATE.perEmailHour, windowMs: HOUR },
    { key: `contact:email-day:${h}`, max: CONTACT_RATE.perEmailDay, windowMs: 24 * HOUR },
  ]
  const byEmail = await hit(db, limits, now)
  if (!byEmail.ok) throw rateLimited(byEmail.retryAfter)

  const id = crypto.randomUUID()
  const at = now.toISOString()
  await db.insert(contactMessages).values({ id, ...m, status: 'new', createdAt: at, updatedAt: at })

  await notify(deps, settings.contact.email, cf, { ...m, id, at }, now)
  if (cf.autoReply) {
    await quietly(
      () =>
        deps.mailer.sendEmail(m.email, 'contact.ack', {
          name: m.name,
          email: m.email,
          topic: m.topic,
          message: m.message,
          page: m.pagePath,
          text: cf.autoReplyText,
        }),
      'auto-reply',
    )
  }
  return answer
}

/** The addresses new messages are emailed to: the setting's, else the contact email. */
export const notifyAddresses = (contactEmail: string, notifyEmails: readonly string[]) =>
  notifyEmails.length > 0 ? [...notifyEmails] : contactEmail ? [contactEmail] : []

async function notify(
  deps: PublicContactDeps,
  contactEmail: string,
  cf: { notify: boolean; notifyEmails: string[]; notifyPerDay: number },
  m: ContactValue & { id: string; at: string },
  now: Date,
) {
  const to = cf.notify ? notifyAddresses(contactEmail, cf.notifyEmails) : []
  if (to.length === 0) return
  // One count per email sent (not per message), in a rolling day, so notifyPerDay caps the emails.
  const allowed = await take(deps.db, { key: 'contact:notify-day', max: cf.notifyPerDay, windowMs: 24 * HOUR }, to.length, now)
  if (allowed < to.length)
    console.warn(
      `[contact] notification sent to ${allowed} of ${to.length} addresses: the daily limit for contact notification emails is reached (the message is saved)`,
    )
  const url = new URL(`/admin/messages/${m.id}`, deps.siteUrl).toString()
  for (const addr of to.slice(0, allowed))
    await quietly(
      () =>
        deps.mailer.sendEmail(addr, 'contact.notify', {
          name: m.name,
          email: m.email,
          topic: m.topic,
          message: m.message,
          page: m.pagePath,
          url,
          receivedAt: m.at,
        }),
      'notification',
    )
}

async function quietly(fn: () => Promise<unknown>, what: string) {
  try {
    await fn()
  } catch (e) {
    console.warn(`[contact] ${what} email not sent: ${describeError(e)}`)
  }
}

// ── The inbox (admins and owners) ─────────────────────────────────────────────

/** What the list shows; `open` = new and read (not handled yet), the default. */
export const messageFilters = ['open', 'new', 'read', 'handled', 'all'] as const
export type MessageFilter = (typeof messageFilters)[number]

export type MessageListItem = Pick<
  ContactMessage,
  'id' | 'name' | 'email' | 'topic' | 'status' | 'pagePath' | 'createdAt' | 'handledAt'
> & {
  /** The first 160 characters, on one line. */
  preview: string
}

export type MessageList = {
  rows: MessageListItem[]
  counts: Record<ContactMessageStatus, number>
  /** Pass as `before` for the next page, or null at the end. */
  next: string | null
  topics: string[]
}

export type MessageDetail = ContactMessage & { handledByName: string | null }

const filterWhere = (filter: MessageFilter): SQL | undefined =>
  filter === 'all' ? undefined : filter === 'open' ? inArray(contactMessages.status, ['new', 'read']) : eq(contactMessages.status, filter)

/** "createdAt|id" cursor, newest first. */
const cursorWhere = (before: string | null | undefined): SQL | undefined => {
  if (!before) return undefined
  const i = before.lastIndexOf('|')
  const createdAt = before.slice(0, i)
  const id = before.slice(i + 1)
  if (i < 0 || !createdAt || !id) return undefined
  return or(lt(contactMessages.createdAt, createdAt), and(eq(contactMessages.createdAt, createdAt), lt(contactMessages.id, id)))
}

const searchWhere = (q: string | null | undefined): SQL | undefined => {
  const t = q?.trim().slice(0, 100)
  if (!t) return undefined
  const p = likePattern(t)
  return or(
    likeEscaped(contactMessages.name, p),
    likeEscaped(contactMessages.email, p),
    likeEscaped(contactMessages.message, p),
    likeEscaped(contactMessages.topic, p),
  )
}

export const parseFilter = (v: string | null | undefined): MessageFilter =>
  (messageFilters as readonly string[]).includes(v ?? '') ? (v as MessageFilter) : 'open'

/** A page of the inbox plus the counts per status: one batch of two queries. */
export async function listMessages(
  db: AppDb,
  opts: { filter?: MessageFilter; q?: string | null; before?: string | null; limit?: number; topic?: string | null } = {},
): Promise<MessageList> {
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 200)
  const topic = opts.topic?.trim() ? eq(contactMessages.topic, opts.topic.trim()) : undefined
  const [rows, counts, settingsTopics] = (await runBatch(db, [
    db
      .select({
        id: contactMessages.id,
        name: contactMessages.name,
        email: contactMessages.email,
        topic: contactMessages.topic,
        status: contactMessages.status,
        pagePath: contactMessages.pagePath,
        createdAt: contactMessages.createdAt,
        handledAt: contactMessages.handledAt,
        preview: sql<string>`substr(replace(replace(${contactMessages.message}, char(10), ' '), char(13), ' '), 1, 160)`.as('preview'),
      })
      .from(contactMessages)
      .where(and(filterWhere(opts.filter ?? 'open'), searchWhere(opts.q), cursorWhere(opts.before), topic))
      .orderBy(desc(contactMessages.createdAt), desc(contactMessages.id))
      .limit(limit + 1),
    db
      .select({ status: contactMessages.status, n: sql<number>`count(*)` })
      .from(contactMessages)
      .groupBy(contactMessages.status),
    // The topics in use, for the filter (a topic removed from Settings still has messages).
    db
      .selectDistinct({ topic: contactMessages.topic })
      .from(contactMessages)
      .where(sql`${contactMessages.topic} <> ''`)
      .orderBy(contactMessages.topic)
      .limit(50),
  ])) as unknown as [MessageListItem[], { status: ContactMessageStatus; n: number }[], { topic: string }[]]
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const byStatus = Object.fromEntries(contactMessageStatuses.map((s) => [s, 0])) as Record<ContactMessageStatus, number>
  for (const c of counts) byStatus[c.status] = Number(c.n)
  return {
    rows: page,
    counts: byStatus,
    next: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null,
    topics: settingsTopics.map((t) => t.topic),
  }
}

/** Unread (new) messages, for the nav badge and the home page. One indexed count. */
export async function unreadCount(db: AppDb): Promise<number> {
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(contactMessages)
    .where(eq(contactMessages.status, 'new'))
    .get()
  return Number(row?.n ?? 0)
}

const detailQuery = (db: AppDb, id: string) =>
  db
    .select({
      id: contactMessages.id,
      name: contactMessages.name,
      email: contactMessages.email,
      topic: contactMessages.topic,
      message: contactMessages.message,
      status: contactMessages.status,
      pagePath: contactMessages.pagePath,
      readAt: contactMessages.readAt,
      handledAt: contactMessages.handledAt,
      handledBy: contactMessages.handledBy,
      note: contactMessages.note,
      createdAt: contactMessages.createdAt,
      updatedAt: contactMessages.updatedAt,
      // Aliased: in a D1 batch rows are keyed by column name, and user.name would collide with the sender's name.
      handledByName: sql<string | null>`${user.name}`.as('handled_by_name'),
    })
    .from(contactMessages)
    .leftJoin(user, eq(user.id, contactMessages.handledBy))
    .where(eq(contactMessages.id, id))

/** One message. Opening a new one marks it read (same batch). */
export async function openMessage(db: AppDb, id: string, now = new Date()): Promise<MessageDetail> {
  const at = now.toISOString()
  const [, rows] = (await runBatch(db, [
    db
      .update(contactMessages)
      .set({ status: 'read', readAt: at, updatedAt: at })
      .where(and(eq(contactMessages.id, id), eq(contactMessages.status, 'new'))),
    detailQuery(db, id),
  ])) as unknown as [unknown, MessageDetail[]]
  const m = rows[0]
  if (!m) throw notFound('message')
  return m
}

export type MessagePatch = { status?: unknown; note?: unknown }

const parseStatus = (v: unknown): ContactMessageStatus => {
  if (!(contactMessageStatuses as readonly unknown[]).includes(v))
    throw new HttpError(400, 'invalid_input', 'Status is new, read or handled.')
  return v as ContactMessageStatus
}

/** Sets the columns for a status change: handled records when and who; back to new or read clears that. */
const statusSet = (status: ContactMessageStatus, actor: Editor, at: string) =>
  status === 'handled'
    ? { status, handledAt: at, handledBy: actor.id, updatedAt: at }
    : status === 'new'
      ? { status, handledAt: null, handledBy: null, readAt: null, updatedAt: at }
      : { status, handledAt: null, handledBy: null, readAt: sql`coalesce(${contactMessages.readAt}, ${at})`, updatedAt: at }

/** Changes one message's status and/or note. */
export async function updateMessage(db: AppDb, id: string, patch: MessagePatch, actor: Editor, now = new Date()): Promise<MessageDetail> {
  const at = now.toISOString()
  const set: Record<string, unknown> = {}
  if (patch.status !== undefined) Object.assign(set, statusSet(parseStatus(patch.status), actor, at))
  if (patch.note !== undefined) {
    if (patch.note !== null && typeof patch.note !== 'string') throw new HttpError(400, 'invalid_input', 'The note must be text.')
    const note = (patch.note ?? '').trim()
    if (note.length > 2000) throw new HttpError(400, 'invalid_input', 'The note is too long (at most 2000 characters).')
    set.note = note || null
    set.updatedAt = at
  }
  if (Object.keys(set).length === 0) throw new HttpError(400, 'invalid_input', 'Nothing to change.')
  const [, rows] = (await runBatch(db, [
    db.update(contactMessages).set(set).where(eq(contactMessages.id, id)),
    detailQuery(db, id),
  ])) as unknown as [unknown, MessageDetail[]]
  const m = rows[0]
  if (!m) throw notFound('message')
  return m
}

const parseIds = (v: unknown): string[] => {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, 'invalid_input', 'Choose some messages.')
  const ids = [...new Set(v.filter((x): x is string => typeof x === 'string' && /^[\w-]{1,64}$/.test(x)))]
  if (ids.length === 0) throw new HttpError(400, 'invalid_input', 'Choose some messages.')
  if (ids.length > MAX_BULK) throw new HttpError(400, 'invalid_input', `At most ${MAX_BULK} messages at a time.`)
  return ids
}

/** Marks several messages (one statement). Returns how many changed. */
export async function setStatuses(db: AppDb, rawIds: unknown, rawStatus: unknown, actor: Editor, now = new Date()) {
  const ids = parseIds(rawIds)
  const status = parseStatus(rawStatus)
  const rows = await db
    .update(contactMessages)
    .set(statusSet(status, actor, now.toISOString()))
    .where(inArray(contactMessages.id, ids))
    .returning({ id: contactMessages.id })
  return { changed: rows.length }
}

/**
 * Deletes messages for good (spam, or once dealt with), with an audit row in the same batch that records how many
 * and their ids, never what they said or who sent them.
 */
export async function deleteMessages(db: AppDb, rawIds: unknown, actor: Editor, now = new Date()) {
  const ids = parseIds(rawIds)
  const at = now.toISOString()
  const [, deleted] = (await runBatch(db, [
    db
      .insert(auditLog)
      .values(
        auditEntry(
          actor,
          'message.delete',
          { type: 'contact_message', id: ids.length === 1 ? ids[0]! : 'bulk' },
          null,
          { count: ids.length, ids },
          at,
        ),
      ),
    db.delete(contactMessages).where(inArray(contactMessages.id, ids)).returning({ id: contactMessages.id }),
  ])) as unknown as [unknown, { id: string }[]]
  return { deleted: deleted.length }
}

/** The most rows one export writes (a year of messages is a few hundred). */
export const EXPORT_LIMIT = 5000

/** The inbox as CSV (newest first), audited as message.export (it's everyone's names and addresses). */
export async function exportMessages(db: AppDb, actor: Editor, filter: MessageFilter, now = new Date()) {
  const rows = await db
    .select({
      createdAt: contactMessages.createdAt,
      name: contactMessages.name,
      email: contactMessages.email,
      topic: contactMessages.topic,
      status: contactMessages.status,
      message: contactMessages.message,
      pagePath: contactMessages.pagePath,
      handledAt: contactMessages.handledAt,
      note: contactMessages.note,
    })
    .from(contactMessages)
    .where(filterWhere(filter))
    .orderBy(desc(contactMessages.createdAt))
    .limit(EXPORT_LIMIT)
  await audit(db, actor, 'message.export', { type: 'contact_message', id: filter }, null, { filter, rows: rows.length }, now.toISOString())
  return { csv: messagesCsv(rows), filename: `messages-${filter}-${now.toISOString().slice(0, 10)}.csv` }
}

/** Cron: deletes messages handled longer ago than the retention period (one bounded statement, for the housekeeping batch). */
export const pruneMessagesStatement = (db: AppDb, retentionDays: number, now = new Date()) =>
  db
    .delete(contactMessages)
    .where(
      and(
        eq(contactMessages.status, 'handled'),
        isNotNull(contactMessages.handledAt),
        lt(contactMessages.handledAt, new Date(now.getTime() - retentionDays * 24 * HOUR).toISOString()),
      ),
    )
    .returning({ id: contactMessages.id })

export type InboxSummary = {
  unread: number
  /** Open (new or read) messages, newest first: the five latest. */
  open: Pick<MessageListItem, 'id' | 'name' | 'topic' | 'status' | 'createdAt'>[]
  openCount: number
}

/** For the admin home page: how many are unread and open, and the latest open ones. One batch of two queries. */
export async function inboxSummary(db: AppDb): Promise<InboxSummary> {
  const [counts, open] = (await runBatch(db, [
    db
      .select({ status: contactMessages.status, n: sql<number>`count(*)` })
      .from(contactMessages)
      .where(inArray(contactMessages.status, ['new', 'read']))
      .groupBy(contactMessages.status),
    db
      .select({
        id: contactMessages.id,
        name: contactMessages.name,
        topic: contactMessages.topic,
        status: contactMessages.status,
        createdAt: contactMessages.createdAt,
      })
      .from(contactMessages)
      .where(inArray(contactMessages.status, ['new', 'read']))
      .orderBy(desc(contactMessages.createdAt))
      .limit(5),
  ])) as unknown as [{ status: ContactMessageStatus; n: number }[], InboxSummary['open']]
  const n = (s: ContactMessageStatus) => Number(counts.find((c) => c.status === s)?.n ?? 0)
  return { unread: n('new'), openCount: n('new') + n('read'), open }
}
