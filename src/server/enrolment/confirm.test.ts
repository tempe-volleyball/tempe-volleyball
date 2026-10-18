import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTestDb, type QueryStats } from '../db/testing'
import * as schema from '../db/schema'
import { createMailer } from '../email'
import { HttpError } from '../http'
import { runJobs } from '../cron'
import { exportEnrolments, getTargetDetail, groupAction, registrationAction } from './admin'
import { confirmEmail, viewConfirmation } from './confirm'
import { submitPublicEnrolment, type PublicEnrolInput } from './submit'
import { readConfirmToken } from './tokens'

// Email confirmation before a spot is held (docs/admin.md §3.7), the duplicate response, waitlist ranks, the shared
// target label, the CSV export audit and the hourly cron's budget with every job doing work.

const NOW = new Date('2026-10-18T03:00:00.000Z') // 2pm Sydney
const HOUR = 3_600_000
const SECRET = 'test-secret'
const SITE = 'https://staging.example'

const turnstileOk = (async () => Response.json({ success: true })) as unknown as typeof fetch

const settings: schema.SeasonSettings = {
  sessions: ['18:30'],
  sessionMinutes: 60,
  meetings: 1,
  includeFinals: false,
  seed: 1,
  skipDates: [],
  defaultCourtIds: [],
}

type Setup = Awaited<ReturnType<typeof setup>>

async function setup(
  opts: { capPlayers?: number | null; capTeams?: number | null; waitlist?: boolean; emailConfirm?: boolean | null } = {},
) {
  const { db, stats } = createTestDb()
  const logs: string[] = []
  let clock = NOW
  const mailer = createMailer({ db, env: { SITE_ENV: 'development' }, now: () => clock, log: (m) => logs.push(m), hashSalt: SECRET })
  await db.insert(schema.user).values({ id: 'admin1', name: 'Michael', email: 'michael@example.com', emailVerified: true, role: 'admin' })
  const [training] = await db
    .insert(schema.programmes)
    .values({
      code: 'SCT',
      name: 'Scrim & Coached Training',
      slug: 'scrim',
      weekday: 3,
      kind: 'training',
      categoryId: 'cat_adult_training',
      enrolmentOpen: true,
      capPlayers: opts.capPlayers === undefined ? 2 : opts.capPlayers,
      waitlistEnabled: opts.waitlist ?? true,
      // Null = automatic: on, because it's capped.
      enrolmentEmailConfirm: opts.emailConfirm ?? null,
    })
    .returning()
  const [session] = await db
    .insert(schema.programmeSessions)
    .values({ programmeId: training!.id, date: '2026-10-21', startTime: '18:00', endTime: '20:00' })
    .returning()
  // A product named the way the admin's sessions screen names them: the label must never come from it.
  await db.insert(schema.products).values({
    kind: 'training_session',
    name: 'Scrim & Coached Training 2026-10-21',
    slug: `session-${session!.id}`,
    priceCents: 0,
    programmeId: training!.id,
    sessionId: session!.id,
    paymentMethods: ['payid'],
  })
  const [league] = await db
    .insert(schema.programmes)
    .values({
      code: 'TNL',
      name: 'Thursday Night League',
      slug: 'tnl',
      weekday: 4,
      categoryId: 'cat_mixed_leagues',
      enrolmentOpen: true,
      capTeams: opts.capTeams === undefined ? 1 : opts.capTeams,
      waitlistEnabled: opts.waitlist ?? true,
      enrolmentEmailConfirm: opts.emailConfirm ?? null,
    })
    .returning()
  // A draft season of an open league takes entries: it's next season's enrolment (docs/admin.md §3.7).
  const [season] = await db
    .insert(schema.seasons)
    .values({ leagueId: league!.id, name: 'TNL Q1 2027', slug: 'tnl-q1-2027', year: 2027, quarter: 1, startDate: '2027-01-14', settings })
    .returning()
  const deps = { db, mailer, secret: SECRET, siteUrl: SITE, now: NOW }
  const actor = { id: 'admin1', ip: '203.0.113.1' }
  return {
    db,
    stats,
    mailer,
    logs,
    deps,
    actor,
    session: session!,
    season: season!,
    setClock: (d: Date) => (clock = d),
  }
}

