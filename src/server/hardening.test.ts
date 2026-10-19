import { describe, expect, it } from 'vitest'
import { canonicalMailbox } from '../lib/enrolment/validate'
import { createTestDb } from './db/testing'
import { emailDailyCount, emailOutbox, players, products, programmes, registrations, user, type UserRole } from './db/schema'
import { RoleError } from './auth/roles'
import { ENROLMENT_PER_DAY, ENROLMENT_PER_HOUR, INTEREST_ACK_PER_DAY, INTEREST_ACK_PER_HOUR, createMailer } from './email/mailer'
import { ADMIN_BODY_LIMIT, HttpError, PUBLIC_BODY_LIMIT, describeError, errorResponse, readJson, requireRole } from './http'
import { TURNSTILE_TEST_KEYS, turnstileKeys, verifyTurnstile } from './turnstile'
import { hashKey } from './ratelimit'

// The security review's hardening items that live outside the enrolment flow itself: sanitised error logs, capped
// public bodies, fresh role reads for personal data, Turnstile checks, the canonical mailbox, and the mailer's
// per-mailbox limit, priority reserve and offer holds that start when the email goes.

const NOW = new Date('2026-10-18T03:00:00.000Z')
const HOUR = 3_600_000

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof HttpError || e instanceof RoleError ? `${e.status} ${e.code}` : String(e)),
  )

describe('requireRole fresh', () => {
  it('re-reads the role for a GET when asked (personal-data reads)', async () => {
    const { db } = createTestDb()
    await db.insert(user).values({ id: 'demoted', name: 'd', email: 'd@example.com', emailVerified: true, role: 'editor' as UserRole })
    const get = new Request('https://x/api/admin/enrolment/targets', { method: 'GET' })
    // The cookie still says admin, but D1 says editor.
    expect(await codeOf(requireRole({ id: 'demoted', role: 'admin' }, 'admin', get, db, { fresh: true }))).toBe('403 forbidden')
    expect(await codeOf(requireRole({ id: 'demoted', role: 'admin' }, 'admin', get, db))).toBe('ok')
  })
})

describe('errorResponse', () => {
  it("logs a failed query's error without its bound values", async () => {
    const logged: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args)
    try {
      const cause = Object.assign(new Error('D1_ERROR: CHECK constraint failed: players params: Pat,Lee,pat@example.com'), {
        code: 'SQLITE_CONSTRAINT',
      })
      const e = new Error('Failed query: insert into "players" values (?, ?, ?)\nparams: Pat,Lee,pat@example.com,0400 000 000', { cause })
      e.name = 'DrizzleQueryError'
      expect(errorResponse(e).status).toBe(500)
      const text = logged.flat().map(String).join(' ')
      expect(text).toContain('DrizzleQueryError')
      expect(text).toContain('SQLITE_CONSTRAINT')
      expect(text).not.toMatch(/pat@example\.com|0400|Pat,Lee/)
      expect(describeError('plain params: secret')).toBe('plain')
    } finally {
      console.error = original
    }
  })
})

const post = (body: BodyInit) => new Request('https://x/api/enrol', { method: 'POST', body })
const answer = (hostname: string) => (async () => Response.json({ success: true, hostname })) as unknown as typeof fetch

