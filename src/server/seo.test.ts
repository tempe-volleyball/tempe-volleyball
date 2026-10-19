import { beforeEach, describe, expect, it } from 'vitest'
import { sitemapEntries } from '../lib/seo/sitemap'
import { tags } from './cache'
import { createPage, setPageStatus, updatePage } from './content/pages'
import { createPost, setPostStatus, updatePost } from './content/posts'
import { createTestDb, type QueryStats, type TestDb } from './db/testing'
import { developmentTerms, matchDays, programmes, seasons, user, venues } from './db/schema'
import { searchSite } from './search'
import { loadSite } from './site'
import { loadSitemapRows } from './sitemap'
import { seasonJsonLd, seasonVenue } from './seo'

// SEO against the migrated in-memory DB: the sitemap's batch, site search, the pages/posts SEO fields, and the
// season JSON-LD built from loadSite() (docs/public-site.md "SEO").

const NOW = new Date('2026-10-18T00:00:00.000Z')
let db: TestDb
let stats: QueryStats
const editor = { id: 'ed', ip: '203.0.113.9' }
const doc = (text: string) => [{ type: 'paragraph', content: [{ type: 'text', text }] }]
const settings = { sessions: ['20:00'], sessionMinutes: 60, meetings: 1, includeFinals: false, seed: 0, skipDates: [], defaultCourtIds: [] }

beforeEach(async () => {
  ;({ db, stats } = createTestDb())
  await db.insert(user).values({ id: 'ed', name: 'ed', email: 'ed@example.com', emailVerified: true, role: 'editor' })
  await db.insert(venues).values({ id: 'v1', name: 'Robyn Webster Sports Centre', slug: 'rwsc', address: 'Holbeach Ave, Tempe NSW 2044' })
  const base = { weekday: 4, defaultVenueId: 'v1', sort: 0, updatedAt: '2026-10-01T00:00:00.000Z' }
  await db.insert(programmes).values([
    { ...base, id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', categoryId: 'cat_mixed_leagues', priceCents: 12000 },
    { ...base, id: 'mnl', code: 'MNL', name: 'Monday Night League', slug: 'mnl', status: 'retired', active: false },
    { ...base, id: 'bl', code: 'BL', name: 'B League', slug: 'b-league', status: 'retired', active: false },
    { ...base, id: 'dr', code: 'DR', name: 'Draft League', slug: 'draft-league', status: 'draft', active: false },
    { ...base, id: 'jdp', code: 'JDP', name: 'Junior Development Program', slug: 'jdp', kind: 'development', categoryId: 'cat_juniors' },
  ])
  await db.insert(seasons).values([
    {
      id: 's4',
      leagueId: 'tnl',
      name: 'TNL Q4 2026',
      slug: 'tnl-q4-2026',
      year: 2026,
      quarter: 4,
      startDate: '2026-10-15',
      status: 'published',
      settings,
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: 's3',
      leagueId: 'tnl',
      name: 'TNL Q3 2026',
      slug: 'tnl-q3-2026',
      year: 2026,
      quarter: 3,
      startDate: '2026-07-16',
      status: 'archived',
      settings,
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: 'm1',
      leagueId: 'mnl',
      name: 'MNL Q1 2021',
      slug: 'mnl-q1-2021',
      year: 2021,
      quarter: 1,
      startDate: '2021-02-01',
      status: 'archived',
      settings,
    },
  ])
  await db.insert(matchDays).values([
    { id: 'd1', seasonId: 's4', date: '2026-10-15', kind: 'regular', number: 1, resultsPublishedAt: '2026-10-16T01:00:00.000Z' },
    { id: 'd2', seasonId: 's4', date: '2026-10-22', kind: 'regular', number: 2 },
    { id: 'd0', seasonId: 's4', date: '2026-10-29', kind: 'skip', number: 0 },
    { id: 'd3', seasonId: 's3', date: '2026-07-16', kind: 'regular', number: 1, resultsPublishedAt: '2026-07-17T01:00:00.000Z' },
  ])
  await db
    .insert(developmentTerms)
    .values({ id: 't1', programmeId: 'jdp', name: 'Term 4 2026', slug: 'term-4-2026', startDate: '2026-10-20' })
})

describe('loadSitemapRows', () => {
  it('reads everything in one batch and lists what the public site serves', async () => {
    const home = await createPage(db, editor, { title: 'Home', path: '/', template: 'home', blocks: doc('Hi') }, NOW)
    await setPageStatus(db, editor, home.id, 'published', NOW)
    const contact = await createPage(db, editor, { title: 'Contact', path: '/contact', blocks: doc('Call Michael') }, NOW)
    await setPageStatus(db, editor, contact.id, 'published', NOW)
    const hidden = await createPage(db, editor, { title: 'Thanks', path: '/thanks', noindex: true, blocks: doc('Thanks!') }, NOW)
    await setPageStatus(db, editor, hidden.id, 'published', NOW)
    await createPage(db, editor, { title: 'Draft', path: '/draft' }, NOW)
    const post = await createPost(db, editor, { title: 'Grand final', slug: 'grand-final', blocks: doc('Winners') }, NOW)
    await setPostStatus(db, editor, post.id, 'published', NOW)

    stats.reset()
    const rows = await loadSitemapRows(db)
    expect(stats.batches).toBe(1)
    expect(stats.queries).toBe(6)
    const paths = sitemapEntries(rows).map((e) => e.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        '/',
        '/contact',
        '/leagues/tnl',
        '/leagues/mnl',
        '/programs/jdp',
        '/leagues/tnl/tnl-q3-2026',
        '/news/grand-final',
      ]),
    )
    // Hidden and draft pages, retired leagues without history, drafts, and the current season (its canonical is the league page).
    for (const p of [
      '/thanks',
      '/draft',
      '/leagues/b-league',
      '/leagues/draft-league',
      '/leagues/tnl/tnl-q4-2026',
      '/leagues/mnl/mnl-q1-2021',
    ])
      expect(paths).not.toContain(p)
    // The categories seeded by migration 0003 have landing pages.
    expect(paths).toContain('/mixed-leagues')
    expect(sitemapEntries(rows).find((e) => e.path === '/leagues/tnl')?.lastmod).toBe('2026-10-16T01:00:00.000Z')
  })
})

