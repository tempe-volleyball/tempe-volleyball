import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createTestDb, type QueryStats, type TestDb } from '../db/testing'
import * as schema from '../db/schema'
import { createMailer } from '../email'
import { HttpError } from '../http'
import { runJobs } from '../cron'
import { hashKey, pruneRateLimits } from '../ratelimit'
import { OFFER_BATCH_MAX } from './core'
import { ENROL_LIMITS, submitPublicEnrolment, type PublicEnrolInput } from './submit'
import { addEntry, getTargetDetail, groupAction, listTargets, registrationAction, updateProduct } from './admin'
import { CRON_OFFER_LIMIT, respondToOffer, runEnrolmentCron, viewOffer } from './offers'
import { createForm, deleteForm, setFormProgrammes, updateForm } from './forms'
import { loadEnrolmentForm } from './public'
import { readOfferToken } from './tokens'

// Enrolment end to end against a migrated in-memory SQLite: caps under concurrent submissions, waitlists, offers
// (accept, decline, lapse), rate limits, duplicates, Turnstile and the admin actions.

const NOW = new Date('2026-10-18T03:00:00.000Z') // 2pm Sydney
const HOUR = 3_600_000
const SECRET = 'test-secret'
const SITE = 'https://staging.example'

const settings: schema.SeasonSettings = {
  sessions: ['18:30'],
  sessionMinutes: 60,
  meetings: 1,
  includeFinals: false,
  seed: 1,
  skipDates: [],
  defaultCourtIds: [],
}

const turnstileOk = (async () => Response.json({ success: true })) as unknown as typeof fetch
const turnstileNo = (async () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] })) as unknown as typeof fetch

type Setup = Awaited<ReturnType<typeof setup>>

async function setup(
  opts: { capPlayers?: number | null; capTeams?: number | null; waitlist?: boolean; open?: boolean; emailConfirm?: boolean | null } = {},
) {
  const { db, stats } = createTestDb()
  const logs: string[] = []
  const mailer = createMailer({ db, env: { SITE_ENV: 'development' }, now: () => NOW, log: (m) => logs.push(m) })
  await db.insert(schema.user).values({ id: 'admin1', name: 'Michael', email: 'michael@example.com', emailVerified: true, role: 'admin' })
  const [training] = await db
    .insert(schema.programmes)
    .values({
      code: 'SCT',
      name: 'Scrim & Coached Training',
      slug: 'scrim',
      weekday: 2,
      kind: 'training',
      categoryId: 'cat_adult_training',
      enrolmentOpen: opts.open ?? true,
      capPlayers: opts.capPlayers === undefined ? 3 : opts.capPlayers,
      waitlistEnabled: opts.waitlist ?? true,
      priceCents: 2000,
      // Most tests are about caps, so they take entries straight away; the email-confirmation tests turn it on.
      enrolmentEmailConfirm: opts.emailConfirm === undefined ? false : opts.emailConfirm,
    })
    .returning()
  const [session] = await db
    .insert(schema.programmeSessions)
    .values({ programmeId: training!.id, date: '2026-10-21', startTime: '18:30', endTime: '20:00' })
    .returning()
  const [session2] = await db
    .insert(schema.programmeSessions)
    .values({ programmeId: training!.id, date: '2026-10-28', startTime: '18:30', endTime: '20:00' })
    .returning()
  const [league] = await db
    .insert(schema.programmes)
    .values({
      code: 'TNL',
      name: 'Thursday Night League',
      slug: 'tnl',
      weekday: 4,
      categoryId: 'cat_mixed_leagues',
      enrolmentOpen: true,
      capTeams: opts.capTeams === undefined ? 2 : opts.capTeams,
      waitlistEnabled: opts.waitlist ?? true,
      enrolmentEmailConfirm: opts.emailConfirm === undefined ? false : opts.emailConfirm,
    })
    .returning()
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
    training: training!,
    session: session!,
    session2: session2!,
    league: league!,
    season: season!,
  }
}

let seq = 0
const person = (n = ++seq, extra: Record<string, unknown> = {}) => ({
  firstName: `Pat${n}`,
  lastName: 'Lee',
  email: `pat${n}@example.com`,
  phone: '0400 000 000',
  ...extra,
})