let seq = 0
const person = (n = ++seq) => ({ firstName: `Pat${n}`, lastName: 'Lee', email: `pat${n}@example.com`, phone: '0400 000 000' })
const answers = { skill_level: 'beginner', emergency_contact: { name: 'Sam Lee', phone: '0411 111 111' }, code_of_conduct: true }

const enrol = (s: Setup, input: PublicEnrolInput, now = NOW) =>
  submitPublicEnrolment(
    {
      db: s.db,
      mailer: s.mailer,
      turnstileSecret: 'ts',
      ip: `198.51.100.${++seq % 250}`,
      secret: SECRET,
      siteUrl: SITE,
      fetch: turnstileOk,
      now,
    },
    { turnstileToken: 'tok', ...input },
  )
const enrolSession = (s: Setup, p = person(), now = NOW) =>
  enrol(s, { target: { kind: 'session', id: s.session.id }, entryType: 'player', person: p, answers }, now)

const confirmLink = (s: Setup, email?: string) => {
  const log = s.logs.filter((l) => l.includes('template=enrolment.confirm_email') && (!email || l.includes(`to=${email}`))).at(-1) ?? ''
  return /\/enrol\/confirm#(\S+)/.exec(log)?.[1] ?? ''
}

const regs = (s: Setup) => s.db.select().from(schema.registrations).all()

const failure = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as HttpError
  }
  throw new Error('expected a failure')
}

const withinLimits = (stats: QueryStats) => {
  expect(stats.queries).toBeLessThanOrEqual(50)
  expect(stats.maxParams).toBeLessThanOrEqual(100)
}

