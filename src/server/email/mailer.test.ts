import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../db/testing'
import { emailDailyCount, emailOutbox } from '../db/schema'
import { DAILY_CAP, EmailNotConfiguredError, FROM, MAX_ATTEMPTS, RESEND_URL, createMailer, emailMode } from './mailer'
import { renderEmail } from './templates'

const NOW = new Date('2026-10-18T03:00:00.000Z') // 14:00 in Sydney (AEDT)

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
  opts: { env?: { SITE_ENV: string; RESEND_API_KEY?: string }; responses?: Parameters<typeof fakeResend>[0]; cap?: number } = {},
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
  })
  const outbox = () => db.select().from(emailOutbox)
  const count = async () => (await db.select().from(emailDailyCount)).map((r) => [r.day, r.sent])
  return { db, mailer, resend, logs, outbox, count, setClock: (d: Date) => (clock = d) }
}

const invite = { url: 'https://x/i', role: 'editor', invitedBy: 'M', expiresAt: NOW.toISOString() }

describe('emailMode', () => {
  it('uses Resend with a key, the console in dev and staging, and nothing in production', () => {
    expect(emailMode({ SITE_ENV: 'production', RESEND_API_KEY: 'k' })).toBe('resend')
    expect(emailMode({ SITE_ENV: 'development' })).toBe('console')
    expect(emailMode({ SITE_ENV: 'staging', RESEND_API_KEY: '' })).toBe('console')
    expect(emailMode({ SITE_ENV: 'production' })).toBe('disabled')
  })
})

describe('sendEmail with Resend', () => {
  it('records the email, sends it, counts it against the Sydney day and clears secret payloads', async () => {
    const t = setup()
    const res = await t.mailer.sendEmail('Michael@example.com', 'auth.otp', { otp: '123456' })
    expect(res.status).toBe('sent')
    expect(t.resend.calls).toHaveLength(1)
    const call = t.resend.calls[0]!
    expect(call.url).toBe(RESEND_URL)
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer re_test_key')
    expect(headers['Idempotency-Key']).toBe(res.id)
    const body = JSON.parse(call.init.body as string)
    expect(body).toMatchObject({ from: FROM, to: ['Michael@example.com'], subject: '123456 is your Tempe Volleyball sign-in code' })
    expect(body.text).toContain('123456')
    const [row] = await t.outbox()
    expect(row).toMatchObject({ id: res.id, status: 'sent', providerId: 're_1', attempts: 1, payload: {}, sentAt: NOW.toISOString() })
    expect(await t.count()).toEqual([['2026-10-18', 1]])
    expect(t.logs).toEqual([])
  })

  it('queues once the daily cap is reached, without calling Resend', async () => {
    const t = setup({ cap: 2 })
    expect((await t.mailer.sendEmail('a@x.com', 'auth.otp', { otp: '1' })).status).toBe('sent')
    expect((await t.mailer.sendEmail('b@x.com', 'auth.otp', { otp: '2' })).status).toBe('sent')
    const third = await t.mailer.sendEmail('c@x.com', 'admin.invite', invite)
    expect(third.status).toBe('queued')
    expect(t.resend.calls).toHaveLength(2)
    expect(await t.count()).toEqual([['2026-10-18', 2]])
    const queued = (await t.outbox()).find((r) => r.id === third.id)
    expect(queued).toMatchObject({ status: 'queued', attempts: 0, payload: { url: 'https://x/i' } })
  })

  it('defaults the cap to 95', () => expect(DAILY_CAP).toBe(95))

  it('marks immediate-only emails failed instead of queuing them at the cap', async () => {
    const t = setup({ cap: 1 })
    await t.mailer.sendEmail('a@x.com', 'auth.otp', { otp: '1' })
    const res = await t.mailer.sendEmail('b@x.com', 'auth.otp', { otp: '2' }, { immediateOnly: true })
    expect(res.status).toBe('failed')
    expect((await t.outbox()).find((r) => r.id === res.id)).toMatchObject({ status: 'failed', error: 'Daily email limit reached' })
  })

  it('a new Sydney day gets a fresh allowance', async () => {
    const t = setup({ cap: 1 })
    await t.mailer.sendEmail('a@x.com', 'auth.otp', { otp: '1' })
    t.setClock(new Date('2026-10-18T13:00:00.000Z')) // 00:00 on the 19th in Sydney
    expect((await t.mailer.sendEmail('b@x.com', 'auth.otp', { otp: '2' })).status).toBe('sent')
    expect(await t.count()).toEqual([
      ['2026-10-18', 1],
      ['2026-10-19', 1],
    ])
  })

  it('keeps retryable failures queued and gives the slot back', async () => {
    const t = setup({ responses: [{ status: 500, body: { message: 'boom' } }] })
    const res = await t.mailer.sendEmail('a@x.com', 'admin.invite', invite)
    expect(res.status).toBe('queued')
    const [row] = await t.outbox()
    expect(row).toMatchObject({ status: 'queued', attempts: 1, error: 'Resend 500: boom' })
    expect(await t.count()).toEqual([['2026-10-18', 0]])
  })

  it('fails permanently on a 4xx, and on any failure for immediate-only emails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = setup({ responses: [{ status: 422, body: { message: 'bad address' } }, new Error('network down')] })
    expect((await t.mailer.sendEmail('bad', 'auth.otp', { otp: '1' })).status).toBe('failed')
    expect((await t.mailer.sendEmail('a@x.com', 'auth.otp', { otp: '1' }, { immediateOnly: true })).status).toBe('failed')
    expect((await t.outbox()).map((r) => r.error).toSorted()).toEqual(['Resend 422: bad address', 'Resend fetch failed: network down'])
    warn.mockRestore()
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
    await expect(t.mailer.sendEmail('m@x.com', 'auth.otp', { otp: '654321' }, { immediateOnly: true })).rejects.toBeInstanceOf(
      EmailNotConfiguredError,
    )
    expect(t.logs).toEqual([])
    expect(info).not.toHaveBeenCalled()
    info.mockRestore()
    const [row] = await t.outbox()
    expect(row).toMatchObject({ status: 'failed', payload: {} })
    expect(JSON.stringify(row)).not.toContain('654321')
  })

  it('in production keeps non-urgent emails queued for when a key is set', async () => {
    const t = setup({ env: { SITE_ENV: 'production' } })
    await expect(t.mailer.sendEmail('m@x.com', 'admin.invite', invite)).rejects.toThrow('RESEND_API_KEY')
    expect((await t.outbox())[0]).toMatchObject({ status: 'queued' })
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 0, failed: 0, remaining: 0 })
  })
})