const trainingAnswers = { skill_level: 'beginner', emergency_contact: { name: 'Sam Lee', phone: '0411 111 111' }, code_of_conduct: true }

const enrol = (s: Setup, input: PublicEnrolInput, o: { ip?: string; fetch?: typeof fetch; secret?: string | null; now?: Date } = {}) =>
  submitPublicEnrolment(
    {
      db: s.db,
      mailer: s.mailer,
      turnstileSecret: o.secret === undefined ? 'ts-secret' : o.secret,
      ip: o.ip ?? `198.51.100.${++seq % 250}`,
      secret: SECRET,
      siteUrl: SITE,
      fetch: o.fetch ?? turnstileOk,
      now: o.now ?? NOW,
    },
    { turnstileToken: 'tok', ...input },
  )

const enrolSession = (s: Setup, p = person(), o: Parameters<typeof enrol>[2] = {}) =>
  enrol(s, { target: { kind: 'session', id: s.session.id }, entryType: 'player', person: p, answers: trainingAnswers }, o)

const failure = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e as HttpError
  }
  throw new Error('expected a failure')
}

const regsOf = async (db: TestDb, productId?: string) =>
  db
    .select()
    .from(schema.registrations)
    .where(productId ? eq(schema.registrations.productId, productId) : undefined)
    .all()

const withinLimits = (stats: QueryStats) => {
  expect(stats.queries).toBeLessThanOrEqual(50)
  expect(stats.maxParams).toBeLessThanOrEqual(100)
}

