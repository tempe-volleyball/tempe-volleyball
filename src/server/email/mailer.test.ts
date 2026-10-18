import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb, type TestDb } from '../db/testing'
import { adminInvites, emailDailyCount, emailOutbox, user } from '../db/schema'
import { hashInviteToken } from '../auth/roles'
import {
  AUTH_DAILY_CAP,
  AUTH_PER_DAY,
  AUTH_PER_HOUR,
  DAILY_CAP,
  EmailNotConfiguredError,
  FROM,
  MAX_ATTEMPTS,
  RESEND_URL,
  createMailer,
  emailMode,
} from './mailer'
import { renderEmail } from './templates'

const NOW = new Date('2026-10-18T03:00:00.000Z') // 14:00 in Sydney (AEDT)
const HOUR = 60 * 60 * 1000
const at = (ms: number) => new Date(NOW.getTime() + ms)
const eqHash = (hash: string) => eq(adminInvites.tokenHash, hash)

type Call = { url: string; init: RequestInit }

/** A fake fetch that answers like Resend and records each call. */
const fakeResend = (responses: Array<{ status: number; body: unknown } | Error> = []) => {
  const calls: Call[] = []
  let n = 0
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! })
    const r = responses[n++] ?? { status: 200, body: { id: `re_${n}` } }
    if (r instanceof Error) throw r
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { fn, calls }
}

const setup = (
  opts: {
    env?: { SITE_ENV: string; RESEND_API_KEY?: string }
    responses?: Parameters<typeof fakeResend>[0]
    cap?: number
    authCap?: number
  } = {},
) => {
  const { db } = createTestDb()
  const resend = fakeResend(opts.responses)
  const logs: string[] = []
  let clock = NOW
  const mailer = createMailer({
    db,
    env: opts.env ?? { SITE_ENV: 'production', RESEND_API_KEY: 're_test_key' },
    fetch: resend.fn,
    now: () => clock,
    log: (m) => logs.push(m),
    dailyCap: opts.cap,
    authDailyCap: opts.authCap,
  })
  const outbox = () => db.select().from(emailOutbox)
  const count = async () => (await db.select().from(emailDailyCount)).map((r) => [r.day, r.sent])
  return { db, mailer, resend, logs, outbox, count, setClock: (d: Date) => (clock = d) }
}

/** A pending invite (and its inviter) so invite emails for `token` are sendable. */
const addInvite = async (db: TestDb, token: string, state: Partial<typeof adminInvites.$inferInsert> = {}) => {
  await db.insert(user).values({ id: 'o', name: 'o', email: 'o@x.com', role: 'owner' }).onConflictDoNothing()
  await db.insert(adminInvites).values({
    email: `${token}@x.com`,
    role: 'editor',
    tokenHash: await hashInviteToken(token),
    invitedBy: 'o',
    expiresAt: at(7 * 24 * HOUR).toISOString(),
    ...state,
  })
}

const invite = (token = 'tok') => ({
  url: `https://x/admin/invite#${token}`,
  role: 'editor',
  invitedBy: 'M',
  expiresAt: at(7 * 24 * HOUR).toISOString(),
})

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

