import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { tags } from '../cache'
import { createTestDb, type QueryStats, type TestDb } from '../db/testing'
import {
  auditLog,
  categories,
  courts,
  developmentTerms,
  events,
  matchDays,
  matches,
  menuItems,
  pageDataRefs,
  pages,
  players,
  products,
  programmes,
  programmeSessions,
  redirects,
  registrations,
  seasons,
  user,
  venues,
  type SeasonSettings,
} from '../db/schema'
import { HttpError } from '../http'
import { renamedLeagueSlug } from '../site'
import { createCategory, deleteCategory, listCategories, reorderCategories, updateCategory } from './categories'
import {
  createProgramme,
  deleteProgramme,
  getProgramme,
  listProgrammes,
  nextInstanceDates,
  setProgrammeStatus,
  updateProgramme,
} from './programmes'
import { addSessions, createEvent, createTerm, deleteSession, listSessions, listTerms, updateEvent, updateSession } from './schedule'
import { createCourt, createVenue, deleteCourt, deleteVenue, listVenues, reorderCourts, updateCourt } from './venues'

const NOW = new Date('2026-10-18T00:00:00.000Z')
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

let db: TestDb
let stats: QueryStats
const admin = { id: 'adm', ip: '203.0.113.9' }

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

const settings: SeasonSettings = {
  sessions: ['20:00'],
  sessionMinutes: 60,
  meetings: 1,
  includeFinals: false,
  seed: 1,
  skipDates: [],
  defaultCourtIds: [],
}

beforeEach(async () => {
  ;({ db, stats } = createTestDb())
  await db.insert(user).values({ id: 'adm', name: 'adm', email: 'adm@example.com', emailVerified: true, role: 'admin' })
  await db
    .insert(venues)
    .values({ id: 'tempe', name: 'Robyn Webster Sports Centre', slug: 'robyn-webster', address: 'Holbeach Ave, Tempe NSW 2044' })
  await db.insert(courts).values([
    { id: 'c1', venueId: 'tempe', name: 'Court 1', sort: 0 },
    { id: 'c2', venueId: 'tempe', name: 'Court 2', sort: 1 },
  ])
})

const newLeague = (extra: Record<string, unknown> = {}) =>
  createProgramme(
    db,
    admin,
    {
      kind: 'league',
      name: 'Thursday Night League',
      code: 'tnl',
      categoryId: 'cat_mixed_leagues',
      weekday: 4,
      defaultVenueId: 'tempe',
      startTime: '20:00',
      endTime: '22:00',
      ...extra,
    },
    NOW,
  )

