import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTestDb } from '../db/testing'
import * as schema from '../db/schema'
import { createMailer } from '../email'
import { renderEmail } from '../email/templates'
import { HttpError } from '../http'
import { runHousekeeping } from '../cron'
import { DEFAULT_SETTINGS } from '../../lib/content/settings'
import {
  CONTACT_RATE,
  deleteMessages,
  exportMessages,
  inboxSummary,
  listMessages,
  openMessage,
  setStatuses,
  submitContact,
  unreadCount,
  updateMessage,
  type PublicContactDeps,
} from './messages'

// The contact form end to end against a migrated in-memory SQLite: storing, Turnstile, the honeypot, rate limits,
// notifications (and their daily limit), the automatic reply, the inbox actions, the audit rows and the cron prune.

const NOW = new Date('2026-10-19T03:00:00.000Z') // 2pm Sydney
const DAY = 24 * 3_600_000
const turnstileOk = (async () => Response.json({ success: true })) as unknown as typeof fetch
const turnstileNo = (async () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] })) as unknown as typeof fetch

async function setup(contactForm: Partial<typeof DEFAULT_SETTINGS.contactForm> = {}) {
  const { db, stats } = createTestDb()
  const logs: string[] = []
  const mailer = createMailer({ db, env: { SITE_ENV: 'development' }, now: () => NOW, log: (m) => logs.push(m), hashSalt: 'salt' })
  await db.insert(schema.user).values({ id: 'admin1', name: 'Michael', email: 'michael@example.com', emailVerified: true, role: 'admin' })
  if (Object.keys(contactForm).length)
    await db
      .insert(schema.siteSettings)
      .values({ key: 'contactForm', value: { ...DEFAULT_SETTINGS.contactForm, ...contactForm }, updatedAt: NOW.toISOString() })
  const deps = (over: Partial<PublicContactDeps> = {}): PublicContactDeps => ({
    db,
    mailer,
    secret: 'secret',
    siteUrl: 'https://staging.example',
    turnstileSecret: 'ts',
    ip: '203.0.113.9',
    fetch: turnstileOk,
    now: NOW,
    ...over,
  })
  const rows = () => db.select().from(schema.contactMessages)
  const sent = (template: string) => logs.filter((l) => l.includes(`template=${template}`))
  return { db, stats, logs, deps, rows, sent }
}

const msg = (over: Record<string, unknown> = {}) => ({
  name: 'Pat Lee',
  email: 'pat@example.com',
  topic: 'Juniors',
  message: 'Is there room in JDP?',
  pagePath: '/contact',
  turnstileToken: 'tok',
  website: '',
  ...over,
})

const failsWith = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpError)
  expect((e as HttpError).status).toBe(status)
  if (code) expect((e as HttpError).code).toBe(code)
  return e as HttpError
}

