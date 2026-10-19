import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../lib/content/settings'
import { runHousekeeping } from '../cron'
import { createTestDb, type TestDb } from '../db/testing'
import {
  auditLog,
  interestMembers,
  interestProgrammes,
  interests,
  leagues,
  players,
  registrations,
  products,
  seasons,
  siteSettings,
  teams,
  user,
  type MemberDetails,
} from '../db/schema'
import { HttpError } from '../http'
import { createInterest, emptyDetails } from '../players/core'
import {
  addInterestByHand,
  bulkInterestAction,
  deleteInterests,
  detailsDiff,
  exportInterests,
  getInterest,
  interestAction,
  interestsCsv,
  interestSummary,
  listInterests,
  newInterestCount,
  parseInterestFilter,
  pruneInterestsStatement,
  type InterestFilter,
} from './admin'

// Admin → Interest against a migrated in-memory SQLite: the inbox's filters (since the last season started per
// programme), statuses, payments, archive and the cron prune, delete (with the players it created), EOIs added by
// hand, "Use these details" and the CSV.

const NOW = new Date('2026-10-20T03:00:00.000Z') // 2pm Sydney
const admin = { id: 'adm', ip: '203.0.113.9' }
const settings = { sessions: ['20:00'], sessionMinutes: 60, meetings: 1, includeFinals: false, seed: 0, skipDates: [], defaultCourtIds: [] }
const season = (id: string, leagueId: string, startDate: string, quarter: number) => ({
  id,
  leagueId,
  name: `${leagueId.toUpperCase()} Q${quarter} 2026`,
  slug: `${leagueId}-q${quarter}-2026`,
  year: 2026,
  quarter,
  startDate,
  settings,
})
const person = (firstName: string, lastName: string, email: string | null, extra: Partial<MemberDetails> = {}): MemberDetails => ({
  ...emptyDetails(firstName, lastName, email),
  phone: '0412 345 678',
  ...extra,
})
const filter = (f: Partial<InterestFilter> = {}): InterestFilter => ({
  programmeId: null,
  status: 'open',
  kind: null,
  since: 'all',
  archived: 'active',
  q: null,
  ...f,
})

const rejects = async (p: Promise<unknown>, status: number, message?: RegExp) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpError)
  expect((e as HttpError).status).toBe(status)
  if (message) expect((e as HttpError).message).toMatch(message)
  return e as HttpError
}

let db: TestDb
const eoi = (
  at: string,
  opts: {
    kind?: 'player' | 'team'
    programmes?: string[]
    members?: MemberDetails[]
    teamName?: string
    answers?: Record<string, unknown>
  } = {},
) =>
  createInterest(db, {
    kind: opts.kind ?? 'player',
    pool: 'competition',
    teamName: opts.teamName ?? (opts.kind === 'team' ? 'Spike Lee' : null),
    members: opts.members ?? [person('Sam', 'Lee', 'sam@example.com')],
    programmeIds: opts.programmes ?? ['tnl'],
    answers: opts.answers ?? { playing_level: 'intermediate', position: 'setter' },
    formId: null,
    formVersion: null,
    depositCents: 2000,
    source: 'public',
    now: new Date(at),
  })

beforeEach(async () => {
  db = createTestDb().db
  await db.insert(user).values({ id: 'adm', name: 'Michael', email: 'michael@example.com', emailVerified: true, role: 'admin' })
  await db.insert(leagues).values([
    { id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4, depositPlayerCents: 2000, depositTeamCents: 10000 },
    { id: 'fnl', code: 'FNL', name: 'Friday Night League', slug: 'fnl', weekday: 5, depositPlayerCents: 3000 },
    { id: 'ssl', code: 'TVSL', name: 'Super League', slug: 'tvsl', weekday: 0 },
    { id: 'adp', code: 'ADP', name: 'Adult Development', slug: 'adp', weekday: 1, kind: 'development' },
  ])
  // TNL's last season started 8 Oct (Sydney); FNL's next one hasn't started, its last started 10 Jul.
  await db.insert(seasons).values([season('tnl3', 'tnl', '2026-07-09', 3), season('tnl4', 'tnl', '2026-10-08', 4)])
  await db.insert(seasons).values([season('fnl3', 'fnl', '2026-07-10', 3), season('fnl1', 'fnl', '2027-01-15', 1)])
  await db.insert(teams).values({ id: 'aces', name: 'ACES', slug: 'aces' })
})