describe('programmes', () => {
  it('creates a draft with a generated summary line and audits it', async () => {
    const { result, purge } = await newLeague()
    expect(result.programme).toMatchObject({ code: 'TNL', slug: 'tnl', kind: 'league', status: 'draft', active: false })
    expect(result.path).toBe('/leagues/tnl')
    expect(result.generated.summaryLine).toBe('Thursday Night League (TNL) @ Robyn Webster Sports Centre, Tempe, Thursdays 8–10pm')
    expect(result.canDelete).toBe(true)
    expect(purge).toEqual({}) // drafts aren't public
    const log = await db.select().from(auditLog).where(eq(auditLog.action, 'programme.create')).all()
    expect(log).toHaveLength(1)
  })

  it('checks the input', async () => {
    await rejects(newLeague({ code: 'tn l' }), 400, /Code/)
    await rejects(newLeague({ categoryId: undefined }), 400, /category/)
    await rejects(newLeague({ categoryId: 'nope' }), 400, /category no longer exists/)
    await rejects(newLeague({ startTime: '22:00', endTime: '20:00' }), 400, /finish time/)
    await rejects(newLeague({ moreInfoUrl: 'javascript:alert(1)' }), 400, /More info/)
    await rejects(newLeague({ enrolmentOpensAt: '2026-11-01T00:00:00Z', enrolmentClosesAt: '2026-10-01T00:00:00Z' }), 400, /open before/)
    await rejects(createProgramme(db, admin, { kind: 'club', name: 'x', code: 'X', categoryId: 'cat_juniors', weekday: 1 }), 400)
    // /leagues/fixtures is the cross-league fixture list.
    await rejects(
      createProgramme(db, admin, { kind: 'league', name: 'Fixtures', code: 'FIXTURES', categoryId: 'cat_mixed_leagues', weekday: 1 }),
      400,
      /used by the site/,
    )
    await rejects(
      createProgramme(db, admin, { kind: 'training', name: 'x', code: 'X', slug: 'fixtures', categoryId: 'cat_juniors', weekday: 1 }),
      400,
      /used by the site/,
    )
    expect(await db.select().from(programmes).all()).toEqual([])
  })

  it('keeps code and URL unique across kinds, and away from pages', async () => {
    expect((await newLeague()).result.programme.code).toBe('TNL')
    await rejects(newLeague({ slug: 'tnl-2' }), 409, /code TNL/)
    await rejects(
      createProgramme(db, admin, {
        kind: 'training',
        name: 'Scrim',
        code: 'SCT',
        slug: 'tnl',
        categoryId: 'cat_adult_training',
        weekday: 2,
      }),
      409,
      /tnl/,
    )
    await db.insert(pages).values({ path: '/training/scrim', title: 'Old scrim page', body: { blocks: [], html: '' } })
    await rejects(
      createProgramme(db, admin, {
        kind: 'training',
        name: 'Scrim',
        code: 'SCT',
        slug: 'scrim',
        categoryId: 'cat_adult_training',
        weekday: 2,
      }),
      409,
      /Old scrim page/,
    )
  })

  it('refuses stale saves and records only what changed', async () => {
    const { result } = await newLeague()
    const base = result.programme.updatedAt
    const saved = await updateProgramme(
      db,
      admin,
      result.programme.id,
      { baseUpdatedAt: base, summaryLine: 'Our flagship league' },
      later(1),
    )
    expect(saved.result.generated.shownSummaryLine).toBe('Our flagship league')
    await rejects(updateProgramme(db, admin, result.programme.id, { baseUpdatedAt: base, name: 'X' }, later(2)), 409)
    // Reset to automatic.
    const reset = await updateProgramme(
      db,
      admin,
      result.programme.id,
      { baseUpdatedAt: saved.result.programme.updatedAt, summaryLine: null },
      later(3),
    )
    expect(reset.result.programme.summaryLine).toBeNull()
    const log = await db.select().from(auditLog).where(eq(auditLog.action, 'programme.update')).all()
    expect(log.map((l) => l.after)).toEqual([{ summaryLine: 'Our flagship league' }, { summaryLine: null }])
  })

  it('audits enrolment-only changes as programme.enrolment and sanitises the description', async () => {
    const { result } = await newLeague()
    const r = await updateProgramme(
      db,
      admin,
      result.programme.id,
      { baseUpdatedAt: result.programme.updatedAt, enrolmentOpen: true, capTeams: 12, priceCents: 15000 },
      later(1),
    )
    expect(r.result.programme).toMatchObject({ enrolmentOpen: true, capTeams: 12, priceCents: 15000 })
    expect(r.result.enrolmentOpenNow).toBe(false) // still a draft
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'programme.enrolment')).all()).toHaveLength(1)
    const d = await updateProgramme(
      db,
      admin,
      result.programme.id,
      {
        baseUpdatedAt: r.result.programme.updatedAt,
        description: [
          { type: 'paragraph', content: [{ type: 'text', text: '<b>Hi</b>' }] },
          { type: 'script', content: [] },
        ],
      },
      later(2),
    )
    expect(d.result.programme.description.html).toBe('<p>&lt;b&gt;Hi&lt;/b&gt;</p>')
  })

  it('saves the sign-up settings (mode, EOIs on/off, deposits, join text), checked and audited as enrolment', async () => {
    const { result } = await newLeague()
    expect(result.generated).toMatchObject({ signupMode: 'interest', defaultSignupMode: 'interest' })
    expect(result.generated.interestLine).toMatch(/Tell us you’re interested/)
    const id = result.programme.id
    const base = result.programme.updatedAt
    await rejects(updateProgramme(db, admin, id, { baseUpdatedAt: base, signupMode: 'waitlist' }, later(1)), 400, /Sign-ups/)
    await rejects(updateProgramme(db, admin, id, { baseUpdatedAt: base, depositPlayerCents: -5 }, later(1)), 400, /Player deposit/)
    await rejects(updateProgramme(db, admin, id, { baseUpdatedAt: base, interestText: 'x'.repeat(501) }, later(1)), 400, /join section/)
    const r = await updateProgramme(
      db,
      admin,
      id,
      {
        baseUpdatedAt: base,
        signupMode: 'enrolment',
        interestOpen: false,
        depositPlayerCents: 2000,
        depositTeamCents: 10000,
        interestText: '  Spots for Q1 are going fast.  ',
      },
      later(1),
    )
    expect(r.result.programme).toMatchObject({
      signupMode: 'enrolment',
      interestOpen: false,
      depositPlayerCents: 2000,
      depositTeamCents: 10000,
      interestText: 'Spots for Q1 are going fast.',
    })
    expect(r.result.generated.signupMode).toBe('enrolment')
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'programme.enrolment')).all()
    expect(rows).toHaveLength(1)
    // '' (the picker's "Default for this kind") clears the mode back to the kind's default.
    const back = await updateProgramme(db, admin, id, { baseUpdatedAt: r.result.programme.updatedAt, signupMode: '' }, later(2))
    expect(back.result.programme.signupMode).toBeNull()
    expect(back.result.generated.signupMode).toBe('interest')
  })

  it('goes live, retires and comes back, purging what it shows on', async () => {
    const { result } = await newLeague({ categoryId: 'cat_mixed_leagues' })
    const id = result.programme.id
    const live = await setProgrammeStatus(db, admin, id, { status: 'active' }, later(1))
    expect(live.result.programme).toMatchObject({ status: 'active', active: true, retiredAt: null })
    expect(live.purge.tags).toEqual(
      expect.arrayContaining([tags.site, tags.programme('tnl'), tags.league('tnl'), tags.category('mixed-leagues'), tags.programmes]),
    )
    const retired = await setProgrammeStatus(db, admin, id, { status: 'retired' }, later(2))
    expect(retired.result.programme).toMatchObject({ status: 'retired', active: false, retiredAt: later(2).toISOString() })
    await rejects(setProgrammeStatus(db, admin, id, { status: 'draft' }, later(3)), 400, /Reactivate/)
    const back = await setProgrammeStatus(db, admin, id, { status: 'active' }, later(4))
    expect(back.result.programme).toMatchObject({ status: 'active', retiredAt: null })
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'programme.status')).all()).length).toBe(3)
  })

  it('needs a category to go live (imported leagues may have none)', async () => {
    await db.insert(programmes).values({ id: 'old', code: 'MNL', name: 'Monday', slug: 'mnl', weekday: 1, status: 'draft', active: false })
    await rejects(setProgrammeStatus(db, admin, 'old', { status: 'active' }, NOW), 400, /category/)
    expect((await getProgramme(db, 'old', NOW)).category).toBeNull()
  })

  it('a content-only change on a live programme purges its pages and the pages whose blocks use it, not SITE', async () => {
    const { result } = await newLeague({ status: 'active' })
    await db.insert(pages).values([
      { id: 'p1', path: '/enrol-info', title: 'Info', body: { blocks: [], html: '' } },
      { id: 'p2', path: '/tnl-ladder', title: 'Ladder', body: { blocks: [], html: '' } },
      { id: 'p3', path: '/other', title: 'Other', body: { blocks: [], html: '' } },
    ])
    await db.insert(pageDataRefs).values([
      { pageId: 'p1', kind: 'programme_list', refId: '' },
      { pageId: 'p2', kind: 'ladder', refId: result.programme.id },
      { pageId: 'p3', kind: 'ladder', refId: 'someone-else' },
    ])
    const r = await updateProgramme(
      db,
      admin,
      result.programme.id,
      { baseUpdatedAt: result.programme.updatedAt, endTime: '22:30' },
      later(1),
    )
    expect(r.purge.tags).not.toContain(tags.site)
    expect(r.purge.tags).toEqual(expect.arrayContaining([tags.page('/enrol-info'), tags.page('/tnl-ladder'), tags.programme('tnl')]))
    expect(r.purge.tags).not.toContain(tags.page('/other'))
    expect(r.result.history.pages.map((p) => p.path)).toEqual(['/tnl-ladder'])
    expect(r.result.canDelete).toBe(false)
  })

  it('moving a public league leaves 301s for its page and its season pages', async () => {
    const { result } = await newLeague({ status: 'active' })
    const id = result.programme.id
    await db.insert(seasons).values([
      { id: 's1', leagueId: id, name: 'TNL Q3 2026', slug: 'tnl-q3-2026', year: 2026, quarter: 3, startDate: '2026-07-02', settings },
      { id: 's2', leagueId: id, name: 'TNL Q4 2026', slug: 'tnl-q4-2026', year: 2026, quarter: 4, startDate: '2026-10-01', settings },
    ])
    // An old WordPress redirect that led to the league page gets repointed (no chains).
    await db.insert(redirects).values([
      { fromPath: '/tnl-ladder', toPath: '/leagues/tnl', source: 'wp-import' },
      // …including ones that open a tab, and not a league whose slug merely starts the same.
      { fromPath: '/results', toPath: '/leagues/tnl#fixtures', source: 'wp-import' },
      { fromPath: '/tnl2', toPath: '/leagues/tnl2', source: 'wp-import' },
    ])
    stats.reset()
    const r = await updateProgramme(db, admin, id, { baseUpdatedAt: result.programme.updatedAt, slug: 'thursday' }, later(1))
    expect(stats.queries).toBeLessThan(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(r.result.path).toBe('/leagues/thursday')
    const rows = await db.select({ from: redirects.fromPath, to: redirects.toPath }).from(redirects).orderBy(redirects.fromPath).all()
    expect(rows).toEqual([
      { from: '/leagues/tnl', to: '/leagues/thursday' },
      { from: '/leagues/tnl/tnl-q3-2026', to: '/leagues/thursday/tnl-q3-2026' },
      { from: '/leagues/tnl/tnl-q4-2026', to: '/leagues/thursday/tnl-q4-2026' },
      { from: '/results', to: '/leagues/thursday#fixtures' },
      { from: '/tnl-ladder', to: '/leagues/thursday' },
      { from: '/tnl2', to: '/leagues/tnl2' },
    ])
    // The fixture list's ?league= follows the old slug through that 301.
    expect(await renamedLeagueSlug(db, 'tnl')).toBe('thursday')
    expect(await renamedLeagueSlug(db, 'thursday')).toBeNull()
    expect(await renamedLeagueSlug(db, '../x')).toBeNull()
    // Moving back drops the redirects from the restored URL and repoints the rest.
    await updateProgramme(db, admin, id, { baseUpdatedAt: r.result.programme.updatedAt, slug: 'tnl' }, later(2))
    const back = await db.select({ from: redirects.fromPath, to: redirects.toPath }).from(redirects).orderBy(redirects.fromPath).all()
    expect(back.find((x) => x.from === '/leagues/tnl')).toBeUndefined()
    expect(back.find((x) => x.from === '/tnl-ladder')?.to).toBe('/leagues/tnl')
    expect(back.find((x) => x.from === '/leagues/thursday/tnl-q4-2026')?.to).toBe('/leagues/tnl/tnl-q4-2026')
  })

  it('a draft can move freely: no redirects', async () => {
    const { result } = await newLeague()
    await updateProgramme(db, admin, result.programme.id, { baseUpdatedAt: result.programme.updatedAt, slug: 'thursday' }, later(1))
    expect(await db.select().from(redirects).all()).toEqual([])
  })

  it('deletes only without history; otherwise retire', async () => {
    const { result } = await newLeague({ status: 'active' })
    const id = result.programme.id
    await db.insert(menuItems).values({ id: 'm1', label: 'TNL', kind: 'programme', leagueId: id, sort: 0 })
    await rejects(deleteProgramme(db, admin, id, later(1)), 409, /menu/)
    await db.delete(menuItems)
    await db.insert(seasons).values({
      id: 's1',
      leagueId: id,
      name: 'TNL Q4 2026',
      slug: 'tnl-q4-2026',
      year: 2026,
      quarter: 4,
      startDate: '2026-10-01',
      settings,
    })
    await rejects(deleteProgramme(db, admin, id, later(1)), 409, /Retire/)
    await rejects(setProgrammeStatus(db, admin, id, { status: 'draft' }, later(1)), 409)
    await db.delete(seasons)
    const d = await deleteProgramme(db, admin, id, later(2))
    expect(d.purge.tags).toContain(tags.site)
    expect(await db.select().from(programmes).where(eq(programmes.id, id)).all()).toEqual([])
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'programme.delete')).all()).toHaveLength(1)
  })

  it('lists by kind with counts and next start dates, in one batch', async () => {
    const { result } = await newLeague({ status: 'active', enrolmentOpen: true })
    await db.insert(seasons).values({
      id: 's1',
      leagueId: result.programme.id,
      name: 'TNL Q1 2027',
      slug: 'tnl-q1-2027',
      year: 2027,
      quarter: 1,
      startDate: '2027-01-14',
      settings,
    })
    await createProgramme(db, admin, { kind: 'training', name: 'Scrim', code: 'SCT', categoryId: 'cat_adult_training', weekday: 2 }, NOW)
    stats.reset()
    const list = await listProgrammes(db, { kind: 'league' }, NOW)
    expect(stats.queries).toBeLessThanOrEqual(12)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ code: 'TNL', instances: 1, enrolmentOpenNow: true, category: { slug: 'mixed-leagues' } })
    expect(list[0]!.generated.nextStarts).toBe('Next season starts Thursday 14 January 2027')
    expect((await listProgrammes(db, {}, NOW)).map((p) => p.kind).toSorted()).toEqual(['league', 'training'])
    expect((await nextInstanceDates(db, '2026-10-18')).get(result.programme.id)).toBe('2027-01-14')
  })
})

