import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTestDb, type QueryStats } from '../db/testing'
import * as schema from '../db/schema'
import { createMailer } from '../email'
import { HttpError } from '../http'
import { runJobs } from '../cron'
import { exportEnrolments, getTargetDetail, groupAction, registrationAction } from './admin'
import { confirmEmail, viewConfirmation } from './confirm'
import { createForm, setFormProgrammes } from './forms'
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
      // Leagues take EOIs by default; these tests enrol into one switched to enrolment mode.
      signupMode: 'enrolment',
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
    expect(result.housekeeping).toEqual({ pendingExpired: 1, unconfirmedPruned: 0, emailsPruned: 0, messagesPruned: 0, interestsPruned: 0 })
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
    // Off: settled straight away, and the page just says "we've emailed you".
    expect((await enrolSession(s)).status).toBe('emailed')
    expect((await regs(s)).map((r) => r.status)).toEqual(['confirmed'])
    const on = await setup({ capPlayers: null })
    // Uncapped: automatic means off.
    expect((await enrolSession(on)).status).toBe('emailed')
    await on.db.update(schema.products).set({ emailConfirm: true })
    expect((await enrolSession(on)).status).toBe('pending_email')
  })
})

describe('unconfirmed details (security review L3)', () => {
  const kin = { skill_level: 'beginner', emergency_contact: { name: 'Mallory', phone: '0499 999 999' }, code_of_conduct: true }

  it("writes nothing onto a player until the address is confirmed, and a repeat replaces what's waiting", async () => {
    const s = await setup()
    const victim = person()
    // Someone else types the victim's address with their own details.
    await enrol(s, {
      target: { kind: 'session', id: s.session.id },
      entryType: 'player',
      person: { ...victim, phone: '0499 999 999' },
      answers: kin,
    })
    const [player] = await s.db.select().from(schema.players).all()
    expect(player).toMatchObject({ email: victim.email, phone: null, emergencyContact: null, birthYear: null })
    const [held] = await regs(s)
    expect(held!.pendingDetails).toMatchObject({ phone: '0499 999 999', emergencyContact: 'Mallory, 0499 999 999' })
    const attackerLink = confirmLink(s, victim.email)
    // The admin sees what was sent, marked as unconfirmed.
    const detail = await getTargetDetail(s.db, { kind: 'session', id: s.session.id }, NOW)
    expect(detail.registrations[0]).toMatchObject({ detailsUnconfirmed: true, player: { phone: '0499 999 999' } })

    // The real person fills in the form: theirs replaces the waiting entry, and the first link stops working.
    await enrolSession(s, victim)
    const all = await regs(s)
    expect(all.map((r) => [r.status, r.cancelReason])).toEqual([
      ['cancelled', 'Replaced by a newer form before the email address was confirmed'],
      ['pending_email', null],
    ])
    expect((await viewConfirmation(s.deps, attackerLink)).state).toBe('expired')
    const link = confirmLink(s, victim.email)
    expect(link).not.toBe(attackerLink)
    // The confirm page shows the details confirming will save.
    expect((await viewConfirmation(s.deps, link)).details).toMatchObject({
      phone: '0400 000 000',
      emergencyContact: 'Sam Lee, 0411 111 111',
    })
    expect((await confirmEmail(s.deps, link)).state).toBe('confirmed')
    const [after] = await s.db.select().from(schema.players).all()
    expect(after).toMatchObject({ phone: '0400 000 000', emergencyContact: 'Sam Lee, 0411 111 111' })
    expect((await regs(s)).find((r) => r.status === 'confirmed')!.pendingDetails).toBeNull()
    expect(await s.db.select().from(schema.players).all()).toHaveLength(1)
  })

  it('holds gender, suburb and VNSW number until the address is confirmed, then fills blanks', async () => {
    const s = await setup()
    const training = await s.db.select().from(schema.programmes).where(eq(schema.programmes.kind, 'training')).get()
    const form = await createForm(s.db, s.actor, {
      name: 'Training',
      fields: [
        { key: 'gender', type: 'gender', label: 'Gender', required: true },
        { key: 'suburb', type: 'suburb', label: 'Suburb' },
        { key: 'vnsw_number', type: 'vnsw_number', label: 'VNSW number' },
      ],
    })
    await setFormProgrammes(s.db, s.actor, form.id, { programmeIds: [training!.id] })
    const p = person()
    await enrol(s, {
      target: { kind: 'session', id: s.session.id },
      entryType: 'player',
      person: p,
      answers: { gender: 'non_binary', suburb: 'Tempe', vnsw_number: 'V42' },
    })
    const [before] = await s.db.select().from(schema.players).all()
    expect(before).toMatchObject({ gender: null, suburb: null, vnswNumber: null })
    const [held] = await regs(s)
    expect(held!.pendingDetails).toMatchObject({ gender: 'non_binary', suburb: 'Tempe', vnswNumber: 'V42' })
    // An admin filled the suburb in meanwhile: confirming keeps it.
    await s.db.update(schema.players).set({ suburb: 'Newtown' })
    expect((await confirmEmail(s.deps, confirmLink(s, p.email))).state).toBe('confirmed')
    const [after] = await s.db.select().from(schema.players).all()
    expect(after).toMatchObject({ gender: 'non_binary', suburb: 'Newtown', vnswNumber: 'V42' })
  })

  it('confirming fills blanks only, and an admin confirming by hand merges the same way', async () => {
    const s = await setup()
    const p = person()
    await enrolSession(s, p)
    const [reg] = await regs(s)
    // Already known to the admin: the phone stays as it is.
    await s.db.update(schema.players).set({ phone: '0422 222 222' })
    await registrationAction(s.deps, s.actor, reg!.id, { action: 'confirm', notify: false })
    const [player] = await s.db.select().from(schema.players).all()
    expect(player).toMatchObject({ phone: '0422 222 222', emergencyContact: 'Sam Lee, 0411 111 111' })
  })

  it('deletes lapsed unconfirmed entries, and players nothing else uses, after the retention period', async () => {
    const s = await setup()
    const [p1, p2] = [person(), person()]
    await enrolSession(s, p1)
    await enrolSession(s, p2)
    // p2 also has a confirmed entry elsewhere, so their player row stays.
    const p2Player = (await s.db.select().from(schema.players).where(eq(schema.players.email, p2.email)).all())[0]!
    const other = (await s.db.select().from(schema.products).all())[0]!
    await s.db.insert(schema.registrations).values({
      productId: other.id,
      playerId: p2Player.id,
      status: 'cancelled',
      reference: 'TVB-KEEP',
      source: 'admin',
    })
    const day = 24 * HOUR
    s.setClock(new Date(NOW.getTime() + 2 * day))
    const first = await runJobs(s.db, s.mailer, new Date(NOW.getTime() + 2 * day))
    expect(first.housekeeping).toMatchObject({ pendingExpired: 2, unconfirmedPruned: 0 })
    // 30 days (the default) after they lapsed.
    const later = new Date(NOW.getTime() + 33 * day)
    s.setClock(later)
    const second = await runJobs(s.db, s.mailer, later)
    expect(second.housekeeping).toMatchObject({ unconfirmedPruned: 2 })
    expect((await regs(s)).map((r) => r.reference)).toEqual(['TVB-KEEP'])
    expect((await s.db.select().from(schema.players).all()).map((x) => x.email)).toEqual([p2.email])
  })
})