describe('emailMode', () => {
  it('uses Resend with a key, the console in dev and staging, and nothing in production', () => {
    expect(emailMode({ SITE_ENV: 'production', RESEND_API_KEY: 'k' })).toBe('resend')
    expect(emailMode({ SITE_ENV: 'development' })).toBe('console')
    expect(emailMode({ SITE_ENV: 'staging', RESEND_API_KEY: '' })).toBe('console')
    expect(emailMode({ SITE_ENV: 'production' })).toBe('disabled')
  })

  it("won't send real email while the public forms use Turnstile's always-pass test keys (no open relay)", () => {
    // Staging and development fall back to the test keys, so a Resend key alone keeps logging.
    expect(emailMode({ SITE_ENV: 'staging', RESEND_API_KEY: 'k' })).toBe('console')
    expect(emailMode({ SITE_ENV: 'development', RESEND_API_KEY: 'k' })).toBe('console')
    const test = { TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }
    expect(emailMode({ SITE_ENV: 'staging', RESEND_API_KEY: 'k', ...test })).toBe('console')
    // Real keys: sent.
    const real = { TURNSTILE_SITE_KEY: '0x4AAAAAAAreal', TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecret' }
    expect(emailMode({ SITE_ENV: 'staging', RESEND_API_KEY: 'k', ...real })).toBe('resend')
    // Production refuses test keys outright (the forms are off), so admin email still goes.
    expect(emailMode({ SITE_ENV: 'production', RESEND_API_KEY: 'k', ...test })).toBe('resend')
  })
})

describe('sendEmail with Resend', () => {
  it('sends a sign-in code without ever storing it, counting it against the Sydney day', async () => {
    const t = setup()
    const res = await t.mailer.sendEmail('Michael@Example.com', 'auth.otp', { otp: '123456' })
    expect(res.status).toBe('sent')
    expect(t.resend.calls).toHaveLength(1)
    const call = t.resend.calls[0]!
    expect(call.url).toBe(RESEND_URL)
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer re_test_key')
    expect(headers['Idempotency-Key']).toBe(res.id)
    const body = JSON.parse(call.init.body as string)
    expect(body).toMatchObject({ from: FROM, to: ['michael@example.com'], subject: '123456 is your Tempe Volleyball sign-in code' })
    expect(body.text).toContain('123456')
    const [row] = await t.outbox()
    expect(row).toMatchObject({ id: res.id, status: 'sent', providerId: 're_1', attempts: 1, payload: {}, sentAt: NOW.toISOString() })
    expect(JSON.stringify(row)).not.toContain('123456')
    expect(await t.count()).toEqual([['2026-10-18:auth', 1]])
    expect(t.logs).toEqual([])
  })

  it('clears an invite payload once sent', async () => {
    const t = setup()
    expect((await t.mailer.sendEmail('a@x.com', 'admin.invite', invite())).status).toBe('sent')
    expect((await t.outbox())[0]).toMatchObject({ status: 'sent', payload: {} })
    expect(await t.count()).toEqual([['2026-10-18', 1]])
  })

  it('queues other mail once its share of the cap is used, keeping the payload until sent', async () => {
    const t = setup({ cap: 3, authCap: 1 })
    expect((await t.mailer.sendEmail('a@x.com', 'admin.invite', invite('a'))).status).toBe('sent')
    expect((await t.mailer.sendEmail('b@x.com', 'admin.invite', invite('b'))).status).toBe('sent')
    const third = await t.mailer.sendEmail('c@x.com', 'admin.invite', invite('c'))
    expect(third.status).toBe('queued')
    expect(t.resend.calls).toHaveLength(2)
    const queued = (await t.outbox()).find((r) => r.id === third.id)
    expect(queued).toMatchObject({ status: 'queued', attempts: 0, payload: { url: 'https://x/admin/invite#c' } })
    // Sign-in still has its own share.
    expect((await t.mailer.sendEmail('o@x.com', 'auth.otp', { otp: '1' })).status).toBe('sent')
  })

  it("caps sign-in emails at their share, so they can't starve other mail", async () => {
    const t = setup({ cap: 3, authCap: 2 })
    expect((await t.mailer.sendEmail('a@x.com', 'auth.otp', { otp: '1' })).status).toBe('sent')
    expect((await t.mailer.sendEmail('b@x.com', 'auth.magic_link', { url: 'https://x/m' })).status).toBe('sent')
    const over = await t.mailer.sendEmail('c@x.com', 'auth.otp', { otp: '3' })
    expect(over.status).toBe('failed')
    expect((await t.outbox()).find((r) => r.id === over.id)).toMatchObject({
      status: 'failed',
      error: 'Daily email limit reached',
      attempts: 0,
      payload: {},
    })
    expect((await t.mailer.sendEmail('d@x.com', 'admin.invite', invite())).status).toBe('sent')
    expect((await t.count()).toSorted()).toEqual([
      ['2026-10-18', 1],
      ['2026-10-18:auth', 2],
    ])
  })

  it(`defaults the cap to ${DAILY_CAP}, ${AUTH_DAILY_CAP} of it for sign-in`, () => {
    expect(DAILY_CAP).toBe(95)
    expect(AUTH_DAILY_CAP).toBe(40)
  })

  it('marks immediate-only emails failed, with no payload, instead of queuing them at the cap', async () => {
    const t = setup({ cap: 1, authCap: 0 })
    await t.mailer.sendEmail('a@x.com', 'admin.invite', invite('a'))
    const res = await t.mailer.sendEmail('b@x.com', 'admin.invite', invite('b'), { immediateOnly: true })
    expect(res.status).toBe('failed')
    expect((await t.outbox()).find((r) => r.id === res.id)).toMatchObject({
      status: 'failed',
      error: 'Daily email limit reached',
      payload: {},
    })
  })

  it('a new Sydney day gets a fresh allowance', async () => {
    const t = setup({ cap: 2, authCap: 1 })
    await t.mailer.sendEmail('a@x.com', 'auth.otp', { otp: '1' })
    t.setClock(new Date('2026-10-18T13:00:00.000Z')) // 00:00 on the 19th in Sydney
    expect((await t.mailer.sendEmail('b@x.com', 'auth.otp', { otp: '2' })).status).toBe('sent')
    expect(await t.count()).toEqual([
      ['2026-10-18:auth', 1],
      ['2026-10-19:auth', 1],
    ])
  })

  it('keeps retryable failures queued and gives the slot back', async () => {
    const t = setup({ responses: [{ status: 500, body: { message: 'boom' } }] })
    const res = await t.mailer.sendEmail('a@x.com', 'admin.invite', invite())
    expect(res.status).toBe('queued')
    const [row] = await t.outbox()
    expect(row).toMatchObject({ status: 'queued', attempts: 1, error: 'Resend 500: boom' })
    expect(await t.count()).toEqual([['2026-10-18', 0]])
  })

  it('fails permanently on a 4xx, and on any failure for sign-in emails, clearing secrets', async () => {
    const t = setup({ responses: [{ status: 422, body: { message: 'bad address' } }, new Error('network down')] })
    expect((await t.mailer.sendEmail('bad', 'admin.invite', invite())).status).toBe('failed')
    expect((await t.mailer.sendEmail('a@x.com', 'auth.otp', { otp: '1' })).status).toBe('failed')
    const rows = await t.outbox()
    expect(rows.map((r) => r.error).toSorted()).toEqual(['Resend 422: bad address', 'Resend fetch failed: network down'])
    expect(rows.map((r) => r.payload)).toEqual([{}, {}])
  })
})

describe('per-recipient limit on sign-in emails', () => {
  it(`allows ${AUTH_PER_HOUR} an hour per address, any spelling, then drops them silently`, async () => {
    const t = setup()
    for (let i = 0; i < AUTH_PER_HOUR; i++) {
      t.setClock(at(i * 1000))
      const template = i % 2 ? 'auth.magic_link' : 'auth.otp'
      const res = await t.mailer.sendEmail(i % 2 ? 'Owner@X.com' : 'owner@x.com', template, i % 2 ? { url: 'https://x/m' } : { otp: '1' })
      expect(res.status).toBe('sent')
    }
    const over = await t.mailer.sendEmail(' OWNER@x.com', 'auth.otp', { otp: '999999' })
    expect(over).toEqual({ id: '', status: 'limited' })
    expect(t.resend.calls).toHaveLength(AUTH_PER_HOUR)
    expect(await t.outbox()).toHaveLength(AUTH_PER_HOUR)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('per-recipient limit'))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('999999')
    // Other addresses and other mail are unaffected.
    expect((await t.mailer.sendEmail('other@x.com', 'auth.otp', { otp: '1' })).status).toBe('sent')
    expect((await t.mailer.sendEmail('owner@x.com', 'admin.invite', invite())).status).toBe('sent')
  })

  it(`allows ${AUTH_PER_DAY} in 24 hours`, async () => {
    const t = setup()
    for (let i = 0; i < AUTH_PER_DAY; i++) {
      t.setClock(at(i * 2 * HOUR))
      expect((await t.mailer.sendEmail('owner@x.com', 'auth.otp', { otp: '1' })).status).toBe('sent')
    }
    t.setClock(at(AUTH_PER_DAY * 2 * HOUR)) // 20 h after the first
    expect((await t.mailer.sendEmail('owner@x.com', 'auth.otp', { otp: '1' })).status).toBe('limited')
    t.setClock(at(24 * HOUR + 1)) // the first has dropped out of the window
    expect((await t.mailer.sendEmail('owner@x.com', 'auth.otp', { otp: '1' })).status).toBe('sent')
  })
})