describe('SEO fields on pages and posts', () => {
  it('saves a search title and noindex on pages; a noindex change also purges the sitemap (SITE)', async () => {
    const page = await createPage(db, editor, { title: 'Rules', path: '/rules', seoTitle: '  Court rules  ' }, NOW)
    expect(page).toMatchObject({ seoTitle: 'Court rules', noindex: false })
    await setPageStatus(db, editor, page.id, 'published', NOW)
    const same = await updatePage(db, editor, page.id, { seoTitle: '' }, NOW)
    expect(same.result.seoTitle).toBeNull()
    expect(same.purge.tags).toEqual([tags.page('/rules')])
    const hide = await updatePage(db, editor, page.id, { noindex: true }, NOW)
    expect(hide.result.noindex).toBe(true)
    expect(hide.purge.tags).toEqual([tags.page('/rules'), tags.site])
  })

  it('saves a search title, description and noindex on posts', async () => {
    const post = await createPost(db, editor, { title: 'News', slug: 'news-1', seoDescription: 'All about it.', noindex: true }, NOW)
    expect(post).toMatchObject({ seoTitle: null, seoDescription: 'All about it.', noindex: true })
    const r = await updatePost(db, editor, post.id, { seoTitle: 'Big news', noindex: false }, NOW)
    expect(r.result).toMatchObject({ seoTitle: 'Big news', seoDescription: 'All about it.', noindex: false })
  })
})

describe('searchSite', () => {
  it('finds published pages, programmes and posts containing every word, titles first, in one batch', async () => {
    const rules = await createPage(db, editor, { title: 'RULES', path: '/rules', blocks: doc('Thursday games start at 8pm sharp.') }, NOW)
    await setPageStatus(db, editor, rules.id, 'published', NOW)
    const hidden = await createPage(db, editor, { title: 'Thursday secrets', path: '/s', noindex: true, blocks: doc('Thursday 8pm') }, NOW)
    await setPageStatus(db, editor, hidden.id, 'published', NOW)
    await createPage(db, editor, { title: 'Thursday draft', path: '/d', blocks: doc('Thursday') }, NOW)
    const post = await createPost(db, editor, { title: 'Thursday grand final', slug: 'gf', blocks: doc('A great night') }, NOW)
    await setPostStatus(db, editor, post.id, 'published', NOW)

    stats.reset()
    const r = await searchSite(db, 'thursday')
    expect(stats.batches).toBe(1)
    expect(r.hits.map((h) => h.path)).toEqual(['/leagues/tnl', '/news/gf', '/rules'])
    expect(r.hits.find((h) => h.path === '/rules')).toMatchObject({ title: 'Rules', text: 'Thursday games start at 8pm sharp.' })
    expect((await searchSite(db, 'thursday 8pm')).hits.map((h) => h.path)).toEqual(['/rules'])
    expect((await searchSite(db, '100%')).hits).toEqual([])
    stats.reset()
    expect(await searchSite(db, ' a ')).toEqual({ terms: [], hits: [] })
    expect(stats.queries).toBe(0)
  })
})

describe('seasonJsonLd', () => {
  it('builds the current season’s SportsEvent from loadSite(), skipping weeks off', async () => {
    const site = await loadSite(db)
    const view = site.current.find((c) => c.summary.id === 's4')!
    expect(seasonVenue(view, site)?.id).toBe('v1')
    const e = seasonJsonLd(view, site, {
      origin: 'https://www.tempevb.com',
      url: 'https://www.tempevb.com/leagues/tnl',
      description: 'Ladder and fixtures.',
      enrolment: { open: true, url: 'https://www.tempevb.com/leagues/tnl#enrol' },
    })
    expect(e).toMatchObject({
      '@type': 'SportsEvent',
      name: 'Thursday Night League TNL Q4 2026',
      startDate: '2026-10-15T20:00:00+11:00',
      endDate: '2026-10-22',
      location: { name: 'Robyn Webster Sports Centre', address: { addressLocality: 'Tempe' } },
      offers: { price: '120.00', priceCurrency: 'AUD', availability: 'https://schema.org/InStock' },
      image: ['https://www.tempevb.com/images/og-default.jpg'],
    })
  })
})