describe('submitContact', () => {
  it('stores the message, emails the contact address and answers with the thank-you text, inside the limits', async () => {
    const s = await setup()
    s.stats.reset()
    const r = await submitContact(s.deps(), msg())
    expect(r).toEqual({ status: 'sent', message: DEFAULT_SETTINGS.contactForm.successText })
    expect(s.stats.queries).toBeLessThanOrEqual(15)
    expect(s.stats.maxParams).toBeLessThanOrEqual(100)
    const [m] = await s.rows()
    expect(m).toMatchObject({ name: 'Pat Lee', email: 'pat@example.com', topic: 'Juniors', status: 'new', pagePath: '/contact' })
    const notes = s.sent('contact.notify')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(`to=${DEFAULT_SETTINGS.contact.email}`)
    expect(notes[0]).toContain(`https://staging.example/admin/messages/${m!.id}`)
    expect(s.sent('contact.ack')).toHaveLength(0)
  })

  it('discards a filled-in honeypot silently: same answer, no row, no email, no Turnstile call', async () => {
    const s = await setup()
    let called = false
    const spy = (async () => ((called = true), Response.json({ success: true }))) as unknown as typeof fetch
    const r = await submitContact(s.deps({ fetch: spy }), msg({ website: 'http://spam.example' }))
    expect(r.status).toBe('sent')
    expect(await s.rows()).toHaveLength(0)
    expect(s.logs).toHaveLength(0)
    expect(called).toBe(false)
  })

  it('refuses a failed Turnstile check, bad fields, no Turnstile keys and a switched-off form, storing nothing', async () => {
    const s = await setup()
    await failsWith(submitContact(s.deps({ fetch: turnstileNo }), msg()), 403, 'turnstile_failed')
    const bad = await failsWith(submitContact(s.deps(), msg({ email: 'nope', topic: 'Not a topic' })), 400, 'invalid_input')
    expect(Object.keys((bad.details?.fieldErrors ?? {}) as object).toSorted()).toEqual(['email', 'topic'])
    await failsWith(submitContact(s.deps({ turnstileSecret: null }), msg()), 503, 'unavailable')
    expect(await s.rows()).toHaveLength(0)

    const off = await setup({ enabled: false })
    await failsWith(submitContact(off.deps(), msg()), 503, 'unavailable')
    expect(await off.rows()).toHaveLength(0)
  })

  it('limits per IP before Turnstile, and per mailbox (+tags and Gmail dots count as one)', async () => {
    const s = await setup()
    for (let i = 0; i < CONTACT_RATE.perIpHour; i++) await submitContact(s.deps({ fetch: turnstileNo }), msg()).catch(() => null)
    await failsWith(submitContact(s.deps(), msg()), 429, 'rate_limited')

    const t = await setup()
    const emails = ['p.at@gmail.com', 'pat+1@gmail.com', 'pat@googlemail.com', 'PAT@gmail.com', 'pat+x@gmail.com']
    for (const [i, email] of emails.entries()) await submitContact(t.deps({ ip: `198.51.100.${i}` }), msg({ email }))
    await failsWith(submitContact(t.deps({ ip: '198.51.100.99' }), msg({ email: 'pa.t@gmail.com' })), 429, 'rate_limited')
    expect(await t.rows()).toHaveLength(CONTACT_RATE.perEmailHour)
  })

  it('emails the chosen addresses, at most notifyPerDay emails a day (not messages), and still stores the rest', async () => {
    const s = await setup({ notifyEmails: ['a@example.com', 'b@example.com'], notifyPerDay: 3 })
    await submitContact(s.deps(), msg())
    await submitContact(s.deps({ ip: '198.51.100.7' }), msg({ email: 'sam@example.com' }))
    await submitContact(s.deps({ ip: '198.51.100.8' }), msg({ email: 'jo@example.com' }))
    expect(await s.rows()).toHaveLength(3)
    const notes = s.sent('contact.notify')
    // Two for the first message, one of two for the second, none for the third.
    expect(notes.map((l) => /to=(\S+)/.exec(l)?.[1])).toEqual(['a@example.com', 'b@example.com', 'a@example.com'])
  })

  it('sends no notification when notifications are off, and the automatic reply only when it is on', async () => {
    const quiet = await setup({ notify: false })
    await submitContact(quiet.deps(), msg())
    expect(quiet.logs).toHaveLength(0)

    const ack = await setup({ autoReply: true, autoReplyText: 'Thanks! We reply within a week.' })
    await submitContact(ack.deps(), msg())
    const replies = ack.sent('contact.ack')
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain('to=pat@example.com')
    expect(replies[0]).toContain('Thanks! We reply within a week.')
    expect(replies[0]).toContain('> Is there room in JDP?')
  })
})

describe('contact emails', () => {
  it('sets reply-to on the notification, so replying answers the sender, and escapes the message', () => {
    const e = renderEmail('contact.notify', {
      name: 'Pat <b>',
      email: 'pat@example.com',
      topic: 'Juniors',
      message: '<script>x</script>\nline 2',
      url: 'https://x/admin/messages/1',
      receivedAt: NOW.toISOString(),
    })
    expect(e.replyTo).toBe('pat@example.com')
    expect(e.subject).toBe('Message from Pat <b> (Juniors)')
    expect(e.html).not.toContain('<script>')
    expect(e.html).toContain('&lt;script&gt;')
    expect(e.text).toContain('> line 2')
  })
})

