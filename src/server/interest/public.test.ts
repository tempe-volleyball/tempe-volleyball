import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../lib/content/settings'
import { createTestDb } from '../db/testing'
import * as schema from '../db/schema'
import { createMailer } from '../email'
import { renderEmail } from '../email/templates'
import { HttpError } from '../http'
import { INTEREST_REFERENCE_PATTERN } from '../players/core'
import { INTEREST_RATE, interestNotifyAddresses, loadInterestForm, submitInterest, type PublicInterestDeps } from './public'

// The EOI form end to end against a migrated in-memory SQLite: what's offered (null sign-up mode = the kind's
// default), the slug rules, submitting as a player or a team, validation, deposits, the pool, Turnstile, rate limits
// and the emails.

const NOW = new Date('2026-10-20T03:00:00.000Z') // 2pm Sydney
const turnstileOk = (async () => Response.json({ success: true })) as unknown as typeof fetch
const turnstileNo = (async () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] })) as unknown as typeof fetch

type SettingsOver = { interest?: Partial<typeof DEFAULT_SETTINGS.interest>; payid?: Partial<typeof DEFAULT_SETTINGS.payid> }

async function setup(over: SettingsOver = {}) {
  const { db, stats } = createTestDb()
  const logs: string[] = []
  const mailer = createMailer({ db, env: { SITE_ENV: 'development' }, now: () => NOW, log: (m) => logs.push(m), hashSalt: 'salt' })
  // Categories seeded by migration 0003.
  await db.insert(schema.leagues).values([
    // Leagues default to EOIs (signup_mode null).
    {
      id: 'tnl',
      code: 'TNL',
      name: 'Thursday Night League',
      slug: 'tnl',
      weekday: 4,
      sort: 1,
      categoryId: 'cat_mixed_leagues',
      depositTeamCents: 20000,
    },
    {
      id: 'fnl',
      code: 'FNL',
      name: 'Friday Night League',
      slug: 'fnl',
      weekday: 5,
      sort: 2,
      categoryId: 'cat_mixed_leagues',
      depositPlayerCents: 2500,
      depositTeamCents: 15000,
    },
    // Switched to enrolment: not offered.
    {
      id: 'snl',
      code: 'SNL',
      name: 'Saturday Night League',
      slug: 'snl',
      weekday: 6,
      sort: 3,
      categoryId: 'cat_mixed_leagues',
      signupMode: 'enrolment',
    },
    // Interest off: not offered.
    {
      id: 'sal',
      code: 'SAL',
      name: 'Sunday Afternoon League',
      slug: 'sal',
      weekday: 0,
      sort: 4,
      categoryId: 'cat_mixed_leagues',
      interestOpen: false,
    },
    // Retired, and a draft: not offered.
    { id: 'mnl', code: 'MNL', name: 'Monday Night League', slug: 'mnl', weekday: 1, sort: 5, status: 'retired' },
    { id: 'wnl', code: 'WNL', name: 'Wednesday Night League', slug: 'wnl', weekday: 3, sort: 6, status: 'draft' },
    // Training defaults to enrolment; this one is switched to EOIs (and has no category).
    {
      id: 'scrim',
      code: 'SCRIM',
      name: 'Scrim',
      slug: 'scrim',
      weekday: 5,
      sort: 7,
      kind: 'training',
      signupMode: 'interest',
      depositPlayerCents: 1000,
    },
    {
      id: 'adp',
      code: 'ADP',
      name: 'Adult Development Program',
      slug: 'adp',
      weekday: 6,
      sort: 8,
      kind: 'development',
      categoryId: 'cat_adult_training',
    },
  ])
  await db.insert(schema.seasons).values({
    id: 'tnl1',
    leagueId: 'tnl',
    name: 'TNL Q1 2027',
    slug: 'tnl-q1-2027',
    year: 2027,
    quarter: 1,
    startDate: '2027-01-14',
    settings: { sessions: ['20:00'], sessionMinutes: 60, meetings: 1, includeFinals: false, seed: 0, skipDates: [], defaultCourtIds: [] },
  })
  for (const [key, value] of Object.entries(over))
    await db
      .insert(schema.siteSettings)
      .values({ key, value: { ...(DEFAULT_SETTINGS as unknown as Record<string, object>)[key], ...value }, updatedAt: NOW.toISOString() })
  const deps = (o: Partial<PublicInterestDeps> = {}): PublicInterestDeps => ({
    db,
    mailer,
    secret: 'secret',
    siteUrl: 'https://staging.example',
    turnstileSecret: 'ts',
    ip: '203.0.113.9',
    fetch: turnstileOk,
    now: NOW,
    ...o,
  })
  const sent = (template: string) => logs.filter((l) => l.includes(`template=${template}`))
  return { db, stats, logs, deps, sent }
}