describe('drainOutbox', () => {
  it('sends queued emails oldest first up to the cap, batching the updates', async () => {
    const t = setup({ cap: 2 })
    let tick = 0
    for (const to of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com']) {
      t.setClock(new Date(NOW.getTime() + 1000 * tick++))
      await t.mailer.sendEmail(to, 'admin.invite', invite)
    }
    // a and b went straight out; c and d are queued.
    expect(t.resend.calls).toHaveLength(2)
    t.setClock(new Date('2026-10-19T03:00:00.000Z')) // next Sydney day: a fresh allowance of 2
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 2, failed: 0, remaining: 0 })
    expect(t.resend.calls.map((c) => JSON.parse(c.init.body as string).to[0])).toEqual(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'])
    expect((await t.outbox()).every((r) => r.status === 'sent')).toBe(true)
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 0, failed: 0, remaining: 0 })
  })

  it('stops at the cap and leaves the rest queued', async () => {
    const t = setup({ cap: 1 })
    await t.mailer.sendEmail('a@x.com', 'admin.invite', invite)
    await t.mailer.sendEmail('b@x.com', 'admin.invite', invite)
    await t.mailer.sendEmail('c@x.com', 'admin.invite', invite)
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 0, failed: 0, remaining: 2 })
    expect(t.resend.calls).toHaveLength(1)
  })

  it(`gives up after ${MAX_ATTEMPTS} failed attempts`, async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fails = Array.from({ length: MAX_ATTEMPTS }, () => ({ status: 503, body: { message: 'down' } }))
    const t = setup({ responses: fails })
    await t.mailer.sendEmail('a@x.com', 'admin.invite', invite)
    for (let i = 1; i < MAX_ATTEMPTS - 1; i++) expect((await t.mailer.drainOutbox()).failed).toBe(0)
    expect(await t.mailer.drainOutbox()).toEqual({ sent: 0, failed: 1, remaining: 0 })
    expect((await t.outbox())[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS })
    expect(await t.count()).toEqual([['2026-10-18', 0]])
    warn.mockRestore()
  })

  it('logs queued emails in console mode', async () => {
    const { db } = createTestDb()
    await db.insert(emailOutbox).values({ to: 'q@x.com', template: 'admin.invite', payload: invite })
    const logs: string[] = []
    const mailer = createMailer({ db, env: { SITE_ENV: 'staging' }, log: (m) => logs.push(m) })
    expect((await mailer.drainOutbox()).sent).toBe(1)
    expect(logs[0]).toContain('https://x/i')
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