describe('readJson', () => {
  it('caps public bodies with a 413, with or without Content-Length', async () => {
    expect(await readJson(post('{"a":1}'), { maxBytes: PUBLIC_BODY_LIMIT })).toEqual({ a: 1 })
    const big = JSON.stringify({ a: 'x'.repeat(PUBLIC_BODY_LIMIT) })
    expect(await codeOf(readJson(post(big), { maxBytes: PUBLIC_BODY_LIMIT }))).toBe('413 too_large')
    // A stream has no Content-Length: it's still cut off while reading.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big))
        c.close()
      },
    })
    const streamed = new Request('https://x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    expect(await codeOf(readJson(streamed, { maxBytes: 1024 }))).toBe('413 too_large')
    expect(await codeOf(readJson(post('[1]'), { maxBytes: 1024 }))).toBe('400 invalid_input')
    expect(await codeOf(readJson(post('nope'), { maxBytes: 1024 }))).toBe('400 invalid_input')
  })

  it('caps by default: 64 KB outside /api/admin (the invite and auth routes too), 1 MB on /api/admin', async () => {
    const big = JSON.stringify({ a: 'x'.repeat(PUBLIC_BODY_LIMIT) })
    const at = (path: string, body: string) => new Request(`https://x${path}`, { method: 'POST', body })
    expect(await codeOf(readJson(at('/api/invites/accept', big)))).toBe('413 too_large')
    expect(await codeOf(readJson(at('/api/enrol', big)))).toBe('413 too_large')
    expect(await readJson(at('/api/admin/pages/1', big))).toMatchObject({ a: expect.any(String) })
    const huge = JSON.stringify({ a: 'x'.repeat(ADMIN_BODY_LIMIT) })
    expect(await codeOf(readJson(at('/api/admin/pages/1', huge)))).toBe('413 too_large')
    // A route can set its own cap (the invite routes use 4 KB).
    expect(await codeOf(readJson(at('/api/invites/lookup', JSON.stringify({ token: 'x'.repeat(5000) })), { maxBytes: 4096 }))).toBe(
      '413 too_large',
    )
  })
})

describe('Turnstile', () => {
  it('refuses the test keys in production', () => {
    const test = { TURNSTILE_SITE_KEY: TURNSTILE_TEST_KEYS.siteKey, TURNSTILE_SECRET_KEY: TURNSTILE_TEST_KEYS.secretKey }
    expect(turnstileKeys({ SITE_ENV: 'production', ...test })).toBeNull()
    expect(turnstileKeys({ SITE_ENV: 'staging', ...test })).toMatchObject({ test: true })
    expect(turnstileKeys({ SITE_ENV: 'production', TURNSTILE_SITE_KEY: '0x4AAA', TURNSTILE_SECRET_KEY: '0x4BBB' })).toMatchObject({
      test: false,
    })
    expect(turnstileKeys({ SITE_ENV: 'production' })).toBeNull()
  })

  it('checks the hostname Cloudflare says the token was solved on', async () => {
    expect(await verifyTurnstile('s', 'tok', null, answer('www.tempevb.com'), { hostname: 'www.tempevb.com' })).toEqual({ ok: true })
    expect((await verifyTurnstile('s', 'tok', null, answer('evil.example'), { hostname: 'www.tempevb.com' })).ok).toBe(false)
    // The test keys answer example.com, so no hostname is passed with them.
    expect(await verifyTurnstile('s', 'tok', null, answer('example.com'))).toEqual({ ok: true })
  })

  it("checks the widget's action, so a token from another widget with our key can't be spent on the form", async () => {
    const withAction = (action?: string) =>
      (async () => Response.json({ success: true, hostname: 'www.tempevb.com', action })) as unknown as typeof fetch
    const opts = { hostname: 'www.tempevb.com', action: 'enrol' }
    expect(await verifyTurnstile('s', 'tok', null, withAction('enrol'), opts)).toEqual({ ok: true })
    expect(await verifyTurnstile('s', 'tok', null, withAction('newsletter'), opts)).toEqual({ ok: false, reason: 'action newsletter' })
    expect((await verifyTurnstile('s', 'tok', null, withAction(), opts)).ok).toBe(false)
  })
})

describe('canonicalMailbox and hashKey', () => {
  it('folds +tags, case and Gmail dots into one mailbox', () => {
    expect(canonicalMailbox('Victim+1@Gmail.com')).toBe('victim@gmail.com')
    expect(canonicalMailbox('v.i.c.t.i.m@googlemail.com')).toBe('victim@gmail.com')
    expect(canonicalMailbox('first.last+x@example.com')).toBe('first.last@example.com')
    expect(canonicalMailbox('+only@example.com')).toBe('+only@example.com')
  })

  it('refuses to hash without a salt', async () => {
    await expect(hashKey('1.2.3.4', undefined)).rejects.toThrow(/salt/)
    await expect(hashKey('1.2.3.4', '')).rejects.toThrow(/salt/)
  })
})