const ANSWERS = {
  birth_year: 1995,
  gender: 'female',
  suburb: 'Marrickville',
  playing_level: 'intermediate',
  position: 'setter',
  captain: 'no',
  heard_from: ['friends'],
  share_details: true,
  placed_randomly: true,
  waiver: true,
}

const player = (over: Record<string, unknown> = {}) => ({
  kind: 'player',
  programmeIds: ['tnl'],
  person: { firstName: 'Pat', lastName: 'Lee', email: 'Pat@Example.com', phone: '0412 345 678' },
  answers: ANSWERS,
  turnstileToken: 'tok',
  ...over,
})

const team = (over: Record<string, unknown> = {}) => ({
  ...player(),
  kind: 'team',
  programmeIds: ['tnl', 'fnl'],
  teamName: '  Spike   Lee ',
  members: [
    { firstName: 'Jo', lastName: 'Park', email: 'jo@example.com', gender: 'male' },
    { firstName: '', lastName: '', email: '' },
    { firstName: 'Sam', lastName: 'Ng', phone: '0400 111 222', vnswNumber: 'V123' },
  ],
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

const fieldErrors = (e: HttpError) => (e.details?.fieldErrors ?? {}) as Record<string, string>

describe('loadInterestForm', () => {
  it('offers active programmes in interest mode with EOIs on (null mode = the kind default), grouped by category', async () => {
    const s = await setup()
    s.stats.reset()
    const { form, slug, offered } = await loadInterestForm(s.db, NOW, { turnstileSiteKey: 'site' })
    expect(s.stats.queries).toBeLessThanOrEqual(10)
    expect(slug).toBeNull()
    expect(offered).toBe(3)
    expect(form.groups.map((g) => [g.category?.name ?? null, g.programmes.map((p) => p.code)])).toEqual([
      ['Mixed Leagues', ['TNL', 'FNL']],
      [null, ['SCRIM']],
    ])
    const tnl = form.groups[0]!.programmes[0]!
    expect(tnl.nextStarts).toBe('Next season starts Thursday 14 January 2027')
    expect(tnl.depositTeamCents).toBe(20000)
    expect(form.preselectedId).toBeNull()
    expect(form.turnstileSiteKey).toBe('site')
    // The built-in questions (no form chosen), never a team_name field.
    expect(form.formId).toBeNull()
    expect(form.fields.map((f) => f.key)).toContain('playing_level')
    expect(form.fields.some((f) => f.type === 'team_name')).toBe(false)
    expect(form.payid).toBeNull()
    expect(form.maxMembers).toBe(DEFAULT_SETTINGS.interest.maxMembers)
  })

  it('says what a slug is: offered (ticked), a real programme not taking EOIs, or unknown (drafts too)', async () => {
    const s = await setup()
    const ok = await loadInterestForm(s.db, NOW, { programmeSlug: 'FNL' })
    expect(ok.slug).toMatchObject({ status: 'offered', programme: { id: 'fnl' } })
    expect(ok.form.preselectedId).toBe('fnl')
    for (const slug of ['snl', 'sal', 'mnl', 'adp'])
      expect((await loadInterestForm(s.db, NOW, { programmeSlug: slug })).slug?.status).toBe('not_offered')
    for (const slug of ['wnl', 'nope']) expect((await loadInterestForm(s.db, NOW, { programmeSlug: slug })).slug?.status).toBe('unknown')
  })

  it('uses the form Settings → Interest names, unless it is archived, and shows the PayID', async () => {
    const s = await setup({ interest: { formId: 'f1' }, payid: { name: 'M Mouhajer', payId: '0414 911 544' } })
    await s.db.insert(schema.enrolmentForms).values({
      id: 'f1',
      name: 'EOI',
      version: 3,
      confirmationText: 'See you soon.',
      fields: [
        { key: 'team_name', type: 'team_name', label: 'Team', appliesTo: ['team'] },
        { key: 'level', type: 'radio', label: 'Level', options: [{ value: 'a', label: 'A' }] },
        { key: 'old', type: 'text', label: 'Old', retired: true },
      ],
    })
    const { form } = await loadInterestForm(s.db, NOW)
    expect(form).toMatchObject({ formId: 'f1', formVersion: 3, confirmationText: 'See you soon.', payid: { payId: '0414 911 544' } })
    expect(form.fields.map((f) => f.key)).toEqual(['level'])
    await s.db.update(schema.enrolmentForms).set({ archivedAt: NOW.toISOString() }).where(eq(schema.enrolmentForms.id, 'f1'))
    expect((await loadInterestForm(s.db, NOW)).form.formId).toBeNull()
  })
})

describe('submitInterest', () => {
  it('saves a player EOI (competition pool), emails the organiser and the player, and answers without the reference', async () => {
    const s = await setup()
    s.stats.reset()
    const r = await submitInterest(s.deps(), player({ programmeIds: ['tnl', 'fnl'] }))
    expect(s.stats.queries).toBeLessThanOrEqual(30)
    expect(s.stats.maxParams).toBeLessThanOrEqual(100)
    expect(r).toEqual({
      status: 'sent',
      message: DEFAULT_SETTINGS.interest.successText,
      confirmationText: null,
      deposit: { cents: 2500, amount: '$25', payid: null, emailed: true },
    })
    expect(JSON.stringify(r)).not.toContain('EOI-')
    const [eoi] = await s.db.select().from(schema.interests)
    expect(eoi).toMatchObject({ kind: 'player', teamName: null, depositCents: 2500, source: 'public', formId: null })
    expect(eoi!.reference).toMatch(INTEREST_REFERENCE_PATTERN)
    expect(eoi!.answers).toMatchObject({ playing_level: 'intermediate', position: 'setter' })
    expect(eoi!.answers).not.toHaveProperty('gender')
    const progs = await s.db.select().from(schema.interestProgrammes)
    expect(progs.map((p) => [p.programmeId, p.status]).toSorted()).toEqual([
      ['fnl', 'new'],
      ['tnl', 'new'],
    ])
    const [pl] = await s.db.select().from(schema.players)
    expect(pl).toMatchObject({
      pool: 'competition',
      firstName: 'Pat',
      email: 'pat@example.com',
      gender: 'female',
      suburb: 'Marrickville',
      birthYear: 1995,
      source: 'interest',
    })
    const notes = s.sent('interest.notify')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain(`to=${DEFAULT_SETTINGS.contact.email}`)
    expect(notes[0]).toContain(`https://staging.example/admin/interest/${eoi!.id}`)
    const acks = s.sent('interest.ack')
    expect(acks).toHaveLength(1)
    expect(acks[0]).toContain('to=pat@example.com')
    expect(acks[0]).toContain(eoi!.reference)
    expect(acks[0]).toContain('Thursday Night League, Friday Night League')
  })

  it('saves a team EOI: the captain first, blank member rows dropped, the highest team deposit, PayID on the page', async () => {
    const s = await setup({ payid: { name: 'M Mouhajer', payId: '0414 911 544' }, interest: { notifyEmails: ['ops@example.com'] } })
    const r = await submitInterest(s.deps(), team())
    expect(r.deposit).toEqual({ cents: 20000, amount: '$200', payid: { name: 'M Mouhajer', payId: '0414 911 544' }, emailed: true })
    const [eoi] = await s.db.select().from(schema.interests)
    expect(eoi).toMatchObject({ kind: 'team', teamName: 'Spike Lee', depositCents: 20000 })
    const members = await s.db.select().from(schema.interestMembers).orderBy(schema.interestMembers.sort)
    expect(members.map((m) => [m.role, m.details.firstName, m.details.email, m.details.phone])).toEqual([
      ['captain', 'Pat', 'pat@example.com', '0412 345 678'],
      ['player', 'Jo', 'jo@example.com', null],
      ['player', 'Sam', null, '0400 111 222'],
    ])
    expect(members[1]!.details.gender).toBe('male')
    expect(members[2]!.details.vnswNumber).toBe('V123')
    expect(await s.db.select().from(schema.players)).toHaveLength(3)
    expect(s.sent('interest.notify').map((l) => /to=(\S+)/.exec(l)?.[1])).toEqual(['ops@example.com'])
    const ack = s.sent('interest.ack')[0]!
    expect(ack).toContain('Pay it by PayID to 0414 911 544')
    expect(ack).toContain('Jo Park, jo@example.com')
  })

  it('uses the training pool when only training is picked, and no deposit when none is set', async () => {
    const s = await setup()
    const r = await submitInterest(s.deps(), player({ programmeIds: ['scrim'] }))
    expect(r.deposit).toEqual({ cents: 1000, amount: '$10', payid: null, emailed: true })
    expect((await s.db.select().from(schema.players))[0]!.pool).toBe('training')
    const t = await setup()
    const none = await submitInterest(t.deps(), team({ programmeIds: ['scrim'], members: [] }))
    expect(none.deposit).toBeNull()
  })

  it('refuses programmes that are not offered, none at all, and more than the most allowed', async () => {
    const s = await setup({ interest: { maxProgrammes: 1 } })
    // Each with its own address: refused forms still count against the mailbox limit.
    const as = (i: number) => ({ firstName: 'Pat', lastName: 'Lee', email: `pat${i}@example.com`, phone: '0412 345 678' })
    for (const [i, ids] of [['snl'], ['sal'], ['mnl'], ['wnl'], ['adp'], ['nope'], ['tnl', 'snl']].entries()) {
      const e = await failsWith(submitInterest(s.deps({ ip: null }), player({ programmeIds: ids, person: as(i) })), 400, 'invalid_input')
      expect(Object.keys(fieldErrors(e))).toEqual(['programmes'])
    }
    expect(fieldErrors(await failsWith(submitInterest(s.deps({ ip: null }), player({ programmeIds: [] })), 400)).programmes).toBe(
      'Tick at least one.',
    )
    expect(
      fieldErrors(await failsWith(submitInterest(s.deps({ ip: null }), player({ programmeIds: ['tnl', 'fnl'] })), 400)).programmes,
    ).toBe('Tick at most 1.')
    expect(await s.db.select().from(schema.interests)).toHaveLength(0)
  })

  it('reports every bad field at once: kind, person, answers, team name and members per Settings → Interest', async () => {
    const s = await setup({
      interest: {
        maxMembers: 3,
        memberFields: { email: 'required', phone: 'optional', gender: 'off', birthYear: 'optional', vnswNumber: 'off' },
      },
    })
    const kind = await failsWith(submitInterest(s.deps({ ip: null }), player({ kind: 'coach' })), 400)
    expect(Object.keys(fieldErrors(kind))).toEqual(['kind'])
    const bad = await failsWith(
      submitInterest(
        s.deps({ ip: null }),
        team({
          teamName: '',
          person: { firstName: 'Pat', lastName: '', email: 'nope', phone: '0412 345 678' },
          answers: { ...ANSWERS, waiver: false },
          members: [
            { firstName: 'Jo', lastName: 'Park' },
            { firstName: 'Al', lastName: 'Ng', email: 'al@example.com', birthYear: '1800', gender: 'not a gender' },
          ],
        }),
      ),
      400,
      'invalid_input',
    )
    expect(Object.keys(fieldErrors(bad)).toSorted()).toEqual([
      'email',
      'lastName',
      'members.0.email',
      'members.1.birthYear',
      'teamName',
      'waiver',
    ])
    const many = await failsWith(
      submitInterest(
        s.deps({ ip: null }),
        team({ members: ['A', 'B', 'C'].map((n) => ({ firstName: n, lastName: 'X', email: `${n}@example.com` })) }),
      ),
      400,
    )
    expect(fieldErrors(many).members).toBe('At most 2 team members besides the captain.')
    expect(await s.db.select().from(schema.interests)).toHaveLength(0)
  })

  it('drops member details that are switched off, and players ignore team fields', async () => {
    const s = await setup({
      interest: { memberFields: { email: 'off', phone: 'off', gender: 'off', birthYear: 'off', vnswNumber: 'off' } },
    })
    await submitInterest(s.deps(), team({ members: [{ firstName: 'Jo', lastName: 'Park', email: 'jo@example.com', phone: 'x' }] }))
    const members = await s.db.select().from(schema.interestMembers).orderBy(schema.interestMembers.sort)
    expect(members[1]!.details).toMatchObject({ firstName: 'Jo', email: null, phone: null })
    const t = await setup()
    await submitInterest(t.deps(), player({ teamName: 'Ignored', members: [{ firstName: 'Jo', lastName: 'Park' }] }))
    expect((await t.db.select().from(schema.interests))[0]!.teamName).toBeNull()
    expect(await t.db.select().from(schema.interestMembers)).toHaveLength(1)
  })

  it('refuses a failed Turnstile check and missing keys, and discards a filled-in honeypot without calling Turnstile', async () => {
    const s = await setup()
    await failsWith(submitInterest(s.deps({ fetch: turnstileNo }), player()), 403, 'turnstile_failed')
    await failsWith(submitInterest(s.deps({ turnstileSecret: null }), player()), 503, 'unavailable')
    let called = false
    const spy = (async () => ((called = true), Response.json({ success: true }))) as unknown as typeof fetch
    const r = await submitInterest(s.deps({ fetch: spy }), player({ website: 'http://spam.example' }))
    expect(r).toMatchObject({ status: 'sent', message: DEFAULT_SETTINGS.interest.successText })
    expect(called).toBe(false)
    expect(await s.db.select().from(schema.interests)).toHaveLength(0)
    expect(s.logs).toHaveLength(0)
  })

  it('limits per IP before Turnstile, and per mailbox (+tags and Gmail dots count as one)', async () => {
    const s = await setup()
    for (let i = 0; i < INTEREST_RATE.perIpHour; i++) await submitInterest(s.deps({ fetch: turnstileNo }), player()).catch(() => null)
    await failsWith(submitInterest(s.deps(), player()), 429, 'rate_limited')

    const t = await setup()
    const emails = ['p.at@gmail.com', 'pat+1@gmail.com', 'pat@googlemail.com', 'PAT@gmail.com', 'pat+x@gmail.com']
    for (const [i, email] of emails.entries())
      await submitInterest(
        t.deps({ ip: `198.51.100.${i}` }),
        player({ person: { firstName: 'Pat', lastName: 'Lee', email, phone: '0412 345 678' } }),
      )
    await failsWith(
      submitInterest(
        t.deps({ ip: '198.51.100.99' }),
        player({ person: { firstName: 'Pat', lastName: 'Lee', email: 'pa.t@gmail.com', phone: '0412 345 678' } }),
      ),
      429,
      'rate_limited',
    )
    expect(await t.db.select().from(schema.interests)).toHaveLength(INTEREST_RATE.perEmailHour)
  })

  it('notifies at most notifyPerDay a day, and sends no acknowledgement or notification when they are off', async () => {
    const s = await setup({ interest: { notifyPerDay: 1 } })
    await submitInterest(s.deps(), player())
    await submitInterest(
      s.deps({ ip: '198.51.100.7' }),
      player({ person: { firstName: 'Sam', lastName: 'Ng', email: 'sam@example.com', phone: '0400 000 000' } }),
    )
    expect(await s.db.select().from(schema.interests)).toHaveLength(2)
    expect(s.sent('interest.notify')).toHaveLength(1)
    expect(s.sent('interest.ack')).toHaveLength(2)

    const quiet = await setup({ interest: { notify: false, acknowledge: false }, payid: { payId: 'pay@example.com' } })
    const r = await submitInterest(quiet.deps(), player({ programmeIds: ['fnl'] }))
    expect(r.deposit).toMatchObject({ emailed: false, payid: { payId: 'pay@example.com' } })
    expect(quiet.logs).toHaveLength(0)
  })

  it('never overwrites an existing player with what a public form says', async () => {
    const s = await setup()
    await s.db.insert(schema.players).values({
      id: 'p1',
      pool: 'competition',
      firstName: 'Pat',
      lastName: 'Lee',
      email: 'pat@example.com',
      phone: '0499 999 999',
      suburb: 'Tempe',
    })
    await submitInterest(s.deps(), player())
    const rows = await s.db.select().from(schema.players)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ phone: '0499 999 999', suburb: 'Tempe' })
    const [m] = await s.db.select().from(schema.interestMembers)
    expect(m).toMatchObject({ playerId: 'p1' })
    expect(m!.details.suburb).toBe('Marrickville')
  })
})