describe('the inbox', () => {
  it('lists newest first with the contact, programmes and answers, and filters by programme, status, kind and search', async () => {
    const a = await eoi('2026-09-01T00:00:00Z', { programmes: ['tnl', 'fnl'] })
    const b = await eoi('2026-10-12T00:00:00Z', {
      kind: 'team',
      teamName: 'Block Party',
      members: [person('Jo', 'Park', 'jo@example.com'), person('Kim', 'Ng', null)],
    })
    const c = await eoi('2026-10-15T00:00:00Z', { programmes: ['fnl'], members: [person('Ana', 'Cruz', 'ana@example.com')] })
    const all = await listInterests(db, filter(), {}, NOW)
    expect(all.rows.map((r) => r.reference)).toEqual([c.reference, b.reference, a.reference])
    expect(all.total).toBe(3)
    const team = all.rows[1]!
    expect(team).toMatchObject({ kind: 'team', teamName: 'Block Party', members: 2, level: 'intermediate', position: 'setter' })
    expect(team.contact).toMatchObject({ firstName: 'Jo', lastName: 'Park', email: 'jo@example.com' })
    expect(all.rows[2]!.programmes.map((p) => p.code).sort()).toEqual(['FNL', 'TNL'])

    expect((await listInterests(db, filter({ programmeId: 'fnl' }), {}, NOW)).rows.map((r) => r.id)).toEqual([c.id, a.id])
    expect((await listInterests(db, filter({ kind: 'team' }), {}, NOW)).rows.map((r) => r.id)).toEqual([b.id])
    expect((await listInterests(db, filter({ q: 'block' }), {}, NOW)).rows.map((r) => r.id)).toEqual([b.id])
    // A team member's name finds the team; every word must match.
    expect((await listInterests(db, filter({ q: 'kim ng' }), {}, NOW)).rows.map((r) => r.id)).toEqual([b.id])
    expect((await listInterests(db, filter({ q: 'ana@' }), {}, NOW)).rows.map((r) => r.id)).toEqual([c.id])
    expect((await listInterests(db, filter({ q: a.reference }), {}, NOW)).rows.map((r) => r.id)).toEqual([a.id])
    expect((await listInterests(db, filter({ q: 'nobody' }), {}, NOW)).total).toBe(0)

    // Status per programme: placed in TNL, still open for FNL.
    await interestAction(db, admin, a.id, { action: 'status', programmeId: 'tnl', status: 'placed', seasonId: 'tnl4', teamId: 'aces' }, NOW)
    expect((await listInterests(db, filter({ programmeId: 'tnl' }), {}, NOW)).rows.map((r) => r.id)).toEqual([b.id])
    expect((await listInterests(db, filter({ programmeId: 'fnl' }), {}, NOW)).rows.map((r) => r.id)).toEqual([c.id, a.id])
    expect((await listInterests(db, filter({ programmeId: 'tnl', status: 'placed' }), {}, NOW)).rows.map((r) => r.id)).toEqual([a.id])
    expect((await listInterests(db, filter({ status: 'any' }), {}, NOW)).total).toBe(3)
  })

  it('pages with a cursor', async () => {
    for (let i = 0; i < 5; i++) await eoi(`2026-10-1${i}T00:00:00Z`, { members: [person('P', `N${i}`, `p${i}@example.com`)] })
    const first = await listInterests(db, filter(), { limit: 2 }, NOW)
    expect(first.rows).toHaveLength(2)
    expect(first.total).toBe(5)
    const second = await listInterests(db, filter(), { limit: 2, before: first.next }, NOW)
    const third = await listInterests(db, filter(), { limit: 2, before: second.next }, NOW)
    expect([...first.rows, ...second.rows, ...third.rows].map((r) => r.contact?.lastName)).toEqual(['N4', 'N3', 'N2', 'N1', 'N0'])
    expect(third.next).toBeNull()
  })

  it('"since the last season started" uses each programme’s own last started season, in Sydney time', async () => {
    // 7 Oct 13:30 UTC is 8 Oct 00:30 Sydney: inside TNL's window (TNL Q4 started 8 Oct), though the UTC date is the 7th.
    const justIn = await eoi('2026-10-07T13:30:00Z')
    const before = await eoi('2026-10-07T12:00:00Z') // 7 Oct 11pm Sydney: before TNL Q4
    const fnlOld = await eoi('2026-08-01T00:00:00Z', { programmes: ['fnl'] }) // FNL's last started season is Q3 (10 Jul)
    const fnlOlder = await eoi('2026-07-01T00:00:00Z', { programmes: ['fnl'] })
    const tvsl = await eoi('2025-01-01T00:00:00Z', { programmes: ['ssl'] }) // no season yet: any time counts
    const tnl = await listInterests(db, filter({ programmeId: 'tnl', since: 'season' }), {}, NOW)
    expect(tnl.rows.map((r) => r.id)).toEqual([justIn.id])
    const any = await listInterests(db, filter({ since: 'season' }), {}, NOW)
    expect(new Set(any.rows.map((r) => r.id))).toEqual(new Set([justIn.id, fnlOld.id, tvsl.id]))
    expect(any.rows.map((r) => r.id)).not.toContain(before.id)
    expect(any.rows.map((r) => r.id)).not.toContain(fnlOlder.id)
    const opt = any.programmes.find((p) => p.id === 'tnl')!
    expect(opt).toMatchObject({ since: '2026-10-08', lastSeason: { id: 'tnl4' }, openSince: 1 })
    expect(opt.counts.new).toBe(2)
    // Development programmes take enrolments by default: listed only once they have EOIs.
    expect(any.programmes.map((p) => p.id)).not.toContain('adp')
  })

  it('parses the query string with safe defaults', () => {
    expect(parseInterestFilter(new URLSearchParams('status=nope&archived=x&since=season&kind=team&programme=tnl'))).toEqual({
      programmeId: 'tnl',
      status: 'open',
      kind: 'team',
      since: 'season',
      archived: 'active',
      q: null,
    })
    expect(parseInterestFilter(new URLSearchParams('programme=../x')).programmeId).toBeNull()
  })

  it('counts new EOIs for the badge and the dashboard', async () => {
    const a = await eoi('2026-10-12T00:00:00Z', { programmes: ['tnl', 'fnl'] })
    await eoi('2026-10-13T00:00:00Z', { programmes: ['fnl'], members: [person('Ana', 'Cruz', 'ana@example.com')] })
    expect(await newInterestCount(db)).toBe(2)
    await interestAction(db, admin, a.id, { action: 'status', programmeId: 'tnl', status: 'contacted' }, NOW)
    expect(await newInterestCount(db)).toBe(2) // still new for FNL
    await interestAction(db, admin, a.id, { action: 'status', programmeId: 'fnl', status: 'declined' }, NOW)
    expect(await newInterestCount(db)).toBe(1)
    const s = await interestSummary(db, NOW)
    expect(s.newCount).toBe(1)
    expect(s.programmes.find((p) => p.code === 'TNL')).toMatchObject({ new: 0, open: 1, openSince: 1 })
    expect(s.programmes.find((p) => p.code === 'FNL')).toMatchObject({ new: 1, open: 1 })
  })
})