describe('sendEmail without RESEND_API_KEY', () => {
  it('logs the email, code included, in development and staging', async () => {
    for (const SITE_ENV of ['development', 'staging']) {
      const t = setup({ env: { SITE_ENV } })
      const res = await t.mailer.sendEmail('m@x.com', 'auth.otp', { otp: '654321' })
      expect(res.status).toBe('logged')
      expect(t.resend.calls).toEqual([])
      expect(t.logs).toHaveLength(1)
      expect(t.logs[0]).toContain('654321')
      expect(t.logs[0]).toContain(`[email:${SITE_ENV}] to=m@x.com template=auth.otp`)
      expect((await t.outbox())[0]).toMatchObject({ status: 'sent', providerId: 'console', payload: {} })
      expect(await t.count()).toEqual([])
    }
  })

  it('fails closed in production: throws, logs nothing, and keeps no code', async () => {
    const t = setup({ env: { SITE_ENV: 'production' } })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await expect(t.mailer.sendEmail('m@x.com', 'auth.otp', { otp: '654321' })).rejects.toBeInstanceOf(EmailNotConfiguredError)
    expect(t.logs).toEqual([])
    expect(info).not.toHaveBeenCalled()
    info.mockRestore()
    const [row] = await t.outbox()
    expect(row).toMatchObject({ status: 'failed', payload: {} })
    expect(JSON.stringify(row)).not.toContain('654321')
  })

  it("in production doesn't keep invite links: marks them failed with no payload", async () => {
    const t = setup({ env: { SITE_ENV: 'production' } })
    await expect(t.mailer.sendEmail('m@x.com', 'admin.invite', invite('secret-token'))).rejects.toThrow('RESEND_API_KEY')
    const [row] = await t.outbox()
    expect(row).toMatchObject({ status: 'failed', payload: {}, error: 'RESEND_API_KEY not set' })
    expect(JSON.stringify(row)).not.toContain('secret-token')
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 0, failed: 0, skipped: 0, remaining: 0 })
  })
})