describe('public enrolment', () => {
  it('confirms within the cap, emails a confirmation and stays within the free-plan limits', async () => {
    const s = await setup()
    s.stats.reset()
    const r = await enrolSession(s)
    withinLimits(s.stats)
    expect(r.status).toBe('confirmed')
    expect(r.reference).toMatch(/^TVB-[2-9A-HJKMNP-TV-Z]{4}$/)
    expect(r.amountCents).toBe(2000)
    const [reg] = await regsOf(s.db)
    expect(reg).toMatchObject({ status: 'confirmed', source: 'public', amountCents: 2000, paidAt: null, formId: null })
    expect(reg!.answers).toEqual({ skill_level: 'beginner', code_of_conduct: true })
    const [player] = await s.db.select().from(schema.players).all()
    expect(player).toMatchObject({ emergencyContact: 'Sam Lee, 0411 111 111', email: reg ? player!.email : '' })
    const outbox = await s.db.select().from(schema.emailOutbox).all()
    expect(outbox.map((o) => o.template)).toEqual(['enrolment.confirmed'])
  })

  it('never lets concurrent submissions take more spots than the cap; the rest are waitlisted in order', async () => {
    const s = await setup({ capPlayers: 3 })
    const results = await Promise.all(Array.from({ length: 10 }, () => enrolSession(s)))
    expect(results.filter((r) => r.status === 'confirmed')).toHaveLength(3)
    const waiting = results.filter((r) => r.status === 'waitlist')
    expect(waiting).toHaveLength(7)
    expect(waiting.map((r) => r.position).toSorted((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7])
    const regs = await regsOf(s.db)
    expect(regs.filter((r) => r.status === 'confirmed')).toHaveLength(3)
  })

  it('refuses entries over the cap when the waitlist is off, without leaving player rows behind', async () => {
    const s = await setup({ capPlayers: 2, waitlist: false })
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => enrolSession(s)))
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(2)
    const refused = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(refused.map((r) => (r.reason as HttpError).code)).toEqual(['full', 'full', 'full'])
    expect(await s.db.select().from(schema.players).all()).toHaveLength(2)
  })

  it('caps team entries by teams and keeps team names unique (case-insensitive)', async () => {
    const s = await setup({ capTeams: 2 })
    const team = (name: string) =>
      enrol(s, {
        target: { kind: 'season', id: s.season.id },
        entryType: 'team',
        person: person(),
        answers: { team_name: name, code_of_conduct: true },
      })
    const results = await Promise.all([team('Spikers'), team('Diggers'), team('Blockers'), team('Setters')])
    expect(results.filter((r) => r.status === 'confirmed')).toHaveLength(2)
    expect(
      results
        .filter((r) => r.status === 'waitlist')
        .map((r) => r.position)
        .toSorted(),
    ).toEqual([1, 2])
    const groups = await s.db.select().from(schema.groups).all()
    expect(groups.filter((g) => g.status === 'confirmed')).toHaveLength(2)
    expect((await failure(team('  spikers '))).code).toBe('team_name_taken')
    // Free agents aren't limited by the team cap.
    const fa = await enrol(s, {
      target: { kind: 'season', id: s.season.id },
      entryType: 'free_agent',
      person: person(),
      answers: { skill_level: 'advanced', code_of_conduct: true },
    })
    expect(fa.status).toBe('confirmed')
  })

  it('detects duplicates by email, name and target, but lets siblings share an email', async () => {
    const s = await setup()
    const p = person()
    const first = await enrolSession(s, p)
    // The page isn't told (that would reveal who is enrolled); the address on file gets its reference instead.
    const again = await enrolSession(s, { ...p, email: p.email.toUpperCase(), firstName: p.firstName.toLowerCase() })
    expect(again).toMatchObject({ status: 'emailed', reference: null })
    expect(s.logs.at(-1)).toContain('template=enrolment.already')
    expect(s.logs.at(-1)).toContain(first.reference!)
    const sibling = await enrolSession(s, { ...p, firstName: 'Alex' })
    expect(sibling.status).toBe('confirmed')
    // The same person can enrol in another session.
    const other = await enrol(s, {
      target: { kind: 'session', id: s.session2.id },
      entryType: 'player',
      person: p,
      answers: trainingAnswers,
    })
    expect(other.status).toBe('confirmed')
    expect(await s.db.select().from(schema.players).all()).toHaveLength(2)
  })

  it('validates against the form and reports errors per field', async () => {
    const s = await setup()
    const e = await failure(
      enrol(s, {
        target: { kind: 'session', id: s.session.id },
        entryType: 'player',
        person: { firstName: '', lastName: 'Lee', email: 'nope', phone: '12' },
        answers: { skill_level: 'expert' },
      }),
    )
    expect(e.status).toBe(400)
    expect(Object.keys(e.details!.fieldErrors as object).toSorted()).toEqual([
      'code_of_conduct',
      'email',
      'emergency_contact',
      'firstName',
      'phone',
      'skill_level',
    ])
    // A team entry isn't something training takes.
    expect(
      (
        await failure(
          enrol(s, { target: { kind: 'session', id: s.session.id }, entryType: 'team', person: person(), answers: trainingAnswers }),
        )
      ).status,
    ).toBe(400)
  })

  it('uses the programme form (with versions) when one is set', async () => {
    const s = await setup()
    const form = await createForm(s.db, s.actor, {
      name: 'Training',
      fields: [
        {
          key: 'shirt',
          type: 'select',
          label: 'Shirt size',
          required: true,
          options: [
            { value: 's', label: 'S' },
            { value: 'm', label: 'M' },
          ],
        },
      ],
    })
    await setFormProgrammes(s.db, s.actor, form.id, { programmeIds: [s.training.id] })
    const updated = await updateForm(s.db, s.actor, form.id, { name: 'Training v2', baseUpdatedAt: form.updatedAt })
    expect(updated.result.version).toBe(2)
    expect((await failure(enrolSession(s))).code).toBe('invalid_input')
    await enrol(s, { target: { kind: 'session', id: s.session.id }, entryType: 'player', person: person(), answers: { shirt: 'm' } })
    const [reg] = await regsOf(s.db)
    expect(reg).toMatchObject({ formId: form.id, formVersion: 2, answers: { shirt: 'm' } })
    expect((await failure(deleteForm(s.db, s.actor, form.id))).code).toBe('conflict')
    // A key can't be dropped once saved; retiring it is fine.
    expect((await failure(updateForm(s.db, s.actor, form.id, { fields: [] }))).code).toBe('invalid_input')
    const retired = await updateForm(s.db, s.actor, form.id, { fields: [{ ...updated.result.fields[0]!, retired: true }] })
    expect(retired.result.fields[0]!.retired).toBe(true)
  })

  it('refuses closed enrolment, failed Turnstile and missing keys', async () => {
    const s = await setup({ open: false })
    expect((await failure(enrolSession(s))).code).toBe('closed')
    const t = await setup()
    expect((await failure(enrolSession(t, person(), { fetch: turnstileNo }))).code).toBe('turnstile_failed')
    expect((await failure(enrolSession(t, person(), { secret: null }))).status).toBe(503)
    expect(await regsOf(t.db)).toHaveLength(0)
  })

  it('rate-limits per email and per IP in D1, and prunes old windows', async () => {
    const s = await setup({ capPlayers: null })
    const p = person()
    // Duplicates still count as attempts, and +tags and Gmail dots count as the same mailbox.
    const gmail = { ...p, email: 'pat.lee@gmail.com' }
    for (let i = 0; i < ENROL_LIMITS.perEmailHour; i++) await enrolSession(s, gmail).catch(() => undefined)
    const limited = await failure(enrolSession(s, { ...gmail, email: 'p.a.t.lee+tvb@googlemail.com', firstName: 'Other' }))
    expect(limited.code).toBe('rate_limited')
    expect(limited.details!.retryAfter).toBeGreaterThan(0)
    // A new hour starts a new window.
    const later = new Date(NOW.getTime() + HOUR + 1000)
    expect((await enrolSession(s, gmail, { now: later })).status).toBe('emailed')

    // Without a solved Turnstile check only the IP is counted, so junk can't lock someone's email out.
    const victim = person()
    for (let i = 0; i < ENROL_LIMITS.perEmailDay + 2; i++)
      await enrolSession(s, victim, { fetch: turnstileNo, ip: `203.0.113.${i}` }).catch(() => undefined)
    expect((await enrolSession(s, victim)).status).toBe('confirmed')

    const ip = '192.0.2.77'
    for (let i = 0; i < ENROL_LIMITS.perIpHour; i++) await enrolSession(s, person(), { ip })
    expect((await failure(enrolSession(s, person(), { ip }))).code).toBe('rate_limited')
    // Keys are hashes, never the IP or email.
    const keys = (await s.db.select().from(schema.rateLimits).all()).map((r) => r.key)
    expect(keys.some((k) => k.includes(ip) || k.includes('@'))).toBe(false)
    // …and salted, so they can't be reversed by hashing every IPv4 address.
    expect(await hashKey(ip, 'salt-a')).not.toBe(await hashKey(ip, 'salt-b'))
    expect(await pruneRateLimits(s.db, new Date(NOW.getTime() + 25 * HOUR))).toBe(keys.length)
  })
})