describe('one EOI', () => {
  it('shows its people with their player records and what differs, its programmes, answers and history', async () => {
    await db.insert(players).values({
      id: 'sam',
      pool: 'competition',
      firstName: 'Sam',
      lastName: 'Lee',
      email: 'sam@example.com',
      phone: '0400 000 000',
      suburb: 'Tempe',
      createdAt: '2025-01-01T00:00:00.000Z',
    })
    const r = await eoi('2026-10-12T00:00:00Z', {
      kind: 'team',
      members: [person('sam', 'LEE', 'Sam@Example.com', { suburb: 'Marrickville', gender: 'male' }), person('Kim', 'Ng', null)],
    })
    const d = await getInterest(db, r.id)
    expect(d.interest).toMatchObject({ reference: r.reference, kind: 'team', depositCents: 2000, source: 'public' })
    expect(d.members.map((m) => m.role)).toEqual(['captain', 'player'])
    const sam = d.members[0]!
    expect(sam.player?.id).toBe('sam')
    expect(sam.createdHere).toBe(false)
    // Names differ only in case and the email in case: not differences. Phone, suburb and gender are.
    expect(sam.diff.map((x) => x.field).sort()).toEqual(['gender', 'phone', 'suburb'])
    expect(d.members[1]!.createdHere).toBe(true)
    expect(d.answers).toEqual([
      { key: 'playing_level', label: 'Playing level', text: 'Intermediate' },
      { key: 'position', label: 'What position do you play, or would you like to play?', text: 'Setter' },
    ])
    expect(d.formName).toBe('Built-in default')
    expect(d.pool).toBe('competition')
    await rejects(getInterest(db, 'nope'), 404)
  })

  it('changes notes, payments, statuses (with the placement checked), the team name and programmes, audited', async () => {
    const r = await eoi('2026-10-12T00:00:00Z', { kind: 'team', programmes: ['tnl'] })
    let d = await interestAction(db, admin, r.id, { action: 'note', note: '  Called 20/10  ' }, NOW)
    expect(d.interest.note).toBe('Called 20/10')
    await rejects(interestAction(db, admin, r.id, { action: 'mark_paid', method: 'bitcoin' }, NOW), 400, /how they paid/)
    d = await interestAction(db, admin, r.id, { action: 'mark_paid', method: 'payid', note: '12/10' }, NOW)
    expect(d.interest).toMatchObject({ paidAt: NOW.toISOString(), paymentNote: 'PayID: 12/10', paidByName: 'Michael' })
    d = await interestAction(db, admin, r.id, { action: 'mark_unpaid', note: 'bounced' }, NOW)
    expect(d.interest).toMatchObject({ paidAt: null, paymentNote: 'bounced', paidByName: null })

    await rejects(interestAction(db, admin, r.id, { action: 'status', programmeId: 'tnl', status: 'maybe' }, NOW), 400)
    await rejects(interestAction(db, admin, r.id, { action: 'status', programmeId: 'fnl', status: 'contacted' }, NOW), 404)
    // FNL's season isn't one of TNL's.
    await rejects(
      interestAction(db, admin, r.id, { action: 'status', programmeId: 'tnl', status: 'placed', seasonId: 'fnl3' }, NOW),
      400,
      /isn’t one of this programme’s/,
    )
    d = await interestAction(
      db,
      admin,
      r.id,
      { action: 'status', programmeId: 'tnl', status: 'placed', seasonId: 'tnl4', teamId: 'aces' },
      NOW,
    )
    expect(d.programmes[0]).toMatchObject({ status: 'placed', seasonName: 'TNL Q4 2026', teamName: 'ACES' })
    // Leaving placed clears where.
    d = await interestAction(db, admin, r.id, { action: 'status', programmeId: 'tnl', status: 'withdrawn' }, NOW)
    expect(d.programmes[0]).toMatchObject({ status: 'withdrawn', seasonId: null, teamId: null })

    d = await interestAction(db, admin, r.id, { action: 'team_name', teamName: 'Spike Lee 2' }, NOW)
    expect(d.interest.teamName).toBe('Spike Lee 2')
    d = await interestAction(db, admin, r.id, { action: 'add_programme', programmeId: 'fnl' }, NOW)
    expect(d.programmes.map((p) => p.code).sort()).toEqual(['FNL', 'TNL'])
    await rejects(interestAction(db, admin, r.id, { action: 'add_programme', programmeId: 'fnl' }, NOW), 409)
    d = await interestAction(db, admin, r.id, { action: 'remove_programme', programmeId: 'tnl' }, NOW)
    expect(d.programmes.map((p) => p.code)).toEqual(['FNL'])
    await rejects(interestAction(db, admin, r.id, { action: 'remove_programme', programmeId: 'fnl' }, NOW), 409, /at least one/)

    const audits = await db.select().from(auditLog).where(eq(auditLog.targetId, r.id))
    expect(audits.every((a) => a.action === 'interest.update')).toBe(true)
    expect(audits).toHaveLength(8)
    // The note's text isn't copied into the audit log.
    expect(JSON.stringify(audits.map((a) => a.after))).not.toContain('Called 20/10')
    expect(d.history.length).toBeGreaterThan(0)
  })

  it('archives and unarchives; the cron deletes EOIs archived longer than the retention, never open ones', async () => {
    const old = await eoi('2025-01-01T00:00:00Z')
    const recent = await eoi('2026-10-01T00:00:00Z', { members: [person('Ana', 'Cruz', 'ana@example.com')] })
    const open = await eoi('2024-01-01T00:00:00Z', { members: [person('Jo', 'Park', 'jo@example.com')] })
    await interestAction(db, admin, old.id, { action: 'archive' }, new Date('2025-06-01T00:00:00Z'))
    await interestAction(db, admin, recent.id, { action: 'archive' }, new Date('2026-10-10T00:00:00Z'))
    expect((await listInterests(db, filter({ status: 'any' }), {}, NOW)).rows.map((r) => r.id)).toEqual([open.id])
    expect((await listInterests(db, filter({ status: 'any', archived: 'archived' }), {}, NOW)).total).toBe(2)
    expect(await newInterestCount(db)).toBe(1)

    const r = await runHousekeeping(db, {}, NOW)
    expect(r.interestsPruned).toBe(1)
    expect((await db.select().from(interests)).map((i) => i.id).sort()).toEqual([open.id, recent.id].sort())
    // Its members and programmes went with it; the player stays in the directory.
    expect(await db.select().from(interestMembers).where(eq(interestMembers.interestId, old.id))).toHaveLength(0)
    expect(await db.select().from(interestProgrammes).where(eq(interestProgrammes.interestId, old.id))).toHaveLength(0)
    expect(await db.select().from(players).where(eq(players.firstName, 'Sam'))).toHaveLength(1)

    // Unarchived, it's back in the inbox.
    await interestAction(db, admin, recent.id, { action: 'unarchive' }, NOW)
    expect((await listInterests(db, filter({ status: 'any' }), {}, NOW)).total).toBe(2)

    // 0 = keep.
    await db.insert(siteSettings).values({
      key: 'interest',
      value: { ...DEFAULT_SETTINGS.interest, archivedRetentionDays: 0 },
      updatedAt: NOW.toISOString(),
    })
    expect(pruneInterestsStatement(db, 0, NOW)).toBeNull()
    await interestAction(db, admin, recent.id, { action: 'archive' }, new Date('2020-01-01T00:00:00Z'))
    expect((await runHousekeeping(db, {}, NOW)).interestsPruned).toBe(0)
  })

  it('bulk: marks contacted, archives, and refuses placed', async () => {
    const a = await eoi('2026-10-12T00:00:00Z', { programmes: ['tnl', 'fnl'] })
    const b = await eoi('2026-10-13T00:00:00Z', { members: [person('Ana', 'Cruz', 'ana@example.com')] })
    expect(
      await bulkInterestAction(db, admin, { action: 'status', ids: [a.id, b.id], status: 'contacted', programmeId: 'tnl' }, NOW),
    ).toEqual({
      changed: 2,
    })
    const fnl = await db.select().from(interestProgrammes).where(eq(interestProgrammes.programmeId, 'fnl'))
    expect(fnl[0]!.status).toBe('new')
    await rejects(bulkInterestAction(db, admin, { action: 'status', ids: [a.id], status: 'placed' }, NOW), 400)
    await rejects(bulkInterestAction(db, admin, { action: 'archive', ids: [] }, NOW), 400)
    expect(await bulkInterestAction(db, admin, { action: 'archive', ids: [a.id, b.id, 'missing'] }, NOW)).toEqual({ changed: 2 })
    expect(await bulkInterestAction(db, admin, { action: 'archive', ids: [a.id] }, NOW)).toEqual({ changed: 0 })
  })

  it('deletes for good with the players it created, keeping players that are on file or used elsewhere', async () => {
    await db.insert(players).values({ id: 'sam', pool: 'competition', firstName: 'Sam', lastName: 'Lee', email: 'sam@example.com' })
    const r = await eoi('2026-10-12T00:00:00Z', {
      kind: 'team',
      members: [person('Sam', 'Lee', 'sam@example.com'), person('Kim', 'Ng', null), person('Lou', 'Tan', 'lou@example.com')],
    })
    // Lou has since enrolled somewhere: kept.
    const lou = r.members[2]!.playerId
    await db.insert(products).values({ id: 'prod', kind: 'season', name: 'x', slug: 'x', priceCents: 0, programmeId: 'tnl' })
    await db.insert(registrations).values({ id: 'reg', productId: 'prod', playerId: lou, reference: 'TVB-2345', status: 'confirmed' })
    const res = await deleteInterests(db, admin, [r.id], {}, NOW)
    expect(res).toEqual({ deleted: 1, playersDeleted: 1 })
    expect((await db.select().from(players)).map((p) => p.firstName).sort()).toEqual(['Lou', 'Sam'])
    const a = await db.select().from(auditLog).where(eq(auditLog.action, 'interest.delete'))
    expect(a).toHaveLength(1)
    expect(JSON.stringify(a[0])).not.toMatch(/Kim|Lou|example\.com/)
    expect(a[0]!.before).toMatchObject({ references: [r.reference], people: 3 })

    const kept = await eoi('2026-10-13T00:00:00Z', { members: [person('Neo', 'Ra', 'neo@example.com')] })
    expect(await deleteInterests(db, admin, [kept.id], { keepPlayers: true }, NOW)).toEqual({ deleted: 1, playersDeleted: 0 })
    expect(await db.select().from(players).where(eq(players.firstName, 'Neo'))).toHaveLength(1)
  })
})

