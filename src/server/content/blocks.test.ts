import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type QueryStats, type TestDb } from '../db/testing'
import {
  courts,
  leagues,
  matchDays,
  matches,
  matchResults,
  pageDataRefs,
  programmeSessions,
  seasons,
  seasonTeams,
  teams,
  user,
  venues,
} from '../db/schema'
import { blockPageTags } from '../programmes/common'
import { programmePurge } from '../programmes/programmes'
import { loadSite, lookupPath } from '../site'
import { blockChoices, blockTags, previewBlock, renderBody } from './blocks'
import { createPage, getPage, updatePage } from './pages'

const NOW = new Date('2026-10-14T00:00:00.000Z')

let db: TestDb
let stats: QueryStats
const editor = { id: 'ed', ip: null }

beforeEach(async () => {
  ;({ db, stats } = createTestDb())
  await db.insert(user).values({ id: 'ed', name: 'ed', email: 'ed@example.com', emailVerified: true, role: 'editor' })
  await db.insert(venues).values({ id: 'v1', name: 'Robyn Webster Sports Centre', slug: 'rwsc', address: 'Holbeach Ave, Tempe NSW 2044' })
  await db.insert(courts).values({ id: 'c1', venueId: 'v1', name: 'Court 1' })
  await db.insert(leagues).values([
    {
      id: 'tnl',
      code: 'TNL',
      name: 'Thursday Night League',
      slug: 'tnl',
      weekday: 4,
      defaultVenueId: 'v1',
      startTime: '20:00',
      endTime: '22:00',
      categoryId: 'cat_mixed_leagues',
    },
    {
      id: 'fnl',
      code: 'FNL',
      name: 'Friday Night League',
      slug: 'fnl',
      weekday: 5,
      defaultVenueId: 'v1',
      sort: 1,
      categoryId: 'cat_mixed_leagues',
      summaryLine: 'Fridays at Tempe',
    },
    {
      id: 'old',
      code: 'MNL',
      name: 'Monday Night League',
      slug: 'mnl',
      weekday: 1,
      status: 'retired',
      active: false,
      categoryId: 'cat_mixed_leagues',
    },
    {
      id: 'scrim',
      code: 'SCT',
      name: 'Scrim Training',
      slug: 'scrim',
      weekday: 3,
      kind: 'training',
      categoryId: 'cat_adult_training',
      enrolmentOpen: true,
    },
  ])
  await db.insert(programmeSessions).values({ id: 'ps1', programmeId: 'scrim', date: '2026-10-21', startTime: '19:00', endTime: '21:00' })
  await db.insert(teams).values([
    { id: 'a', name: 'ACES', slug: 'aces' },
    { id: 'b', name: 'BLOCKERS', slug: 'blockers' },
  ])
  await db.insert(seasons).values({
    id: 's4',
    leagueId: 'tnl',
    name: 'TNL Q4 2026',
    slug: 'tnl-q4-2026',
    year: 2026,
    quarter: 4,
    startDate: '2026-10-08',
    status: 'published',
    settings: {
      sessions: ['20:00'],
      sessionMinutes: 60,
      meetings: 1,
      includeFinals: false,
      seed: 0,
      skipDates: [],
      defaultCourtIds: ['c1'],
    },
  })
  await db.insert(seasonTeams).values([
    { seasonId: 's4', teamId: 'a', sort: 0 },
    { seasonId: 's4', teamId: 'b', sort: 1 },
  ])
  await db.insert(matchDays).values([
    { id: 'd1', seasonId: 's4', date: '2026-10-08', kind: 'regular', number: 1, resultsPublishedAt: '2026-10-09T01:00:00.000Z' },
    { id: 'd2', seasonId: 's4', date: '2026-10-15', kind: 'regular', number: 2 },
  ])
  await db.insert(matches).values([
    {
      id: 'm1',
      seasonId: 's4',
      matchDayId: 'd1',
      session: 0,
      position: 0,
      startTime: '20:00',
      courtId: 'c1',
      homeTeamId: 'a',
      awayTeamId: 'b',
      status: 'played',
    },
    {
      id: 'm2',
      seasonId: 's4',
      matchDayId: 'd2',
      session: 0,
      position: 0,
      startTime: '20:00',
      courtId: 'c1',
      homeTeamId: 'b',
      awayTeamId: 'a',
    },
  ])
  await db.insert(matchResults).values({
    matchId: 'm1',
    kind: 'published',
    homeSets: 2,
    awaySets: 0,
    homePoints: 50,
    awayPoints: 30,
    setScores: [
      [25, 15],
      [25, 15],
    ],
  })
})

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

const blocks = [
  para('Our leagues:'),
  { type: 'programmeList', attrs: { filter: { categoryIds: ['cat_mixed_leagues'] } } },
  { type: 'ladder', attrs: { leagueId: 'tnl', rows: 1 } },
  { type: 'fixtures', attrs: { leagueId: 'tnl', range: 'this_week' } },
  para('See you there.'),
]

const refs = (pageId: string) =>
  db
    .select({ kind: pageDataRefs.kind, refId: pageDataRefs.refId })
    .from(pageDataRefs)
    .where(eq(pageDataRefs.pageId, pageId))
    .orderBy(pageDataRefs.kind)
    .all()