describe('email confirmation before a spot is held', () => {
  it('holds nothing until the link is clicked, then settles against the cap', async () => {
    const s = await setup({ capPlayers: 1 })
    const [pa, pb] = [person(), person()]
    s.stats.reset()
    const a = await enrolSession(s, pa)
    withinLimits(s.stats)
    expect(a).toMatchObject({ status: 'pending_email', reference: null, confirmHours: 24, target: 'Wed 21 Oct 2026, 6–8pm' })
    const b = await enrolSession(s, pb)
    expect(b.status).toBe('pending_email')
    expect((await regs(s)).map((r) => r.status)).toEqual(['pending_email', 'pending_email'])
    const detail = await getTargetDetail(s.db, { kind: 'session', id: s.session.id }, NOW)
    expect(detail.summary.counts).toMatchObject({ players: 0, pending: 2, waitlist: 0 })
    expect(detail.registrations[0]!.confirmBy).toBe(new Date(NOW.getTime() + 24 * HOUR).toISOString())

    // The link is signed and in the fragment; the stored email keeps no payload once sent.
    const tokenA = confirmLink(s, pa.email)
    expect(tokenA).not.toBe('')
    expect(await readConfirmToken(SECRET, tokenA)).toMatchObject({ id: detail.registrations[0]!.id })
    expect(await readConfirmToken('other', tokenA)).toBeNull()
    const stored = (await s.db.select().from(schema.emailOutbox).all()).filter((o) => o.template === 'enrolment.confirm_email')
    expect(stored.map((o) => o.payload)).toEqual([{}, {}])
    expect(s.logs.some((l) => l.includes('subject="Confirm your enrolment: Scrim & Coached Training: Wed 21 Oct 2026, 6–8pm"'))).toBe(true)

    // Opening the page changes nothing; the click settles it.
    expect((await viewConfirmation(s.deps, tokenA)).state).toBe('pending')
    s.stats.reset()
    const done = await confirmEmail(s.deps, tokenA)
    withinLimits(s.stats)
    expect(done).toMatchObject({ state: 'confirmed', reference: expect.stringMatching(/^TVB-/) })
    expect(s.logs.at(-1)).toContain('template=enrolment.confirmed')
    // A second click is harmless.
    expect((await confirmEmail(s.deps, tokenA)).state).toBe('confirmed')

    // The other one confirms too late for the spot: it joins the waitlist as number 1.
    const tokenB = confirmLink(s, pb.email)
    const waiting = await confirmEmail(s.deps, tokenB)
    expect(waiting).toMatchObject({ state: 'waitlist', position: 1 })
    expect(s.logs.at(-1)).toContain('template=enrolment.waitlisted')
  })

  it('refuses a confirmation as full when the waitlist is off, and rejects bad or expired links', async () => {
    const s = await setup({ capPlayers: 1, waitlist: false })
    const p1 = person()
    const p2 = person()
    await enrolSession(s, p1)
    await enrolSession(s, p2)
    expect((await confirmEmail(s.deps, confirmLink(s, p1.email))).state).toBe('confirmed')
    expect((await confirmEmail(s.deps, confirmLink(s, p2.email))).state).toBe('full')
    expect((await regs(s)).map((r) => r.status).toSorted()).toEqual(['cancelled', 'confirmed'])
    expect((await failure(viewConfirmation(s.deps, 'c1.nope.abc.def'))).status).toBe(404)

    const late = await setup()
    const p = person()
    await enrolSession(late, p)
    const token = confirmLink(late, p.email)
    const after = { ...late.deps, now: new Date(NOW.getTime() + 25 * HOUR) }
    expect((await confirmEmail(after, token)).state).toBe('expired')
  })

  it('confirms team entries against the team cap', async () => {
    const s = await setup({ capTeams: 1 })
    const entry = (name: string, p = person()) =>
      enrol(s, {
        target: { kind: 'season', id: s.season.id },
        entryType: 'team',
        person: p,
        answers: { team_name: name, players: 'A, B, C', code_of_conduct: true, skill_level: 'intermediate' },
      }).then((r) => ({ r, p }))
    const one = await entry('Spikers')
    const two = await entry('Diggers')
    expect(one.r.status).toBe('pending_email')
    const groups = await s.db.select().from(schema.groups).all()
    expect(groups.map((g) => g.status)).toEqual(['pending_email', 'pending_email'])
    expect((await confirmEmail(s.deps, confirmLink(s, two.p.email))).state).toBe('confirmed')
    expect((await confirmEmail(s.deps, confirmLink(s, one.p.email))).state).toBe('waitlist')
    const after = await s.db.select().from(schema.groups).all()
    expect(after.find((g) => g.name === 'Diggers')!.status).toBe('confirmed')
    expect(after.find((g) => g.name === 'Spikers')!.status).toBe('waitlist')
  })

  it('answers a repeat exactly like a new entry, and emails the address on file instead', async () => {
    const s = await setup()
    const p = person()
    const first = await enrolSession(s, p)
    const again = await enrolSession(s, { ...p, email: p.email.toUpperCase() })
    expect(again).toEqual(first)
    // Still pending: the same link again.
    expect(confirmLink(s, p.email)).not.toBe('')
    await confirmEmail(s.deps, confirmLink(s, p.email))
    const third = await enrolSession(s, p)
    expect(third).toEqual(first)
    expect(s.logs.at(-1)).toContain('template=enrolment.already')
    expect(s.logs.at(-1)).toMatch(/TVB-/)
  })

  it('lets an admin see, confirm and resend; the cron expires the rest', async () => {
    const s = await setup()
    const [p1, p2, p3] = [person(), person(), person()]
    await enrolSession(s, p1)
    await enrolSession(s, p2)
    await enrolSession(s, p3)
    const all = await regs(s)
    const byEmail = async (email: string) => {
      const players = await s.db.select().from(schema.players).where(eq(schema.players.email, email)).all()
      return all.find((r) => r.playerId === players[0]!.id)!
    }
    const r1 = await byEmail(p1.email)
    const r2 = await byEmail(p2.email)
    const res = await registrationAction(s.deps, s.actor, r1.id, { action: 'verify' })
    expect(res).toMatchObject({ state: 'confirmed' })
    const resent = await registrationAction({ ...s.deps, now: new Date(NOW.getTime() + 20 * HOUR) }, s.actor, r2.id, {
      action: 'resend_confirm',
    })
    expect(resent).toMatchObject({ emailed: true })
    const audit = (await s.db.select().from(schema.auditLog).all()).map((a) => a.action)
    expect(audit).toEqual(expect.arrayContaining(['enrolment.status', 'enrolment.update']))

    // 25 hours on: p3's link has lapsed, p2's was renewed at hour 20.
    const later = new Date(NOW.getTime() + 25 * HOUR)
    s.setClock(later)
    const result = await runJobs(s.db, s.mailer, later, { enrolment: { secret: SECRET, siteUrl: SITE } })
    expect(result.housekeeping).toEqual({ pendingExpired: 1, emailsPruned: 0 })
    const statuses = Object.fromEntries((await regs(s)).map((r) => [r.id, r.status]))
    expect(statuses[r1.id]).toBe('confirmed')
    expect(statuses[r2.id]).toBe('pending_email')
    expect(Object.values(statuses).filter((x) => x === 'expired')).toHaveLength(1)
    // Expired entries free nothing (they never held a spot), and can enrol again.
    expect((await enrolSession(s, p3, later)).status).toBe('pending_email')
  })

  it('a team entry pending its email is confirmed, resent or cancelled with the team', async () => {
    const s = await setup({ capTeams: 2 })
    const p = person()
    await enrol(s, {
      target: { kind: 'season', id: s.season.id },
      entryType: 'team',
      person: p,
      answers: { team_name: 'Blockers', players: 'A, B', code_of_conduct: true, skill_level: 'intermediate' },
    })
    const g = (await s.db.select().from(schema.groups).all())[0]!
    expect((await groupAction(s.deps, s.actor, g.id, { action: 'resend_confirm' })).emailed).toBe(true)
    expect(await groupAction(s.deps, s.actor, g.id, { action: 'verify' })).toMatchObject({ state: 'confirmed' })
    expect((await s.db.select().from(schema.groups).all())[0]!.status).toBe('confirmed')
  })

  it('can be switched off per programme or per instance', async () => {
    const s = await setup({ emailConfirm: false })
    expect((await enrolSession(s)).status).toBe('confirmed')
    const on = await setup({ capPlayers: null })
    // Uncapped: automatic means off.
    expect((await enrolSession(on)).status).toBe('confirmed')
    await on.db.update(schema.products).set({ emailConfirm: true })
    expect((await enrolSession(on)).status).toBe('pending_email')
  })
})