describe('categories', () => {
  it('lists the seeded four with counts', async () => {
    await newLeague({ status: 'active' })
    const list = await listCategories(db)
    expect(list.map((c) => c.slug)).toEqual(['mixed-leagues', 'super-league', 'juniors', 'adult-training'])
    expect(list[0]!.programmes).toEqual({ draft: 0, active: 1, retired: 0 })
    expect(list[0]!.path).toBe('/mixed-leagues')
  })

  it('creates with a slug that is a free page path', async () => {
    const { result } = await createCategory(db, admin, { name: 'Beach Volleyball' }, NOW)
    expect(result).toMatchObject({ slug: 'beach-volleyball', status: 'draft', sort: 5 })
    await rejects(createCategory(db, admin, { name: 'Again', slug: 'beach-volleyball' }, NOW), 409)
    await rejects(createCategory(db, admin, { name: 'Admin', slug: 'admin' }, NOW), 400)
    await rejects(createCategory(db, admin, { name: 'Events', slug: 'events' }, NOW), 400)
    // /training and /enrol are routes whose intro page may live at that path, but a category can't take them.
    await rejects(createCategory(db, admin, { name: 'Training', slug: 'training' }, NOW), 400)
    await rejects(createCategory(db, admin, { name: 'Enrol', slug: 'enrol' }, NOW), 400)
    await db.insert(pages).values({ path: '/socials', title: 'Socials', body: { blocks: [], html: '' } })
    await rejects(createCategory(db, admin, { name: 'Socials' }, NOW), 409, /Socials/)
  })

  it('refuses to retire with active programmes, and to delete while not empty', async () => {
    await newLeague({ status: 'active' })
    await rejects(updateCategory(db, admin, 'cat_mixed_leagues', { status: 'retired' }, NOW), 409, /Thursday Night League/)
    await rejects(deleteCategory(db, admin, 'cat_mixed_leagues', NOW), 409, /Move them/)
    await db.insert(menuItems).values({ id: 'm', label: 'Juniors', kind: 'category', categoryId: 'cat_juniors', sort: 0 })
    await rejects(deleteCategory(db, admin, 'cat_juniors', NOW), 409, /menu/)
    const d = await deleteCategory(db, admin, 'cat_super_league', NOW)
    expect(d.purge.tags).toContain(tags.site)
  })

  it('moving a live category leaves a 301; intro edits purge only its page', async () => {
    const r = await updateCategory(db, admin, 'cat_juniors', { slug: 'kids' }, NOW)
    expect(r.result.path).toBe('/kids')
    expect(await db.select({ f: redirects.fromPath, t: redirects.toPath }).from(redirects).all()).toEqual([{ f: '/juniors', t: '/kids' }])
    const i = await updateCategory(
      db,
      admin,
      'cat_juniors',
      { intro: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] },
      later(1),
    )
    expect(i.result.intro.html).toBe('<p>Hi</p>')
    expect(i.purge.tags).toEqual([tags.category('kids'), tags.programmes])
  })

  it('reorders', async () => {
    const r = await reorderCategories(
      db,
      admin,
      { ids: ['cat_juniors', 'cat_adult_training', 'cat_mixed_leagues', 'cat_super_league'] },
      NOW,
    )
    expect(r.result.map((c) => c.id)).toEqual(['cat_juniors', 'cat_adult_training', 'cat_mixed_leagues', 'cat_super_league'])
    await rejects(reorderCategories(db, admin, { ids: ['cat_juniors'] }, NOW), 409)
  })
})