const fill = async (s: Setup, n: number) => {
  const out = []
  for (let i = 0; i < n; i++) out.push(await enrolSession(s))
  return out
}
// Sent offer emails keep no payload (the link is a secret), so read the link from the console-mode log.
const offerToken = async (s: Setup) => {
  const log = s.logs.filter((l) => l.includes('template=enrolment.offer')).at(-1) ?? ''
  return /\/enrol\/offer#(\S+)/.exec(log)?.[1] ?? ''
}

describe('waitlist and offers', () => {
  it('offers a freed spot to the first on the waitlist, who can accept it', async () => {
    const s = await setup({ capPlayers: 2 })
    const [first] = await fill(s, 4)
    const regs = await regsOf(s.db)
    const firstReg = regs.find((r) => r.reference === first!.reference)!
    await registrationAction(s.deps, s.actor, firstReg.id, { action: 'cancel', reason: 'Injured', notify: true })
    const after = await regsOf(s.db)
    const offered = after.filter((r) => r.status === 'offered')
    expect(offered).toHaveLength(1)
    expect(offered[0]!.waitlistPosition).toBeNull()
    expect(offered[0]!.offerExpiresAt).toBe(new Date(NOW.getTime() + 48 * HOUR).toISOString())
    // The first on the list got it (waitlist position 1).
    expect(regs.find((r) => r.id === offered[0]!.id)!.waitlistPosition).toBe(1)

    const token = await offerToken(s)
    expect(await readOfferToken(SECRET, token)).toMatchObject({ type: 'registration', id: offered[0]!.id })
    const stored = (await s.db.select().from(schema.emailOutbox).all()).filter((o) => o.template === 'enrolment.offer')
    expect(stored.map((o) => o.payload)).toEqual([{}])
    expect(await readOfferToken('other-secret', token)).toBeNull()
    expect((await viewOffer(s.db, SECRET, token, NOW)).state).toBe('live')
    const accepted = await respondToOffer(s.deps, token, 'accept')
    expect(accepted.state).toBe('accepted')
    expect((await regsOf(s.db)).find((r) => r.id === offered[0]!.id)!.status).toBe('confirmed')
    // Accepting twice is harmless; declining after is refused.
    expect((await respondToOffer(s.deps, token, 'accept')).state).toBe('accepted')
    expect((await failure(respondToOffer(s.deps, token, 'decline'))).code).toBe('offer_gone')
    const audit = await s.db.select().from(schema.auditLog).all()
    expect(audit.map((a) => a.action)).toContain('enrolment.status')
  })

  it('passes a declined offer to the next person', async () => {
    const s = await setup({ capPlayers: 1 })
    await fill(s, 3)
    const holder = (await regsOf(s.db)).find((r) => r.status === 'confirmed')!
    await registrationAction(s.deps, s.actor, holder.id, { action: 'cancel' })
    const token = await offerToken(s)
    await respondToOffer(s.deps, token, 'decline')
    const regs = await regsOf(s.db)
    expect(regs.filter((r) => r.status === 'offered')).toHaveLength(1)
    expect(regs.filter((r) => r.status === 'cancelled')).toHaveLength(2)
    expect(await offerToken(s)).not.toBe(token)
  })

  it('the cron expires lapsed offers, tells them, offers the next, and queues the emails in the same batch', async () => {
    const s = await setup({ capPlayers: 1 })
    await fill(s, 3)
    const holder = (await regsOf(s.db)).find((r) => r.status === 'confirmed')!
    await registrationAction(s.deps, s.actor, holder.id, { action: 'cancel' })
    const later = new Date(NOW.getTime() + 49 * HOUR)
    s.stats.reset()
    const result = await runEnrolmentCron(s.db, { mailer: s.mailer, secret: SECRET, siteUrl: SITE }, later)
    withinLimits(s.stats)
    expect(result).toEqual({ expired: 1, offered: 1, emailsQueued: 2 })
    const regs = await regsOf(s.db)
    expect(regs.map((r) => r.status).toSorted()).toEqual(['cancelled', 'expired', 'offered'])
    const queued = (await s.db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.status, 'queued')).all()).map(
      (o) => o.template,
    )
    expect(queued.toSorted()).toEqual(['enrolment.cancelled', 'enrolment.offer'])
    // Running again changes nothing.
    expect(await runEnrolmentCron(s.db, { mailer: s.mailer, secret: SECRET, siteUrl: SITE }, later)).toEqual({
      expired: 0,
      offered: 0,
      emailsQueued: 0,
    })
  })

  it('bounds offers per request and per cron run; an idle cron run is one query', async () => {
    const s = await setup({ capPlayers: 1 })
    await fill(s, 12)
    const detail = await getTargetDetail(s.db, { kind: 'session', id: s.session.id }, NOW)
    s.stats.reset()
    const res = await updateProduct(s.deps, s.actor, detail.product!.id, { capacity: 12 })
    withinLimits(s.stats)
    expect(res.offered).toBe(OFFER_BATCH_MAX)
    // The cron offers the rest, a few an hour, well inside the shared budget.
    const cron = (at: Date) => runEnrolmentCron(s.db, { mailer: s.mailer, secret: SECRET, siteUrl: SITE }, at)
    s.stats.reset()
    expect(await cron(NOW)).toEqual({ expired: 0, offered: CRON_OFFER_LIMIT, emailsQueued: CRON_OFFER_LIMIT })
    expect(s.stats.queries).toBeLessThanOrEqual(20)
    await cron(new Date(NOW.getTime() + HOUR))
    expect((await regsOf(s.db)).filter((r) => r.status === 'offered')).toHaveLength(11)
    s.stats.reset()
    expect(await cron(new Date(NOW.getTime() + 2 * HOUR))).toEqual({ expired: 0, offered: 0, emailsQueued: 0 })
    expect(s.stats.queries).toBe(1)
  })

  it('in a busy cron hour, drains fewer emails and defers analytics', async () => {
    const s = await setup({ capPlayers: 1 })
    await fill(s, 2)
    const detail = await getTargetDetail(s.db, { kind: 'session', id: s.session.id }, NOW)
    await s.db.update(schema.products).set({ capacity: 2 }).where(eq(schema.products.id, detail.product!.id))
    const drained: (number | undefined)[] = []
    const mailer = {
      queueStatement: s.mailer.queueStatement,
      drainOutbox: (n?: number) => {
        drained.push(n)
        return Promise.resolve({ sent: 0, failed: 0, skipped: 0, remaining: 0 })
      },
      scrubSensitivePayloads: () => Promise.resolve(0),
    }
    const analytics = { secrets: {}, fetch: (() => Promise.reject(new Error('not called'))) as typeof fetch }
    const busy = await runJobs(s.db, mailer, NOW, { analytics, enrolment: { secret: SECRET, siteUrl: SITE } })
    expect(busy.enrolment).toEqual({ expired: 0, offered: 1, emailsQueued: 1 })
    expect(busy.analytics).toBe('deferred')
    expect(drained).toEqual([5])
  })

  it('raising the cap offers the new spots; a team entry offer covers its captain', async () => {
    const s = await setup({ capPlayers: 1 })
    await fill(s, 3)
    const detail = await getTargetDetail(s.db, { kind: 'session', id: s.session.id }, NOW)
    const res = await updateProduct(s.deps, s.actor, detail.product!.id, { capacity: 3 })
    expect(res.offered).toBe(2)
    expect((await regsOf(s.db)).filter((r) => r.status === 'offered')).toHaveLength(2)

    const t = await setup({ capTeams: 1 })
    const team = (name: string) =>
      enrol(t, {
        target: { kind: 'season', id: t.season.id },
        entryType: 'team',
        person: person(),
        answers: { team_name: name, code_of_conduct: true },
      })
    await team('A')
    await team('B')
    const [a, b] = await t.db.select().from(schema.groups).orderBy(schema.groups.createdAt).all()
    expect(b!.status).toBe('waitlist')
    await groupAction(t.deps, t.actor, a!.id, { action: 'cancel' })
    const g = await t.db.select().from(schema.groups).where(eq(schema.groups.id, b!.id)).get()
    expect(g!.status).toBe('offered')
    const captain = await t.db
      .select()
      .from(schema.registrations)
      .where(and(eq(schema.registrations.groupId, b!.id), eq(schema.registrations.freeAgent, false)))
      .get()
    expect(captain!.status).toBe('offered')
    const token = await offerToken(t)
    expect(await readOfferToken(SECRET, token)).toMatchObject({ type: 'group', id: b!.id })
    await respondToOffer(t.deps, token, 'accept')
    expect((await t.db.select().from(schema.groups).where(eq(schema.groups.id, b!.id)).get())!.status).toBe('confirmed')
  })
})