describe('drainOutbox', () => {
  it('sends queued emails oldest first up to the cap, batching the updates', async () => {
    const t = setup({ cap: 2, authCap: 0 })
    let tick = 0
    for (const to of ['a', 'b', 'c', 'd']) {
      t.setClock(at(1000 * tick++))
      await addInvite(t.db, to)
      await t.mailer.sendEmail(`${to}@x.com`, 'admin.invite', invite(to))
    }
    // a and b went straight out; c and d are queued.
    expect(t.resend.calls).toHaveLength(2)
    t.setClock(new Date('2026-10-19T03:00:00.000Z')) // next Sydney day: a fresh allowance of 2
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 2, failed: 0, skipped: 0, remaining: 0 })
    expect(t.resend.calls.map((c) => JSON.parse(c.init.body as string).to[0])).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'])
    expect((await t.outbox()).every((r) => r.status === 'sent')).toBe(true)
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 0, failed: 0, skipped: 0, remaining: 0 })
  })

  it('stops at the cap and leaves the rest queued', async () => {
    const t = setup({ cap: 1, authCap: 0 })
    for (const to of ['a', 'b', 'c']) {
      await addInvite(t.db, to)
      await t.mailer.sendEmail(`${to}@x.com`, 'admin.invite', invite(to))
    }
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 0, failed: 0, skipped: 0, remaining: 2 })
    expect(t.resend.calls).toHaveLength(1)
  })

  it("skips invite emails whose invite was revoked, accepted, expired or doesn't exist, clearing the link", async () => {
    const t = setup({ cap: 1, authCap: 0 })
    await addInvite(t.db, 'first')
    await t.mailer.sendEmail('first@x.com', 'admin.invite', invite('first')) // uses the day's allowance
    await addInvite(t.db, 'revoked')
    await addInvite(t.db, 'accepted')
    await addInvite(t.db, 'expired', { expiresAt: at(HOUR).toISOString() })
    await addInvite(t.db, 'pending')
    for (const token of ['revoked', 'accepted', 'expired', 'missing', 'pending'])
      expect((await t.mailer.sendEmail(`${token}@x.com`, 'admin.invite', invite(token))).status).toBe('queued')
    await t.db
      .update(adminInvites)
      .set({ revokedAt: NOW.toISOString() })
      .where(eqHash(await hashInviteToken('revoked')))
    await t.db
      .update(adminInvites)
      .set({ acceptedAt: NOW.toISOString() })
      .where(eqHash(await hashInviteToken('accepted')))
    t.setClock(new Date('2026-10-19T03:00:00.000Z'))
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 1, failed: 0, skipped: 4, remaining: 0 })
    expect(JSON.parse(t.resend.calls.at(-1)!.init.body as string).to).toEqual(['pending@x.com'])
    const rows = await t.outbox()
    expect(rows.map((r) => [r.to, r.status, r.error]).filter(([, s]) => s === 'failed')).toEqual([
      ['revoked@x.com', 'failed', 'Invite is revoked'],
      ['accepted@x.com', 'failed', 'Invite is accepted'],
      ['expired@x.com', 'failed', 'Invite is expired'],
      ['missing@x.com', 'failed', 'Invite is missing'],
    ])
    expect(rows.every((r) => JSON.stringify(r.payload) === '{}')).toBe(true)
  })

  it('never sends a sign-in email late', async () => {
    const t = setup()
    await t.db.insert(emailOutbox).values({ to: 'o@x.com', template: 'auth.otp', payload: { otp: '123456' }, sendAfter: NOW.toISOString() })
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 0, failed: 0, skipped: 1, remaining: 0 })
    expect(t.resend.calls).toEqual([])
    expect((await t.outbox())[0]).toMatchObject({ status: 'failed', payload: {} })
  })

  it(`gives up after ${MAX_ATTEMPTS} failed attempts`, async () => {
    const fails = Array.from({ length: MAX_ATTEMPTS }, () => ({ status: 503, body: { message: 'down' } }))
    const t = setup({ responses: fails })
    await addInvite(t.db, 'tok')
    await t.mailer.sendEmail('a@x.com', 'admin.invite', invite())
    for (let i = 1; i < MAX_ATTEMPTS - 1; i++) expect((await t.mailer.drainOutbox()).failed).toBe(0)
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 0, failed: 1, skipped: 0, remaining: 0 })
    expect((await t.outbox())[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, payload: {} })
    expect(await t.count()).toEqual([['2026-10-18', 0]])
  })

  it('logs queued emails in console mode', async () => {
    const t = setup({ env: { SITE_ENV: 'staging' } })
    await addInvite(t.db, 'tok')
    await t.db.insert(emailOutbox).values({ to: 'q@x.com', template: 'admin.invite', payload: invite(), sendAfter: NOW.toISOString() })
    expect((await t.mailer.drainOutbox()).sent).toBe(1)
    expect(t.logs[0]).toContain('https://x/admin/invite#tok')
  })
})