describe('the inbox', () => {
  async function withMessages() {
    const s = await setup()
    for (const [i, name] of ['Ann', 'Ben', 'Cat'].entries())
      await submitContact(
        s.deps({ ip: `198.51.100.${i}`, now: new Date(NOW.getTime() + i * 60_000) }),
        msg({ name, email: `${name.toLowerCase()}@example.com`, topic: i === 2 ? 'General' : 'Juniors' }),
      )
    const ids = Object.fromEntries((await s.rows()).map((r) => [r.name, r.id]))
    return { ...s, ids: ids as Record<'Ann' | 'Ben' | 'Cat', string> }
  }
  const actor = { id: 'admin1', ip: '127.0.0.1' }

  it('lists newest first with counts, searches, filters by topic and pages with a cursor', async () => {
    const s = await withMessages()
    const all = await listMessages(s.db)
    expect(all.rows.map((r) => r.name)).toEqual(['Cat', 'Ben', 'Ann'])
    expect(all.counts).toEqual({ new: 3, read: 0, handled: 0 })
    expect(all.rows[0]).toMatchObject({ preview: 'Is there room in JDP?', email: 'cat@example.com', topic: 'General' })
    expect(all.topics).toEqual(['General', 'Juniors'])
    expect((await listMessages(s.db, { q: 'ben@' })).rows.map((r) => r.name)).toEqual(['Ben'])
    expect((await listMessages(s.db, { topic: 'General' })).rows.map((r) => r.name)).toEqual(['Cat'])
    const page1 = await listMessages(s.db, { limit: 2 })
    expect(page1.rows.map((r) => r.name)).toEqual(['Cat', 'Ben'])
    const page2 = await listMessages(s.db, { limit: 2, before: page1.next })
    expect(page2.rows.map((r) => r.name)).toEqual(['Ann'])
    expect(page2.next).toBeNull()
  })

  it('marks a message read when opened, handled with who and when, and back again', async () => {
    const s = await withMessages()
    expect(await unreadCount(s.db)).toBe(3)
    const opened = await openMessage(s.db, s.ids.Ann, NOW)
    expect(opened).toMatchObject({ status: 'read', readAt: NOW.toISOString(), message: 'Is there room in JDP?' })
    expect(await unreadCount(s.db)).toBe(2)
    const done = await updateMessage(s.db, s.ids.Ann, { status: 'handled', note: '  Replied 19/10  ' }, actor, NOW)
    expect(done).toMatchObject({ status: 'handled', handledBy: 'admin1', handledByName: 'Michael', note: 'Replied 19/10' })
    const back = await updateMessage(s.db, s.ids.Ann, { status: 'read' }, actor, NOW)
    expect(back).toMatchObject({ status: 'read', handledAt: null, handledBy: null, readAt: NOW.toISOString() })
    await expect(updateMessage(s.db, s.ids.Ann, { status: 'spam' }, actor)).rejects.toThrow('Status is new, read or handled.')
    await expect(openMessage(s.db, 'missing')).rejects.toThrow("That message doesn't exist")

    expect(await setStatuses(s.db, [s.ids.Ben, s.ids.Cat], 'handled', actor, NOW)).toEqual({ changed: 2 })
    expect((await listMessages(s.db)).rows.map((r) => r.name)).toEqual(['Ann'])
    expect(await inboxSummary(s.db)).toMatchObject({ unread: 0, openCount: 1 })
  })

  it('deletes for good with an audit row that holds no names, addresses or text, and audits the export', async () => {
    const s = await withMessages()
    expect(await deleteMessages(s.db, [s.ids.Ann, s.ids.Ben, 'not-there'], actor, NOW)).toEqual({ deleted: 2 })
    expect((await s.rows()).map((r) => r.name)).toEqual(['Cat'])
    const [del] = await s.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'message.delete'))
    const text = JSON.stringify(del)
    expect(text).not.toMatch(/Ann|Ben|example\.com|JDP/)
    expect(del?.after).toMatchObject({ count: 3 })
    await expect(deleteMessages(s.db, [], actor)).rejects.toThrow('Choose some messages.')
    await expect(
      deleteMessages(
        s.db,
        Array.from({ length: 91 }, (_, i) => `m${i}`),
        actor,
      ),
    ).rejects.toThrow('At most 90')

    const { csv, filename } = await exportMessages(s.db, actor, 'all', NOW)
    expect(csv.split('\r\n')[1]).toContain('"Cat"')
    expect(filename).toBe('messages-all-2026-10-19.csv')
    const [exp] = await s.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'message.export'))
    expect(exp).toMatchObject({ actorUserId: 'admin1', after: { filter: 'all', rows: 1 } })
  })

  it('the cron deletes handled messages after the retention period and keeps open ones', async () => {
    const s = await withMessages()
    const old = new Date(NOW.getTime() - 366 * DAY)
    await setStatuses(s.db, [s.ids.Ann], 'handled', actor, old)
    await setStatuses(s.db, [s.ids.Ben], 'handled', actor, NOW)
    // Cat stays open, however old.
    await s.db.update(schema.contactMessages).set({ createdAt: old.toISOString() }).where(eq(schema.contactMessages.id, s.ids.Cat))
    const r = await runHousekeeping(s.db, {}, NOW)
    expect(r.messagesPruned).toBe(1)
    expect((await s.rows()).map((m) => m.name).toSorted()).toEqual(['Ben', 'Cat'])
  })
})