describe('waitlist ranks and labels', () => {
  it('counts places from 1 after an offer, and names the session the same way everywhere', async () => {
    const s = await setup({ capPlayers: 1, emailConfirm: false })
    for (let i = 0; i < 4; i++) await enrolSession(s)
    const holder = (await regs(s)).find((r) => r.status === 'confirmed')!
    await registrationAction(s.deps, s.actor, holder.id, { action: 'cancel' })
    const detail = await getTargetDetail(s.db, { kind: 'session', id: s.session.id }, NOW)
    const waiting = detail.registrations.filter((r) => r.status === 'waitlist')
    // Stored positions keep the gap (2, 3); the rank shown is 1, 2.
    expect(waiting.map((r) => [r.waitlistPosition, r.waitlistRank])).toEqual([
      [2, 1],
      [3, 2],
    ])
    // The offer email names the session from its row, not the product's stored name.
    const offer = s.logs.find((l) => l.includes('template=enrolment.offer'))!
    expect(offer).toContain('subject="A spot is free: Scrim & Coached Training: Wed 21 Oct 2026, 6–8pm"')
    expect(offer).not.toContain('2026-10-21')
  })
})

describe('admin reads', () => {
  it('never writes on GET, and audits the CSV export', async () => {
    const s = await setup()
    const ref = { kind: 'season' as const, id: s.season.id }
    const detail = await getTargetDetail(s.db, ref, NOW)
    expect(detail.product).toBeNull()
    expect(await s.db.select().from(schema.products).where(eq(schema.products.seasonId, s.season.id)).all()).toHaveLength(0)
    const out = await exportEnrolments(s.db, s.actor, ref, false, NOW)
    expect(out.filename).toBe('tnl-tnl-q1-2027-enrolments.csv')
    const audit = await s.db.select().from(schema.auditLog).all()
    expect(audit.map((a) => [a.action, a.after])).toEqual([
      ['enrolment.export', { target: `season:${s.season.id}`, label: 'TNL Q1 2027', rows: 0, includeCancelled: false }],
    ])
  })
})