describe('scrubSensitivePayloads', () => {
  const insertRow = (db: TestDb, row: Partial<typeof emailOutbox.$inferInsert> & { template: string; payload: Record<string, unknown> }) =>
    db.insert(emailOutbox).values({ to: 'x@x.com', createdAt: at(-2 * HOUR).toISOString(), ...row })

  it("clears old secrets that can't be sent any more, and leaves sendable and non-secret rows alone", async () => {
    const t = setup()
    await insertRow(t.db, { id: 'sent-otp', template: 'auth.otp', payload: { otp: '111111' }, status: 'sent' })
    await insertRow(t.db, { id: 'failed-invite', template: 'admin.invite', payload: invite('t1'), status: 'failed' })
    await insertRow(t.db, { id: 'queued-otp', template: 'auth.otp', payload: { otp: '222222' } })
    await insertRow(t.db, { id: 'queued-invite', template: 'admin.invite', payload: invite('t2') })
    await insertRow(t.db, {
      id: 'old-invite',
      template: 'admin.invite',
      payload: invite('t3'),
      createdAt: at(-8 * 24 * HOUR).toISOString(),
    })
    await insertRow(t.db, {
      id: 'fresh-failed',
      template: 'admin.invite',
      payload: invite('t4'),
      status: 'failed',
      createdAt: NOW.toISOString(),
    })
    await insertRow(t.db, { id: 'other', template: 'registration.confirmed', payload: { name: 'Sam' }, status: 'sent' })
    expect(await t.mailer.scrubSensitivePayloads()).toBe(4)
    const byId = Object.fromEntries((await t.outbox()).map((r) => [r.id, [r.status, r.payload]]))
    expect(byId).toEqual({
      'sent-otp': ['sent', {}],
      'failed-invite': ['failed', {}],
      'queued-otp': ['failed', {}],
      'queued-invite': ['queued', invite('t2')],
      'old-invite': ['failed', {}],
      'fresh-failed': ['failed', invite('t4')],
      other: ['sent', { name: 'Sam' }],
    })
    expect(await t.mailer.scrubSensitivePayloads()).toBe(0)
  })

  it('fails queued invite emails while email is disabled (the admin shows the link instead)', async () => {
    const t = setup({ env: { SITE_ENV: 'production' } })
    await insertRow(t.db, { id: 'queued-invite', template: 'admin.invite', payload: invite('t2') })
    expect(await t.mailer.scrubSensitivePayloads()).toBe(1)
    expect((await t.outbox())[0]).toMatchObject({ status: 'failed', payload: {}, error: 'RESEND_API_KEY not set' })
  })
})

describe('templates', () => {
  it('escapes HTML and shows the invite expiry in Sydney time', () => {
    const e = renderEmail('admin.invite', {
      url: 'https://x/?a=1&b=2',
      role: 'admin',
      invitedBy: '<Mike>',
      expiresAt: '2026-10-25T13:30:00.000Z',
    })
    expect(e.html).toContain('&lt;Mike&gt;')
    expect(e.html).toContain('https://x/?a=1&amp;b=2')
    expect(e.text).toContain('26 October 2026')
  })
})