describe('data blocks on pages', () => {
  it('stores normalised blocks, leaves them out of the stored HTML and records page_data_refs on every save', async () => {
    const page = await createPage(db, editor, { title: 'Leagues', path: '/our-leagues', blocks })
    expect(page.body.html).toBe('<p>Our leagues:</p><p>See you there.</p>')
    expect((page.body.blocks[1] as { attrs: { template: unknown } }).attrs.template).toBeNull()
    expect(await refs(page.id)).toEqual([
      { kind: 'fixtures', refId: 'tnl' },
      { kind: 'ladder', refId: 'tnl' },
      { kind: 'programme_list', refId: '' },
    ])
    const { page: loaded } = await getPage(db, page.id)
    await updatePage(db, editor, page.id, { blocks: [para('No blocks now')], baseUpdatedAt: loaded.updatedAt })
    expect(await refs(page.id)).toEqual([])
  })

  it('renders the blocks from live data at view time within the query and parameter limits', async () => {
    const page = await createPage(db, editor, { title: 'Leagues', path: '/our-leagues', blocks })
    stats.reset()
    // Everything a page view runs: the layout data, the page lookup and the blocks.
    const [site, found] = await Promise.all([loadSite(db), lookupPath(db, '/our-leagues')])
    const body = await renderBody(db, site, { ...page.body, ...found.page?.body }, NOW)
    expect(stats.queries).toBeLessThanOrEqual(30)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    const html = body.html
    // Programme list: active Mixed Leagues programmes only (FNL's own summary line wins), each linked.
    expect(html).toContain(
      '<li><a href="/leagues/tnl">Next Thursday Night League (TNL) @ Robyn Webster Sports Centre, Tempe (Thursdays 8–10pm)</a></li>',
    )
    expect(html).toContain('<li><a href="/leagues/fnl">Fridays at Tempe</a></li>')
    expect(html).not.toContain('Monday')
    expect(html).not.toContain('Scrim')
    // Ladder: one row; fixtures: this week's (15 Oct) game only.
    expect(html).toContain('<h2>Thursday Night League Ladder</h2>')
    expect(html.match(/<th scope="row" class="team">/g)).toHaveLength(1)
    expect(html).toContain('15/10/2026')
    expect(html).not.toContain('08/10/2026')
    expect(html.startsWith('<p>Our leagues:</p>')).toBe(true)
    expect(body.tags.toSorted()).toEqual(['league:tnl', 'programmes', 'venues'])
  })

  it('serves pages without data blocks from the stored HTML with no extra queries', async () => {
    const page = await createPage(db, editor, { title: 'Plain', path: '/plain', blocks: [para('Hello')] })
    const site = await loadSite(db)
    stats.reset()
    expect(await renderBody(db, site, page.body, NOW)).toEqual({ html: '<p>Hello</p>', tags: [] })
    expect(stats.queries).toBe(0)
  })

  it('shows a league between seasons from its latest archived season', async () => {
    await db.update(seasons).set({ status: 'archived' }).where(eq(seasons.id, 's4'))
    const site = await loadSite(db)
    expect(site.current).toEqual([])
    const body = await renderBody(db, site, { blocks: [{ type: 'ladder', attrs: { leagueId: 'tnl' } }], html: '' }, NOW)
    expect(body.html).toContain('ACES')
    expect(blockTags([{ type: 'ladder', attrs: { leagueId: 'tnl' } }], site)).toEqual(['league:tnl'])
  })

  it('lets programme changes purge the pages whose blocks use them', async () => {
    const page = await createPage(db, editor, {
      title: 'Leagues',
      path: '/our-leagues',
      blocks: [{ type: 'ladder', attrs: { leagueId: 'tnl' } }],
    })
    expect(await blockPageTags(db, ['tnl'])).toEqual([`page:${page.path}`])
    expect(await blockPageTags(db, ['fnl'])).toEqual([])
    const [tnl] = await db.select().from(leagues).where(eq(leagues.id, 'tnl')).all()
    const purge = await programmePurge(db, tnl!, { ...tnl!, startTime: '19:00' })
    expect(purge.tags).toContain('page:/our-leagues')
  })

  it('previews a block for the editor with every line, hidden ones flagged, and change detection', async () => {
    const site = await loadSite(db)
    const first = await previewBlock(db, site, { type: 'programmeList', attrs: {} }, NOW)
    const tnl = first.lines.find((l) => l.id === 'tnl')!
    const attrs = { hidden: ['fnl'], overrides: { tnl: { text: 'Thursdays!', source: tnl.current, editedAt: NOW.toISOString() } } }
    await db.update(leagues).set({ defaultVenueId: null }).where(eq(leagues.id, 'tnl'))
    const p = await previewBlock(db, await loadSite(db), { type: 'programmeList', attrs }, NOW)
    expect(p.lines.map((l) => [l.id, l.hidden, l.source])).toEqual([
      ['tnl', false, 'override'],
      ['fnl', true, 'summary'],
      ['scrim', false, 'template'],
    ])
    expect(p.lines[0]!.changed).toEqual(['venue'])
    expect(p.html).not.toContain('Fridays')
    // Scrim's next session drives its "next starts" text.
    expect(p.lines[2]!.current.nextStarts).toBe('Next session starts Wednesday 21 October 2026')
    expect((await previewBlock(db, site, { type: 'ladder', attrs: { leagueId: 'nope' } }, NOW)).note).toBe('That league no longer exists.')
    await expect(previewBlock(db, site, { type: 'paragraph' }, NOW)).rejects.toThrow('That isn’t a data block.')
  })

  it('offers leagues with their current season and teams for the pickers', async () => {
    const c = await blockChoices(db, await loadSite(db))
    expect(c.leagues.map((l) => [l.code, l.season, l.teams.map((t) => t.name)]).toSorted()).toEqual([
      ['FNL', null, []],
      ['MNL', null, []],
      ['TNL', 'TNL Q4 2026', ['ACES', 'BLOCKERS']],
    ])
    expect(c.programmes.map((p) => p.code)).toContain('SCT')
  })
})