describe('the hourly cron', () => {
  it('stays inside 50 D1 queries with every job doing work', async () => {
    const s = await setup({ capPlayers: 1, emailConfirm: false })
    // A waitlist with a lapsed offer and more waiting: the enrolment job expires, emails and offers.
    for (let i = 0; i < 6; i++) await enrolSession(s)
    const holder = (await regs(s)).find((r) => r.status === 'confirmed')!
    await registrationAction(s.deps, s.actor, holder.id, { action: 'cancel' })
    // Unconfirmed entries to expire.
    await s.db.update(schema.programmes).set({ enrolmentEmailConfirm: true })
    for (let i = 0; i < 3; i++) await enrolSession(s)
    // Old sent and failed emails to prune, and queued ones to drain.
    const old = new Date(NOW.getTime() - 40 * 24 * HOUR).toISOString()
    await s.db.insert(schema.emailOutbox).values(
      Array.from({ length: 20 }, (_, i) => ({
        to: `x${i}@example.com`,
        template: 'enrolment.confirmed',
        payload: {},
        status: i % 2 ? ('sent' as const) : ('failed' as const),
        sendAfter: old,
        createdAt: old,
      })),
    )
    await s.db.insert(schema.emailOutbox).values(
      Array.from({ length: 12 }, (_, i) => ({
        to: `q${i}@example.com`,
        template: 'enrolment.waitlisted',
        payload: { name: 'Q', programme: 'P', target: 'T', reference: 'TVB-0000', position: 1 },
        sendAfter: NOW.toISOString(),
        createdAt: NOW.toISOString(),
      })),
    )
    await s.db.insert(schema.rateLimits).values({ key: 'old', count: 1, windowStart: old, expiresAt: old })
    await s.db.insert(schema.adminInvites).values({
      email: 'a@x.com',
      role: 'editor',
      tokenHash: 'h1',
      invitedBy: 'admin1',
      expiresAt: '2026-10-01T00:00:00.000Z',
    })
    const later = new Date(NOW.getTime() + 49 * HOUR)
    s.setClock(later)
    s.stats.reset()
    const result = await runJobs(s.db, s.mailer, later, { enrolment: { secret: SECRET, siteUrl: SITE } })
    // 26 today (analytics is deferred in a busy hour): plenty of room under the 50.
    expect(s.stats.queries).toBeLessThanOrEqual(35)
    withinLimits(s.stats)
    expect(result.enrolment).toMatchObject({ expired: 1, offered: 1 })
    expect(result.housekeeping).toEqual({ pendingExpired: 3, emailsPruned: 20 })
    expect(result.invitesExpired).toBe(1)
    expect(result.rateLimitsPruned).toBeGreaterThan(0)
    expect(result.email).toMatchObject({ sent: 5 })
  })
})
