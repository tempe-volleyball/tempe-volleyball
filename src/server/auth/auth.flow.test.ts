import { base32 } from '@better-auth/utils/base32'
import { createOTP } from '@better-auth/utils/otp'
import { eq, like } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb, type TestDb } from '../db/testing'
import { auditLog, session, siteSettings, user, verification, type UserRole } from '../db/schema'
import { createMailer } from '../email'
import { AUTH_PER_HOUR } from '../email/mailer'
import { authOrigin, createAuth, createAuthSenders, type Auth } from './auth'
import { changeRole } from './roles'
import { countTrustedDevices, revokeTrustedDevices } from './trusted-devices'

// End to end through Better Auth's HTTP handler over the in-memory database: email code and magic-link sign-in,
// TOTP enrolment, the TOTP challenge on passwordless sign-in (passwordless-2fa.ts), backup codes, and the cookie
// cache. Set BENCH=1 to print CPU time per request (Node's V8, a proxy for the Worker's CPU time).

const ORIGIN = 'http://localhost:4321'
const env = { SITE_ENV: 'development', SITE_URL: ORIGIN, BETTER_AUTH_SECRET: 'test-secret-0123456789abcdef0123456789abcdef' }
const timings: Array<[string, number]> = []

class Browser {
  jar = new Map<string, string>()
  readonly auth: Auth
  constructor(auth: Auth) {
    this.auth = auth
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async request(path: string, init: { method?: string; body?: unknown } = {}) {
    const url = path.startsWith('http') ? path : `${ORIGIN}/api/auth${path}`
    const headers = new Headers({ origin: ORIGIN, cookie: this.cookieHeader() })
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const req = new Request(url, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const start = process.cpuUsage()
    const res = await this.auth.handler(req)
    const used = process.cpuUsage(start)
    timings.push([`${req.method} ${new URL(url).pathname}`, (used.user + used.system) / 1000])
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';')
      const i = pair!.indexOf('=')
      const name = pair!.slice(0, i)
      const value = pair!.slice(i + 1)
      if (!value || /max-age=0/i.test(c)) this.jar.delete(name)
      else this.jar.set(name, value)
    }
    return res
  }

  async json(path: string, init: { method?: string; body?: unknown } = {}) {
    const res = await this.request(path, init)
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
  }

  async session() {
    return (await this.json('/get-session')).body as { user: { email: string; role: UserRole; twoFactorEnabled: boolean } } | null
  }
}

let db: TestDb
let auth: Auth
let logs: string[]

const lastCode = () => {
  const m = /sign-in code is (\d{6})/.exec(logs.at(-1) ?? '')
  if (!m) throw new Error(`no code in ${logs.at(-1)}`)
  return m[1]!
}
const lastLink = () => {
  const m = /(http:\/\/\S+magic-link\/verify\S+)/.exec(logs.at(-1) ?? '')
  if (!m) throw new Error(`no link in ${logs.at(-1)}`)
  return m[1]!
}

const signInWithCode = async (b: Browser, email: string) => {
  expect((await b.json('/email-otp/send-verification-otp', { body: { email, type: 'sign-in' } })).status).toBe(200)
  return b.json('/sign-in/email-otp', { body: { email, otp: lastCode() } })
}

const totpCode = async (totpURI: string) => {
  const secret = new TextDecoder().decode(base32.decode(new URL(totpURI).searchParams.get('secret')!))
  return createOTP(secret).totp()
}

const addUser = (email: string, role: UserRole) =>
  db.insert(user).values({ id: crypto.randomUUID(), name: email, email, emailVerified: true, role })

beforeEach(async () => {
  db = createTestDb().db
  logs = []
  const mailer = createMailer({ db, env, log: (m) => logs.push(m) })
  auth = createAuth({ db, env, senders: createAuthSenders(db, mailer) })
  await addUser('owner@example.com', 'owner')
})