describe('added by hand', () => {
  it('saves a phone-call EOI through createInterest: matched players untouched, deposit from the programmes, audited', async () => {
    await db
      .insert(players)
      .values({ id: 'sam', pool: 'competition', firstName: 'Sam', lastName: 'Lee', email: 'sam@example.com', phone: '0400 000 000' })
    const r = await addInterestByHand(
      db,
      admin,
      {
        kind: 'team',
        teamName: '  Net Gains ',
        programmeIds: ['tnl', 'fnl'],
        members: [
          { firstName: 'Sam', lastName: 'Lee', email: 'SAM@example.com', phone: '0499 999 999' },
          { firstName: 'Kim', lastName: 'Ng' },
        ],
        answers: { playing_level: 'advanced', unknown_key: 'dropped' },
        note: 'Rang on Tuesday',
      },
      NOW,
    )
    const d = await getInterest(db, r.id)
    expect(d.interest).toMatchObject({ source: 'admin', teamName: 'Net Gains', note: 'Rang on Tuesday', depositCents: 10000 })
    expect(d.interest.answers).toMatchObject({ playing_level: 'advanced' })
    expect(d.interest.answers).not.toHaveProperty('unknown_key')
    expect(d.members[0]!.player?.id).toBe('sam')
    expect((await db.select().from(players).where(eq(players.id, 'sam')).get())!.phone).toBe('0400 000 000')
    expect(d.members[1]!.player?.pool).toBe('competition')
    expect((await db.select().from(players).where(eq(players.firstName, 'Kim')).get())!.source).toBe('admin')
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'interest.create'))).toHaveLength(1)
    // The deposit can be set by hand.
    const p = await addInterestByHand(
      db,
      admin,
      {
        kind: 'player',
        programmeIds: ['fnl'],
        members: [{ firstName: 'Ana', lastName: 'Cruz', phone: '0412 111 222' }],
        depositCents: null,
      },
      NOW,
    )
    expect((await getInterest(db, p.id)).interest.depositCents).toBeNull()
  })

  it('checks the input', async () => {
    expect(await db.select().from(interests)).toHaveLength(0)
    const ok = { kind: 'player', programmeIds: ['tnl'], members: [{ firstName: 'Ana', lastName: 'Cruz', email: 'ana@example.com' }] }
    await rejects(addInterestByHand(db, admin, { ...ok, kind: 'group' }, NOW), 400, /player or a team/)
    await rejects(addInterestByHand(db, admin, { ...ok, kind: 'team' }, NOW), 400, /team name/)
    await rejects(addInterestByHand(db, admin, { ...ok, programmeIds: [] }, NOW), 400, /programme/)
    await rejects(addInterestByHand(db, admin, { ...ok, programmeIds: ['gone'] }, NOW), 400, /no longer exists/)
    await rejects(addInterestByHand(db, admin, { ...ok, members: [{ firstName: 'Ana', lastName: '' }] }, NOW), 400, /first and last/)
    await rejects(addInterestByHand(db, admin, { ...ok, members: [{ firstName: 'Ana', lastName: 'Cruz' }] }, NOW), 400, /email or phone/)
    await rejects(addInterestByHand(db, admin, { ...ok, members: [{ firstName: 'A', lastName: 'C', email: 'nope' }] }, NOW), 400, /email/)
    await rejects(
      addInterestByHand(db, admin, { ...ok, members: [{ firstName: 'A', lastName: 'C', email: 'a@b.co', gender: 'x' }] }, NOW),
      400,
    )
    await rejects(
      addInterestByHand(db, admin, { ...ok, members: [...ok.members, { firstName: 'B', lastName: 'D' }] }, NOW),
      400,
      /team EOI/,
    )
    await rejects(addInterestByHand(db, admin, { ...ok, answers: { playing_level: 'pro' } }, NOW), 400, /Playing level/)
  })
})