describe('venues and courts', () => {
  it('creates venues and courts, with names unique per venue', async () => {
    const { result } = await createVenue(
      db,
      admin,
      { name: 'MLC School', address: 'Rowley St, Burwood', mapUrl: 'https://maps.example/mlc' },
      NOW,
    )
    expect(result).toMatchObject({ slug: 'mlc-school', courts: [] })
    await rejects(createVenue(db, admin, { name: 'MLC School' }, NOW), 409)
    await rejects(createVenue(db, admin, { name: 'Bad', mapUrl: 'javascript:x' }, NOW), 400)
    const withCourt = await createCourt(db, admin, result.id, { name: 'MLC' }, NOW)
    expect(withCourt.result.courts.map((c) => c.name)).toEqual(['MLC'])
    await rejects(createCourt(db, admin, 'tempe', { name: 'court 1' }, NOW), 409)
    const renamed = await updateCourt(db, admin, 'c2', { name: 'Court 2 (back)' }, NOW)
    expect(renamed.result.courts.map((c) => c.name)).toEqual(['Court 1', 'Court 2 (back)'])
    const ordered = await reorderCourts(db, admin, 'tempe', { ids: ['c2', 'c1'] }, NOW)
    expect(ordered.result.courts.map((c) => c.id)).toEqual(['c2', 'c1'])
    expect(ordered.purge.tags).toContain(tags.venues)
  })

  it('deletes only unused courts and venues', async () => {
    await rejects(deleteVenue(db, admin, 'tempe', NOW), 409, /2 courts/)
    await db.insert(seasons).values({
      id: 's1',
      leagueId: (await newLeague()).result.programme.id,
      name: 'TNL Q4 2026',
      slug: 'tnl-q4-2026',
      year: 2026,
      quarter: 4,
      startDate: '2026-10-01',
      settings: { ...settings, defaultCourtIds: ['c1'] },
    })
    await rejects(deleteCourt(db, admin, 'c1', NOW), 409, /TNL Q4 2026 draw/)
    await db.insert(matchDays).values({ id: 'd1', seasonId: 's1', date: '2026-10-01', number: 1 })
    await db.insert(matches).values({ id: 'g1', seasonId: 's1', matchDayId: 'd1', session: 0, position: 0, courtId: 'c2' })
    await rejects(deleteCourt(db, admin, 'c2', NOW), 409, /1 match/)
    await db.delete(matches)
    const ok = await deleteCourt(db, admin, 'c2', NOW)
    expect(ok.result.courts.map((c) => c.id)).toEqual(['c1'])
    const { result } = await createVenue(db, admin, { name: 'Spare hall' }, NOW)
    await deleteVenue(db, admin, result.id, NOW)
    expect((await listVenues(db)).map((v) => v.id)).toEqual(['tempe'])
  })
})