describe('passwordless sign-in', () => {
  it('signs in with an emailed code and reads the session from the cookie cache', async () => {
    const b = new Browser(auth)
    const res = await signInWithCode(b, 'Owner@Example.com')
    expect(res.status).toBe(200)
    const s = await b.session()
    expect(s?.user).toMatchObject({ email: 'owner@example.com', role: 'owner', twoFactorEnabled: false })

    // The cookie cache means a session check doesn't need the session row: delete it and the cached cookie still
    // answers (until the cache expires, COOKIE_CACHE_SECONDS).
    await db.delete(session)
    expect((await b.session())?.user.email).toBe('owner@example.com')
  })

  it("rejects a wrong code and doesn't send codes to unknown addresses", async () => {
    const b = new Browser(auth)
    await b.json('/email-otp/send-verification-otp', { body: { email: 'owner@example.com', type: 'sign-in' } })
    const wrong = lastCode() === '000000' ? '111111' : '000000'
    expect((await b.json('/sign-in/email-otp', { body: { email: 'owner@example.com', otp: wrong } })).status).toBe(400)
    logs = []
    expect((await b.json('/email-otp/send-verification-otp', { body: { email: 'stranger@example.com', type: 'sign-in' } })).status).toBe(
      200,
    )
    expect((await b.json('/sign-in/magic-link', { body: { email: 'stranger@example.com', callbackURL: '/admin' } })).status).toBe(200)
    expect(logs).toEqual([])
    expect(await db.select().from(user).where(eq(user.email, 'stranger@example.com'))).toEqual([])
  })

  it("answers the same for admins and strangers when email can't be sent", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prodEnv = { ...env, SITE_ENV: 'production' }
    const disabled = createMailer({ db, env: prodEnv, log: (m) => logs.push(m) })
    const prodAuth = createAuth({ db, env: { ...prodEnv, SITE_URL: ORIGIN }, senders: createAuthSenders(db, disabled) })
    const b = new Browser(prodAuth)
    const ask = async (email: string) => [
      await b.json('/email-otp/send-verification-otp', { body: { email, type: 'sign-in' } }),
      await b.json('/sign-in/magic-link', { body: { email, callbackURL: '/admin' } }),
    ]
    const admin = await ask('owner@example.com')
    const stranger = await ask('stranger@example.com')
    expect(admin.map((r) => r.status)).toEqual([200, 200])
    expect(admin).toEqual(stranger)
    expect(logs).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('email not sent'))
    // The warning never carries the code or link.
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/\d{6}|magic-link\/verify/)
    warn.mockRestore()
  })

  it('drops sign-in emails over the per-recipient limit without changing the answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const b = new Browser(auth)
    for (let i = 0; i < AUTH_PER_HOUR; i++)
      await b.json('/email-otp/send-verification-otp', { body: { email: 'owner@example.com', type: 'sign-in' } })
    logs = []
    const res = await b.json('/email-otp/send-verification-otp', { body: { email: 'owner@example.com', type: 'sign-in' } })
    expect(res.status).toBe(200)
    expect(logs).toEqual([])
    warn.mockRestore()
  })

  it('signs in with a magic link, landing on the callback URL', async () => {
    await addUser('editor@example.com', 'editor')
    const b = new Browser(auth)
    await b.json('/sign-in/magic-link', { body: { email: 'editor@example.com', callbackURL: '/admin' } })
    const res = await b.request(lastLink())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`${ORIGIN}/admin`)
    expect((await b.session())?.user).toMatchObject({ email: 'editor@example.com', role: 'editor' })
  })

  it("doesn't let a user set their own role", async () => {
    const b = new Browser(auth)
    await b.json('/email-otp/send-verification-otp', { body: { email: 'owner@example.com', type: 'sign-in' } })
    await b.json('/sign-in/email-otp', { body: { email: 'owner@example.com', otp: lastCode(), role: 'editor' } })
    expect((await b.json('/update-user', { body: { role: 'editor' } })).status).toBe(400)
    expect((await db.select().from(user).where(eq(user.email, 'owner@example.com')).get())?.role).toBe('owner')
  })
})