describe('Use these details', () => {
  it('copies the chosen sent details onto the player, audited by field name only', async () => {
    await db
      .insert(players)
      .values({ id: 'sam', pool: 'competition', firstName: 'Sam', lastName: 'Lee', email: 'sam@example.com', phone: '0400 000 000' })
    const r = await eoi('2026-10-12T00:00:00Z', {
      members: [person('Sam', 'Lee', 'sam@example.com', { suburb: 'Tempe', gender: 'female' })],
    })
    const before = await getInterest(db, r.id)
    const member = before.members[0]!
    expect(member.diff.map((d) => d.field).sort()).toEqual(['gender', 'phone', 'suburb'])
    await rejects(interestAction(db, admin, r.id, { action: 'apply_details', memberId: member.id, fields: ['password'] }, NOW), 400)
    const d = await interestAction(db, admin, r.id, { action: 'apply_details', memberId: member.id, fields: ['suburb', 'phone'] }, NOW)
    expect(d.members[0]!.diff.map((x) => x.field)).toEqual(['gender'])
    const p = (await db.select().from(players).where(eq(players.id, 'sam')).get())!
    expect(p).toMatchObject({ suburb: 'Tempe', phone: '0412 345 678', gender: null })
    const a = await db.select().from(auditLog).where(eq(auditLog.action, 'player.update'))
    expect(a[0]!.after).toEqual({ fields: ['suburb', 'phone'], fromInterest: r.id })
  })

  it('compares normalised values', () => {
    const player = {
      id: 'p',
      pool: 'competition' as const,
      retiredAt: null,
      firstName: 'Sam',
      lastName: 'Lee',
      email: 'sam@example.com',
      phone: '0412 345 678',
      gender: null,
      birthYear: null,
      suburb: null,
      vnswNumber: null,
      guardianName: null,
      guardianEmail: null,
      guardianPhone: null,
      emergencyContact: null,
    }
    expect(detailsDiff(person('SAM', 'lee', 'Sam@Example.com', { phone: '0412345678' }), player)).toEqual([])
    expect(detailsDiff(person('Sam', 'Lee', null, { phone: null }), player)).toEqual([])
    expect(detailsDiff(person('Sam', 'Lee', null, { birthYear: 1990 }), player).map((d) => d.field)).toEqual(['birthYear'])
  })
})