describe('sessions, terms and events', () => {
  const training = () =>
    createProgramme(
      db,
      admin,
      {
        kind: 'training',
        name: 'Scrim & Coached Training',
        code: 'SCT',
        categoryId: 'cat_adult_training',
        weekday: 2,
        startTime: '19:00',
        endTime: '21:00',
        capPlayers: 40,
        priceCents: 2000,
      },
      NOW,
    ).then((r) => r.result.programme)

  it('adds weekly sessions with a product each, skipping existing dates', async () => {
    const p = await training()
    stats.reset()
    const r = await addSessions(db, admin, p.id, { from: '2026-10-20', to: '2026-12-15', venueId: 'tempe', capacity: 32 }, NOW)
    expect(stats.queries).toBeLessThan(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(r.result.added.map((s) => s.date)).toHaveLength(9)
    expect(r.result.added[0]).toMatchObject({
      date: '2026-10-20',
      startTime: '19:00',
      endTime: '21:00',
      venueId: 'tempe',
      status: 'scheduled',
    })
    expect(r.result.added[0]!.product).toMatchObject({ capacity: 32, priceCents: 2000, enrolled: 0 })
    const prods = await db.select().from(products).where(eq(products.programmeId, p.id)).all()
    expect(prods).toHaveLength(9)
    expect(prods[0]).toMatchObject({ kind: 'training_session', active: true })
    const again = await addSessions(db, admin, p.id, { from: '2026-12-01', to: '2026-12-22' }, NOW)
    expect(again.result.skipped).toEqual(['2026-12-01', '2026-12-08', '2026-12-15'])
    expect(again.result.added.map((s) => s.date)).toEqual(['2026-12-22'])
    await rejects(addSessions(db, admin, p.id, { from: '2026-01-01', to: '2028-01-01' }, NOW), 400, /more than 60/)
  })

  it('a full 60-week run stays within the query and parameter limits', async () => {
    const p = await training()
    stats.reset()
    const r = await addSessions(db, admin, p.id, { from: '2027-01-05', to: '2028-02-22', skip: ['2027-01-26'] }, NOW)
    expect(r.result.added).toHaveLength(59)
    expect(stats.queries).toBeLessThan(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(await db.select().from(products).where(eq(products.programmeId, p.id)).all()).toHaveLength(59)
  })

  it('keeps the first date when a session moves, and refuses deleting one with enrolments', async () => {
    const p = await training()
    const { result } = await addSessions(db, admin, p.id, { date: '2026-10-20' }, NOW)
    const s = result.added[0]!
    const moved = await updateSession(
      db,
      admin,
      s.id,
      { date: '2026-10-21', status: 'postponed', note: 'Hall flooded', capacity: 20 },
      later(1),
    )
    expect(moved.result).toMatchObject({ date: '2026-10-21', originalDate: '2026-10-20', status: 'postponed' })
    expect(moved.result.product?.capacity).toBe(20)
    const back = await updateSession(db, admin, s.id, { date: '2026-10-20', status: 'scheduled' }, later(2))
    expect(back.result.originalDate).toBeNull()
    await db.insert(players).values({ id: 'pl', firstName: 'A', lastName: 'B', email: 'a@example.com' })
    await db.insert(registrations).values({ productId: s.product!.id, playerId: 'pl', reference: 'TVB-1', status: 'confirmed' })
    expect((await listSessions(db, p.id))[0]!.product?.enrolled).toBe(1)
    await rejects(deleteSession(db, admin, s.id, later(3)), 409, /Cancel it/)
    await db.delete(registrations)
    await deleteSession(db, admin, s.id, later(3))
    expect(await db.select().from(products).where(eq(products.programmeId, p.id)).all()).toEqual([])
  })

  it('creates a term with its weekly sessions (enrolled through the term)', async () => {
    const p = (
      await createProgramme(
        db,
        admin,
        {
          kind: 'development',
          name: 'Junior Development Program',
          code: 'JDP',
          categoryId: 'cat_juniors',
          weekday: 6,
          startTime: '09:00',
          endTime: '10:30',
        },
        NOW,
      )
    ).result.programme
    await rejects(addSessions(db, admin, p.id, { date: '2026-10-24' }, NOW), 400, /term/)
    const { result } = await createTerm(
      db,
      admin,
      p.id,
      { name: 'Term 4 2026', startDate: '2026-10-17', endDate: '2026-12-12', ageGroup: 'Ages 8–12', addSessions: true, capacity: 24 },
      NOW,
    )
    expect(result).toMatchObject({ slug: 'term-4-2026', sessions: 9, path: '/programs/junior-development-program/term-4-2026' })
    expect(result.product).toMatchObject({ capacity: 24 })
    const sessions = await db.select().from(programmeSessions).where(eq(programmeSessions.termId, result.id)).all()
    expect(sessions).toHaveLength(9)
    expect(await db.select().from(products).where(eq(products.programmeId, p.id)).all()).toHaveLength(1)
    await rejects(createTerm(db, admin, p.id, { name: 'Term 4 2026', startDate: '2027-01-01' }, NOW), 409)
    expect((await listTerms(db, p.id)).map((t) => t.name)).toEqual(['Term 4 2026'])
    expect((await getProgramme(db, p.id, NOW)).history.terms).toBe(1)
  })

  it('events keep their first date when moved', async () => {
    const p = (
      await createProgramme(db, admin, { kind: 'event', name: 'Tempe Cup', code: 'CUP', categoryId: 'cat_mixed_leagues', weekday: 6 }, NOW)
    ).result.programme
    const { result } = await createEvent(db, admin, p.id, { startDate: '2026-11-28', endDate: '2026-11-29', capacityTeams: 16 }, NOW)
    expect(result).toMatchObject({ name: 'Tempe Cup 2026', slug: 'tempe-cup-2026', path: '/events/tempe-cup/tempe-cup-2026' })
    expect(result.product).toMatchObject({ capacityTeams: 16 })
    const moved = await updateEvent(db, admin, result.id, { startDate: '2026-12-05', endDate: '2026-12-05' }, later(1))
    expect(moved.result).toMatchObject({ startDate: '2026-12-05', endDate: null, originalStartDate: '2026-11-28' })
    const prod = await db
      .select()
      .from(products)
      .where(and(eq(products.eventId, result.id)))
      .get()
    expect(prod).toMatchObject({ startsOn: '2026-12-05', kind: 'event_entry' })
    expect(await db.select().from(events).all()).toHaveLength(1)
    expect(await db.select().from(developmentTerms).all()).toHaveLength(0)
    expect(await db.select().from(categories).all()).toHaveLength(4)
  })
})