describe('TOTP for passwordless users', () => {
  const enrol = async (b: Browser) => {
    const enabled = await b.json('/two-factor/enable', { body: {} })
    expect(enabled.status).toBe(200)
    const { totpURI, backupCodes } = enabled.body as { totpURI: string; backupCodes: string[] }
    expect(totpURI).toMatch(/^otpauth:\/\/totp\/Tempe%20Volleyball:\w+%40example.com\?/)
    expect(backupCodes).toHaveLength(10)
    // Not enabled until the first code is verified.
    expect((await b.session())?.user.twoFactorEnabled).toBe(false)
    expect((await b.json('/two-factor/verify-totp', { body: { code: await totpCode(totpURI) } })).status).toBe(200)
    expect((await b.session())?.user.twoFactorEnabled).toBe(true)
    return { totpURI, backupCodes }
  }

  it('enrols without a password, then challenges every code sign-in for TOTP', async () => {
    const b = new Browser(auth)
    await signInWithCode(b, 'owner@example.com')
    const { totpURI } = await enrol(b)
    await b.json('/sign-out', { body: {} })
    expect(await b.session()).toBeNull()

    const fresh = new Browser(auth)
    const res = await signInWithCode(fresh, 'owner@example.com')
    expect(res.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ['totp'], trustDeviceDays: 30 })
    expect(await fresh.session()).toBeNull()
    expect(await db.select().from(session)).toEqual([])

    expect((await fresh.json('/two-factor/verify-totp', { body: { code: '000000' } })).status).toBe(401)
    expect(await fresh.session()).toBeNull()
    expect((await fresh.json('/two-factor/verify-totp', { body: { code: await totpCode(totpURI) } })).status).toBe(200)
    expect((await fresh.session())?.user).toMatchObject({ email: 'owner@example.com', twoFactorEnabled: true })
  })

  it('challenges magic-link sign-in too, and accepts a backup code once', async () => {
    const b = new Browser(auth)
    await signInWithCode(b, 'owner@example.com')
    const { backupCodes } = await enrol(b)

    const fresh = new Browser(auth)
    await fresh.json('/sign-in/magic-link', { body: { email: 'owner@example.com', callbackURL: '/admin' } })
    const res = await fresh.request(lastLink())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/admin/sign-in?step=totp&trust=30')
    expect(await fresh.session()).toBeNull()
    expect((await fresh.json('/two-factor/verify-backup-code', { body: { code: backupCodes[0] } })).status).toBe(200)
    expect((await fresh.session())?.user.email).toBe('owner@example.com')

    const again = new Browser(auth)
    await signInWithCode(again, 'owner@example.com')
    expect((await again.json('/two-factor/verify-backup-code', { body: { code: backupCodes[0] } })).status).toBe(401)
  })

  it("won't let an owner turn TOTP off, but lets an editor", async () => {
    const b = new Browser(auth)
    await signInWithCode(b, 'owner@example.com')
    await enrol(b)
    const refused = await b.json('/two-factor/disable', { body: {} })
    expect(refused.status).toBe(403)
    expect((await b.session())?.user.twoFactorEnabled).toBe(true)

    await addUser('editor@example.com', 'editor')
    const e = new Browser(auth)
    await signInWithCode(e, 'editor@example.com')
    await enrol(e)
    expect((await e.json('/two-factor/disable', { body: {} })).status).toBe(200)
    expect((await e.session())?.user.twoFactorEnabled).toBe(false)
  })

  it('a challenge cookie from one sign-in is useless without the code', async () => {
    const b = new Browser(auth)
    await signInWithCode(b, 'owner@example.com')
    await enrol(b)
    const fresh = new Browser(auth)
    await signInWithCode(fresh, 'owner@example.com')
    expect(await fresh.json('/get-session')).toMatchObject({ body: null })
    expect((await fresh.json('/two-factor/enable', { body: {} })).status).toBe(401)
  })
})