const resend = () => {
  const sent: string[] = []
  const fn = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init!.body)).subject as string)
    return Response.json({ id: `re_${sent.length}` })
  }) as unknown as typeof fetch
  return { fn, sent }
}

const enrolmentEmail = { name: 'Pat', programme: 'Scrim', target: 'Wed 21 Oct 2026, 6–8pm', reference: 'TVB-AAAA', position: 1 }

describe('mailer: enrolment emails', () => {
  it('limits non-priority enrolment emails per mailbox: later over the hour, dropped over the day', async () => {
    const { db } = createTestDb()
    const r = resend()
    let clock = NOW
    const mailer = createMailer({
      db,
      env: { SITE_ENV: 'production', RESEND_API_KEY: 'k' },
      fetch: r.fn,
      now: () => clock,
      hashSalt: 'salt',
    })
    const statuses: string[] = []
    const addresses = ['victim@gmail.com', 'victim+1@gmail.com', 'v.ictim@googlemail.com', 'VICTIM@gmail.com']
    for (let i = 0; i <= ENROLMENT_PER_HOUR; i++)
      statuses.push((await mailer.sendEmail(addresses[i % addresses.length]!, 'enrolment.waitlisted', enrolmentEmail)).status)
    expect(statuses.slice(0, ENROLMENT_PER_HOUR).every((x) => x === 'sent')).toBe(true)
    expect(statuses.at(-1)).toBe('queued')
    const queued = (await db.select().from(emailOutbox).all()).find((o) => o.status === 'queued')!
    expect(queued.sendAfter > NOW.toISOString()).toBe(true)
    // Priority emails (an admin action, a confirmed address) aren't limited.
    expect((await mailer.sendEmail('victim@gmail.com', 'enrolment.waitlisted', enrolmentEmail, { priority: true })).status).toBe('sent')
    // Over the day: dropped, and not stored.
    for (let h = 1; h <= 3; h++) {
      clock = new Date(NOW.getTime() + h * HOUR + 1000)
      for (let i = 0; i < ENROLMENT_PER_HOUR; i++) await mailer.sendEmail('victim@gmail.com', 'enrolment.waitlisted', enrolmentEmail)
    }
    expect((await mailer.sendEmail('victim@gmail.com', 'enrolment.waitlisted', enrolmentEmail)).status).toBe('limited')
    expect(r.sent.length).toBeLessThanOrEqual(ENROLMENT_PER_DAY + 1)
  })

  it('counts EOI acknowledgements apart from enrolment emails, so forged EOIs cannot block a confirm link', async () => {
    const { db } = createTestDb()
    const r = resend()
    let clock = NOW
    const mailer = createMailer({
      db,
      env: { SITE_ENV: 'production', RESEND_API_KEY: 'k' },
      fetch: r.fn,
      now: () => clock,
      hashSalt: 'salt',
    })
    const ack = { name: 'Pat', reference: 'EOI-AAAA', kind: 'player' as const, programmes: ['TNL'], text: 'Thanks.' }
    const statuses: string[] = []
    for (let h = 0; h < 3; h++) {
      clock = new Date(NOW.getTime() + h * HOUR + 1000)
      for (let i = 0; i < INTEREST_ACK_PER_HOUR + 2; i++)
        statuses.push((await mailer.sendEmail('victim+eoi@gmail.com', 'interest.ack', ack)).status)
    }
    expect(statuses.slice(0, INTEREST_ACK_PER_HOUR).every((x) => x === 'sent')).toBe(true)
    expect(statuses[INTEREST_ACK_PER_HOUR]).toBe('queued')
    expect(statuses.at(-1)).toBe('limited')
    expect(statuses.filter((x) => x === 'sent').length).toBeLessThanOrEqual(INTEREST_ACK_PER_DAY)
    // The same mailbox still gets its enrolment emails, up to their own limit.
    const confirm = {
      name: 'Pat',
      programme: 'Scrim',
      target: 'Wed 21 Oct 2026',
      url: 'https://x/enrol/confirm#t',
      expiresAt: NOW.toISOString(),
    }
    for (let i = 0; i < ENROLMENT_PER_HOUR; i++)
      expect((await mailer.sendEmail('victim@gmail.com', 'enrolment.confirm_email', confirm)).status).toBe('sent')
  })

  it('keeps part of the daily pool for priority emails', async () => {
    const { db } = createTestDb()
    const r = resend()
    // General pool 10 (cap 12 − auth 2), 4 of it kept back.
    const mailer = createMailer({
      db,
      env: { SITE_ENV: 'production', RESEND_API_KEY: 'k' },
      fetch: r.fn,
      now: () => NOW,
      dailyCap: 12,
      authDailyCap: 2,
      priorityReserve: 4,
    })
    const out: string[] = []
    for (let i = 0; i < 7; i++) out.push((await mailer.sendEmail(`p${i}@example.com`, 'enrolment.waitlisted', enrolmentEmail)).status)
    expect(out).toEqual(['sent', 'sent', 'sent', 'sent', 'sent', 'sent', 'queued'])
    const offer = { ...enrolmentEmail, url: 'https://x/enrol/offer#t', expiresAt: new Date(NOW.getTime() + 48 * HOUR).toISOString() }
    for (let i = 0; i < 4; i++) expect((await mailer.sendEmail(`o${i}@example.com`, 'enrolment.offer', offer)).status).toBe('sent')
    expect((await mailer.sendEmail('o9@example.com', 'enrolment.offer', offer)).status).toBe('queued')
    expect((await db.select().from(emailDailyCount).all()).find((d) => !d.day.endsWith(':auth'))!.sent).toBe(10)
  })

  it('starts an offer hold when its email actually goes, and drops emails for offers that are gone', async () => {
    const { db } = createTestDb()
    await db
      .insert(programmes)
      .values({ id: 'p1', code: 'SCT', name: 'Scrim', slug: 'scrim', weekday: 3, kind: 'training', categoryId: 'cat_adult_training' })
    await db.insert(products).values({ id: 'pr1', kind: 'training_session', name: 'x', slug: 'x', priceCents: 0, programmeId: 'p1' })
    await db.insert(players).values([
      { id: 'pl1', firstName: 'A', lastName: 'B', email: 'a@example.com' },
      { id: 'pl2', firstName: 'C', lastName: 'D', email: 'c@example.com' },
    ])
    const offeredAt = NOW.toISOString()
    const expires = new Date(NOW.getTime() + 48 * HOUR).toISOString()
    await db.insert(registrations).values([
      { id: 'r1', productId: 'pr1', playerId: 'pl1', status: 'offered', reference: 'TVB-0001', offeredAt, offerExpiresAt: expires },
      { id: 'r2', productId: 'pr1', playerId: 'pl2', status: 'cancelled', reference: 'TVB-0002', offeredAt, offerExpiresAt: null },
    ])
    const mailer = createMailer({ db, env: { SITE_ENV: 'production', RESEND_API_KEY: 'k' }, fetch: resend().fn, now: () => later })
    const payload = (id: string) => ({
      ...enrolmentEmail,
      url: 'https://x/enrol/offer#t',
      expiresAt: expires,
      hold: { type: 'registration' as const, id, offeredAt, hours: 48 },
    })
    // Queued at the offer (the day's cap was used up), sent 30 hours later.
    await db.batch([
      mailer.queueStatement('a@example.com', 'enrolment.offer', payload('r1'), NOW),
      mailer.queueStatement('c@example.com', 'enrolment.offer', payload('r2'), NOW),
    ])
    const later = new Date(NOW.getTime() + 30 * HOUR)
    const counts = await mailer.drainOutbox()
    expect(counts).toMatchObject({ sent: 1, skipped: 1 })
    const r1 = (await db.select().from(registrations).all()).find((r) => r.id === 'r1')!
    expect(r1.offerExpiresAt).toBe(new Date(later.getTime() + 48 * HOUR).toISOString())
    const rows = await db.select().from(emailOutbox).all()
    expect(rows.find((o) => o.to === 'c@example.com')!.error).toBe('Offer no longer open')
    // Old sent and failed emails are pruned after the retention days; queued ones stay.
    expect((await mailer.pruneStatement(0, new Date(later.getTime() + 1000))).length).toBe(2)
  })
})