describe('EOI emails', () => {
  it('lists what was sent, escapes it, and sets reply-to on the notification', () => {
    const data = {
      name: 'Pat <b>',
      reference: 'EOI-7K3Q',
      kind: 'team' as const,
      teamName: 'Spikes',
      programmes: ['Thursday Night League'],
      answers: [{ label: 'Playing level', value: '<i>Intermediate</i>' }],
      members: ['Jo Park'],
      deposit: '$200',
      payid: { name: 'M', payId: '0414', instructions: '' },
    }
    const ack = renderEmail('interest.ack', { ...data, text: 'Thanks.' })
    expect(ack.subject).toBe('We’ve got your details (EOI-7K3Q)'.replace('’', "'"))
    expect(ack.text).toContain('Playing level: <i>Intermediate</i>')
    expect(ack.text).toContain('The deposit is $200 per team. Pay it by PayID to 0414 (M), with EOI-7K3Q as the payment description.')
    expect(ack.html).not.toContain('<i>')
    const note = renderEmail('interest.notify', {
      ...data,
      email: 'pat@example.com',
      phone: '0412',
      url: 'https://x/admin/interest/1',
      receivedAt: NOW.toISOString(),
    })
    expect(note.replyTo).toBe('pat@example.com')
    expect(note.subject).toBe('Expression of interest: Spikes (team, captain Pat <b>) (EOI-7K3Q)')
    expect(note.html).toContain('https://x/admin/interest/1')
  })

  it('notifies the Notify addresses (each once), else the contact email', () => {
    expect(interestNotifyAddresses('Tempevb@gmail.com', ['ops@example.com', 'OPS@example.com'])).toEqual(['ops@example.com'])
    expect(interestNotifyAddresses('Tempevb@gmail.com', [])).toEqual(['tempevb@gmail.com'])
    expect(interestNotifyAddresses('', [])).toEqual([])
  })
})