describe('confirm links and the daily email cap (security review L1)', () => {
  it('starts the deadline when the link is actually sent, and the cron waits for a queued one', async () => {
    const s = await setup()
    const sent: string[] = []
    const queued = createMailer({
      db: s.db,
      env: { SITE_ENV: 'production', RESEND_API_KEY: 'k' },
      now: () => NOW,
      dailyCap: 45,
      authDailyCap: 40,
      priorityReserve: 4,
      confirmLinkReserve: 2,
      fetch: (async (_u: unknown, init: RequestInit) => {
        sent.push(String(init.body))
        return Response.json({ id: 'resend-1' })
      }) as unknown as typeof fetch,
    })
    // General pool 5: anonymous mail stops at 1, confirm links at 3, priority at 5.
    const deps = { db: s.db, mailer: queued, turnstileSecret: 'ts', ip: '198.51.100.9', secret: SECRET, siteUrl: SITE, fetch: turnstileOk }
    const submit = (pp = person(), now = NOW) =>
      submitPublicEnrolment(
        { ...deps, now },
        { turnstileToken: 'tok', target: { kind: 'session', id: s.session.id }, entryType: 'player', person: pp, answers },
      )
    await queued.sendEmail('a@x.com', 'enrolment.already', {
      name: 'A',
      programme: 'P',
      target: 'T',
      reference: 'TVB-0000',
      state: 'confirmed',
    })
    await submit()
    await submit()
    await submit()
    const outbox = await s.db.select().from(schema.emailOutbox).all()
    // 1 anonymous + 2 confirm links went; the third link waits (the rest is kept for priority mail).
    expect(outbox.map((o) => o.status)).toEqual(['sent', 'sent', 'sent', 'queued'])
    const waiting = (await regs(s)).at(-1)!
    // A day later its old deadline has passed too, but only the two whose links went expire: the cron waits for it.
    const later = new Date(NOW.getTime() + 25 * HOUR)
    const idle = { ...queued, drainOutbox: async () => ({ sent: 0, failed: 0, skipped: 0, remaining: 1 }) }
    expect((await runJobs(s.db, idle, later)).housekeeping).toMatchObject({ pendingExpired: 2 })
    expect((await regs(s)).find((r) => r.id === waiting.id)!.status).toBe('pending_email')
    // When it goes, the deadline runs from then.
    const drainer = createMailer({
      db: s.db,
      env: { SITE_ENV: 'development' },
      now: () => later,
      log: () => {},
    })
    await drainer.drainOutbox()
    const after = (await regs(s)).find((r) => r.id === waiting.id)!
    expect(after.holdExpiresAt).toBe(new Date(later.getTime() + 24 * HOUR).toISOString())
    expect(sent).toHaveLength(3)
  })

  it("doesn't send a queued link whose entry was confirmed by hand or replaced", async () => {
    const s = await setup()
    const p = person()
    const mailer = createMailer({
      db: s.db,
      env: { SITE_ENV: 'development' },
      now: () => NOW,
      log: (m) => s.logs.push(m),
    })
    await enrolSession(s, p)
    const [reg] = await regs(s)
    // Put a second copy of its link in the queue, then confirm it by hand.
    await s.db.insert(schema.emailOutbox).values({
      to: p.email,
      template: 'enrolment.confirm_email',
      payload: {
        name: 'P',
        programme: 'P',
        target: 'T',
        url: 'https://x/enrol/confirm#c1',
        expiresAt: NOW.toISOString(),
        pending: { id: reg!.id, hours: 24 },
      },
      sendAfter: NOW.toISOString(),
      createdAt: NOW.toISOString(),
    })
    await registrationAction(s.deps, s.actor, reg!.id, { action: 'verify', notify: false })
    expect(await mailer.drainOutbox()).toMatchObject({ sent: 0, skipped: 1 })
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
    expect(result.housekeeping).toEqual({
      pendingExpired: 3,
      unconfirmedPruned: 0,
      emailsPruned: 20,
      messagesPruned: 0,
      interestsPruned: 0,
    })
    expect(result.invitesExpired).toBe(1)
    expect(result.rateLimitsPruned).toBeGreaterThan(0)
    expect(result.email).toMatchObject({ sent: 5 })
  })
})