describe('CSV', () => {
  it('exports one row per person with answers on the contact’s row, audited, spreadsheet-safe', async () => {
    await eoi('2026-10-12T00:00:00Z', {
      kind: 'team',
      teamName: '=HYPERLINK("x")',
      members: [person('Sam', 'Lee', 'sam@example.com'), person('Kim', 'Ng', null)],
    })
    const { csv, filename } = await exportInterests(db, admin, filter({ programmeId: 'tnl' }), NOW)
    expect(filename).toBe('interest-tnl-2026-10-20.csv')
    const lines = csv.trim().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('"Playing level"')
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")"`)
    expect(lines[1]).toContain('"Captain","Sam","Lee"')
    expect(lines[1]).toContain('"TNL: New"')
    expect(lines[1]).toContain('"Intermediate"')
    expect(lines[2]).toContain('"Member","Kim","Ng"')
    expect(lines[2]).not.toContain('Intermediate')
    const a = await db.select().from(auditLog).where(eq(auditLog.action, 'interest.export'))
    expect(a[0]!.after).toMatchObject({ rows: 2, interests: 1 })
  })

  it('labels retired and unknown answers', () => {
    const csv = interestsCsv(
      [
        {
          kind: 'player',
          reference: 'EOI-2345',
          teamName: null,
          answers: { old_q: 'yes' },
          depositCents: 2500,
          paidAt: null,
          paymentNote: null,
          note: null,
          source: 'public',
          archivedAt: null,
          createdAt: NOW.toISOString(),
          members: [{ role: 'player', details: person('A', 'B', 'a@example.com') }],
          programmes: [{ code: 'TNL', status: 'placed', seasonName: 'TNL Q4 2026', teamName: 'ACES' }],
        },
      ],
      [],
    )
    expect(csv).toContain('"old_q"')
    expect(csv).toContain('"TNL: Placed (TNL Q4 2026, ACES)"')
    expect(csv).toContain('"25.00"')
  })
})