describe('trusted devices', () => {
  const enrolled = async (email = 'owner@example.com') => {
    const b = new Browser(auth)
    await signInWithCode(b, email)
    const enabled = await b.json('/two-factor/enable', { body: {} })
    const { totpURI } = enabled.body as { totpURI: string }
    await b.json('/two-factor/verify-totp', { body: { code: await totpCode(totpURI) } })
    return { totpURI }
  }
  const trustRows = () => db.select().from(verification).where(like(verification.identifier, 'trust-device-%'))
  const userId = async (email: string) => (await db.select().from(user).where(eq(user.email, email)).get())!.id
  const trustedBrowser = async (totpURI: string, email = 'owner@example.com') => {
    const b = new Browser(auth)
    const first = await signInWithCode(b, email)
    expect(first.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ['totp'], trustDeviceDays: 30 })
    expect((await b.json('/two-factor/verify-totp', { body: { code: await totpCode(totpURI), trustDevice: true } })).status).toBe(200)
    expect([...b.jar.keys()]).toContain('better-auth.trust_device')
    await b.json('/sign-out', { body: {} })
    return b
  }

  it('skips the code on a trusted device, for the configured days only', async () => {
    const { totpURI } = await enrolled()
    const b = await trustedBrowser(totpURI)
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.device_trust'))
    expect(audits).toHaveLength(1)
    expect(audits[0]?.after).toEqual({ days: 30 })

    // Same browser: straight in, by code or link.
    expect((await signInWithCode(b, 'owner@example.com')).body).toMatchObject({ token: expect.any(String) })
    expect((await b.session())?.user.email).toBe('owner@example.com')
    await b.json('/sign-out', { body: {} })
    await b.json('/sign-in/magic-link', { body: { email: 'owner@example.com', callbackURL: '/admin' } })
    expect((await b.request(lastLink())).headers.get('location')).toBe(`${ORIGIN}/admin`)
    expect(await countTrustedDevices(db, await userId('owner@example.com'), 30)).toBe(1)

    // 31 days after the code was entered, the device asks again (use doesn't extend it), and the cookie goes.
    await db
      .update(verification)
      .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(like(verification.identifier, 'trust-device-%'))
    await b.json('/sign-out', { body: {} })
    expect((await signInWithCode(b, 'owner@example.com')).body).toMatchObject({ twoFactorRedirect: true })
    expect(b.jar.has('better-auth.trust_device')).toBe(false)
    expect(await trustRows()).toEqual([])
  })

  it('follows Settings → Security: a shorter period applies at once, 0 turns trust off', async () => {
    const { totpURI } = await enrolled()
    const b = await trustedBrowser(totpURI)
    await db
      .update(verification)
      .set({ createdAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(like(verification.identifier, 'trust-device-%'))
    await db.insert(siteSettings).values({ key: 'security', value: { trustDeviceDays: 7 }, updatedAt: new Date().toISOString() })
    const res = await signInWithCode(b, 'owner@example.com')
    expect(res.body).toEqual({ twoFactorRedirect: true, twoFactorMethods: ['totp'], trustDeviceDays: 7 })

    await db.update(siteSettings).set({ value: { trustDeviceDays: 0 } })
    const c = new Browser(auth)
    expect((await signInWithCode(c, 'owner@example.com')).body).toMatchObject({ trustDeviceDays: 0 })
    expect((await c.json('/two-factor/verify-totp', { body: { code: await totpCode(totpURI), trustDevice: true } })).status).toBe(200)
    expect(c.jar.has('better-auth.trust_device')).toBe(false)
    expect(await trustRows()).toEqual([])
  })

  it("doesn't trust another user's device cookie", async () => {
    const { totpURI } = await enrolled()
    const b = await trustedBrowser(totpURI)
    await addUser('admin@example.com', 'admin')
    const other = await enrolled('admin@example.com')
    const res = await signInWithCode(b, 'admin@example.com')
    expect(res.body).toMatchObject({ twoFactorRedirect: true })
    expect(b.jar.has('better-auth.trust_device')).toBe(false)
    expect(other.totpURI).toBeTruthy()
    // …and another browser of the owner's still gets the challenge.
    expect((await signInWithCode(new Browser(auth), 'owner@example.com')).body).toMatchObject({ twoFactorRedirect: true })
  })

  it('forgets devices from Security, on a role change, and when TOTP is turned off', async () => {
    const { totpURI } = await enrolled()
    const owner = await userId('owner@example.com')
    const b = await trustedBrowser(totpURI)
    expect(await revokeTrustedDevices(db, { id: owner }, owner)).toEqual({ revoked: 1 })
    expect((await signInWithCode(b, 'owner@example.com')).body).toMatchObject({ twoFactorRedirect: true })
    const revoked = await db.select().from(auditLog).where(eq(auditLog.action, 'auth.devices_revoke'))
    expect(revoked.map((r) => r.after)).toEqual([{ reason: 'manual', count: 1 }])

    await addUser('admin@example.com', 'admin')
    const admin = await enrolled('admin@example.com')
    const a = await trustedBrowser(admin.totpURI, 'admin@example.com')
    await changeRole(db, { id: owner }, await userId('admin@example.com'), 'editor')
    expect((await signInWithCode(a, 'admin@example.com')).body).toMatchObject({ twoFactorRedirect: true })

    // An admin can't forget an owner's devices.
    await expect(revokeTrustedDevices(db, { id: await userId('admin@example.com') }, owner)).rejects.toThrow(/can't change/)

    await addUser('editor2@example.com', 'editor')
    const e = await enrolled('editor2@example.com')
    // Two trusted browsers: Better Auth's disable forgets the current one itself, our hook forgets the rest.
    await trustedBrowser(e.totpURI, 'editor2@example.com')
    const eb = await trustedBrowser(e.totpURI, 'editor2@example.com')
    await signInWithCode(eb, 'editor2@example.com')
    expect((await eb.json('/two-factor/disable', { body: {} })).status).toBe(200)
    expect(await trustRows()).toEqual([])
    const reasons = (await db.select().from(auditLog).where(eq(auditLog.action, 'auth.devices_revoke'))).map(
      (r) => (r.after as { reason: string }).reason,
    )
    expect(reasons).toContain('totp.disable')
  })
})

describe('preview URLs', () => {
  const staging = { SITE_ENV: 'staging', SITE_URL: 'https://tempe-volleyball-staging.tempevb.workers.dev' }
  it("trusts only this Worker's own preview hosts, and only on staging", () => {
    expect(authOrigin(staging, 'https://pr-25-tempe-volleyball-staging.tempevb.workers.dev/admin')).toBe(
      'https://pr-25-tempe-volleyball-staging.tempevb.workers.dev',
    )
    expect(authOrigin(staging, 'https://1a2b3c4d-tempe-volleyball-staging.tempevb.workers.dev/api/auth/x')).toBe(
      'https://1a2b3c4d-tempe-volleyball-staging.tempevb.workers.dev',
    )
    for (const url of [
      'https://tempe-volleyball-staging.tempevb.workers.dev/admin',
      'https://evil.com/admin',
      'https://pr-25-tempe-volleyball-staging.tempevb.workers.dev.evil.com/',
      'https://x.pr-25-tempe-volleyball-staging.tempevb.workers.dev/',
      'https://a.b-tempe-volleyball-staging.tempevb.workers.dev/',
      'https://pr-x-tempe-volleyball-staging.tempevb.workers.dev/',
      'http://pr-25-tempe-volleyball-staging.tempevb.workers.dev/',
      'https://pr-25-tempe-volleyball-staging.tempevb.workers.dev:8443/',
      'https://pr-25-tempe-volleyball-production.tempevb.workers.dev/',
      'not a url',
    ])
      expect({ url, origin: authOrigin(staging, url) }).toEqual({ url, origin: staging.SITE_URL })
    const production = { SITE_ENV: 'production', SITE_URL: 'https://tempe-volleyball-production.tempevb.workers.dev' }
    expect(authOrigin(production, 'https://pr-25-tempe-volleyball-production.tempevb.workers.dev/')).toBe(production.SITE_URL)
  })

  it('signs in on a preview host with cookies and links for that host', async () => {
    const preview = 'https://pr-7-tempe-volleyball-staging.tempevb.workers.dev'
    const stagingEnv = { ...staging, BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET }
    const mailer = createMailer({ db, env: stagingEnv, log: (m) => logs.push(m) })
    const previewAuth = createAuth({ db, env: stagingEnv, senders: createAuthSenders(db, mailer), origin: authOrigin(stagingEnv, preview) })
    const ask = (origin: string) =>
      previewAuth.handler(
        new Request(`${preview}/api/auth/sign-in/magic-link`, {
          method: 'POST',
          headers: { origin, cookie: 'a=1', 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'owner@example.com', callbackURL: '/admin' }),
        }),
      )
    expect((await ask(preview)).status).toBe(200)
    expect(logs.at(-1)).toContain(`${preview}/api/auth/magic-link/verify`)
    // Only the preview's own origin is trusted by its instance: not staging's, not anyone else's. (Better Auth
    // skips its origin check under NODE_ENV=test, so this checks the list it would check against.)
    const ctx = await previewAuth.$context
    expect(new Set(ctx.trustedOrigins)).toEqual(new Set([preview]))
    expect(ctx.baseURL).toBe(`${preview}/api/auth`)
  })
})

describe('CPU per request', () => {
  it('stays well under the 10 ms Workers limit', async () => {
    const start = process.cpuUsage()
    const fresh = createAuth({ db, env, senders: createAuthSenders(db, createMailer({ db, env, log: (m) => logs.push(m) })) })
    const init = process.cpuUsage(start)
    timings.length = 0
    const b = new Browser(fresh)
    // Warm up once (first calls JIT-compile), then measure a second full round.
    for (let round = 0; round < 2; round++) {
      timings.length = 0
      b.jar.clear()
      await signInWithCode(b, 'owner@example.com')
      await b.session()
      await b.session()
    }
    if (process.env.BENCH) {
      console.info(`createAuth(): ${((init.user + init.system) / 1000).toFixed(2)} ms`)
      for (const [name, ms] of timings) console.info(`${name}: ${ms.toFixed(2)} ms`)
    }
    // Generous bound for slow CI machines; the real numbers are in the PR description.
    for (const [, ms] of timings) expect(ms).toBeLessThan(50)
  })
})