describe('admin', () => {
  it('lists targets with counts, marks paid, moves, places free agents and deletes, all audited', async () => {
    const s = await setup({ capPlayers: 2 })
    await enrolSession(s)
    await enrolSession(s)
    await enrolSession(s)
    const list = await listTargets(s.db, {}, NOW)
    const row = list.find((t) => t.ref.id === s.session.id)!
    expect(row.counts).toMatchObject({ players: 2, waitlist: 1, unpaid: 2 })
    expect(row.caps.players).toBe(2)
    expect(row.open).toBe(true)

    const detail = await getTargetDetail(s.db, { kind: 'session', id: s.session.id }, NOW)
    const confirmed = detail.registrations.find((r) => r.status === 'confirmed')!
    await registrationAction(s.deps, s.actor, confirmed.id, { action: 'mark_paid', method: 'payid', note: '12/10' })
    let reg = (await regsOf(s.db)).find((r) => r.id === confirmed.id)!
    expect(reg).toMatchObject({ paidAt: NOW.toISOString(), paidMarkedBy: 'admin1', paymentNote: 'PayID: 12/10' })
    await registrationAction(s.deps, s.actor, confirmed.id, { action: 'mark_unpaid', note: 'Bounced' })
    reg = (await regsOf(s.db)).find((r) => r.id === confirmed.id)!
    expect(reg.paidAt).toBeNull()

    // Moving a confirmed player to another session frees their spot for the waitlist.
    await registrationAction(s.deps, s.actor, confirmed.id, { action: 'move', to: { kind: 'session', id: s.session2.id } })
    const regs = await regsOf(s.db)
    expect(regs.find((r) => r.id === confirmed.id)!.productId).not.toBe(detail.product!.id)
    expect(regs.filter((r) => r.status === 'offered')).toHaveLength(1)

    const audit = (await s.db.select().from(schema.auditLog).all()).map((a) => a.action)
    expect(audit).toEqual(expect.arrayContaining(['enrolment.mark_paid', 'enrolment.mark_unpaid', 'enrolment.update']))
    // No personal details in the audit log.
    expect(JSON.stringify(await s.db.select().from(schema.auditLog).all())).not.toContain('@example.com')

    await registrationAction(s.deps, s.actor, confirmed.id, { action: 'delete' })
    expect((await regsOf(s.db)).find((r) => r.id === confirmed.id)).toBeUndefined()
  })

  it('adds entries by hand (required questions optional), forced onto the waitlist or over the cap', async () => {
    const s = await setup({ capPlayers: 1 })
    const ref = { kind: 'session' as const, id: s.session.id }
    const a = await addEntry(s.deps, s.actor, ref, {
      entryType: 'player',
      person: { firstName: 'Jo', lastName: 'Bloggs', email: 'jo@example.com' },
    })
    expect(a.status).toBe('confirmed')
    const b = await addEntry(s.deps, s.actor, ref, {
      person: { firstName: 'Al', lastName: 'B', email: 'al@example.com' },
      status: 'confirmed',
    })
    expect(b.status).toBe('confirmed')
    const c = await addEntry(s.deps, s.actor, ref, { person: { firstName: 'Cy', lastName: 'C', email: 'cy@example.com' } })
    expect(c).toMatchObject({ status: 'waitlist', position: 1 })
    const created = (await s.db.select().from(schema.auditLog).all()).filter((x) => x.action === 'enrolment.create')
    expect(created).toHaveLength(3)
    expect((await regsOf(s.db)).every((r) => r.source === 'admin')).toBe(true)
  })

  it('places free agents into team entries', async () => {
    const s = await setup({ capTeams: 4 })
    await enrol(s, {
      target: { kind: 'season', id: s.season.id },
      entryType: 'team',
      person: person(),
      answers: { team_name: 'Spikers', code_of_conduct: true },
    })
    await enrol(s, {
      target: { kind: 'season', id: s.season.id },
      entryType: 'free_agent',
      person: person(),
      answers: { skill_level: 'advanced', code_of_conduct: true },
    })
    const detail = await getTargetDetail(s.db, { kind: 'season', id: s.season.id }, NOW)
    const fa = detail.registrations.find((r) => r.entryType === 'free_agent')!
    const team = detail.groups[0]!
    await registrationAction(s.deps, s.actor, fa.id, { action: 'place', groupId: team.id })
    const after = await getTargetDetail(s.db, { kind: 'season', id: s.season.id }, NOW)
    expect(after.registrations.find((r) => r.id === fa.id)).toMatchObject({ entryType: 'free_agent', teamName: 'Spikers' })
    // A team captain's registration can't be placed or cancelled on its own.
    const captain = after.registrations.find((r) => r.entryType === 'team')!
    expect((await failure(registrationAction(s.deps, s.actor, captain.id, { action: 'cancel' }))).code).toBe('conflict')
    // Cancelling the team unplaces its free agents.
    await groupAction(s.deps, s.actor, team.id, { action: 'cancel' })
    const final = await getTargetDetail(s.db, { kind: 'season', id: s.season.id }, NOW)
    expect(final.registrations.find((r) => r.id === fa.id)!.groupId).toBeNull()
    expect(final.registrations.find((r) => r.id === captain.id)!.status).toBe('cancelled')
  })
})

describe('public form props', () => {
  it('lists the open targets with their form, fee and room', async () => {
    const s = await setup({ capPlayers: 1 })
    await enrolSession(s)
    const props = await loadEnrolmentForm(s.db, s.training.id, 'site-key', NOW)
    expect(props!.targets.map((t) => [t.id, t.waitlistOnly, t.spotsLeft])).toEqual([
      [s.session.id, true, 0],
      [s.session2.id, false, 1],
    ])
    expect(props!.forms.default!.map((f) => f.key)).toEqual(['skill_level', 'emergency_contact', 'code_of_conduct'])
    expect(props!.targets[0]!.amountCents).toBe(2000)
    expect(await loadEnrolmentForm(s.db, 'nope', null, NOW)).toBeNull()
  })
})
