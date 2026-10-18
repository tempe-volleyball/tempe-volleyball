import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type QueryStats, type TestDb } from './db/testing'
import { user, leagues, matchDays, matches, matchResults, pageRevisions, pages, posts, seasons, teams } from './db/schema'
import { loadDashboard, type DashboardEnv } from './dashboard'

// The admin home page's data (docs/admin.md §4).

const NOW = new Date('2026-10-22T05:00:00.000Z') // Thursday 22 Oct, 4pm in Sydney
let db: TestDb
let stats: QueryStats

const env = (over: Partial<DashboardEnv> = {}): DashboardEnv => ({
  role: 'owner',
  resend: false,
  turnstile: 'test',
  analytics: [{ source: 'ga4', configured: false, missing: ['x'], enabled: false }],
  payid: true,
  ...over,
})

const body = { blocks: [], html: '<p>x</p>' }
const settings = { sessions: ['20:00'], sessionMinutes: 60, meetings: 1, includeFinals: false, seed: 0, skipDates: [], defaultCourtIds: [] }

beforeEach(async () => {
  const t = createTestDb()
  db = t.db
  stats = t.stats
  await db.insert(user).values({ id: 'u1', name: 'Michael', email: 'm@example.com', emailVerified: true, role: 'owner' })
  await db.insert(leagues).values([
    { id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4 },
    { id: 'adp', code: 'ADP', name: 'Adult Development', slug: 'adp', weekday: 2, kind: 'development', status: 'draft' },
  ])
  await db.insert(teams).values([
    { id: 'a', name: 'ACES', slug: 'aces' },
    { id: 'b', name: 'BLOCKERS', slug: 'blockers' },
  ])
  await db.insert(seasons).values([
    {
      id: 's',
      leagueId: 'tnl',
      name: 'TNL Q4 2026',
      slug: 'tnl-q4-2026',
      year: 2026,
      quarter: 4,
      startDate: '2026-10-01',
      status: 'published',
      settings,
    },
    {
      id: 'old',
      leagueId: 'tnl',
      name: 'TNL Q3 2026',
      slug: 'tnl-q3-2026',
      year: 2026,
      quarter: 3,
      startDate: '2026-07-01',
      status: 'archived',
      settings,
    },
  ])
  await db.insert(matchDays).values([
    // Published and unchanged since.
    { id: 'd1', seasonId: 's', date: '2026-10-01', number: 1, resultsPublishedAt: '2026-10-02T00:00:00.000Z' },
    // Played, a draft saved but not published.
    { id: 'd2', seasonId: 's', date: '2026-10-08', number: 2 },
    // Played, one game published and the other edited since.
    { id: 'd3', seasonId: 's', date: '2026-10-15', number: 3, resultsPublishedAt: '2026-10-16T00:00:00.000Z' },
    // Tonight.
    { id: 'd4', seasonId: 's', date: '2026-10-22', number: 4 },
    // Too far ahead for "this week".
    { id: 'd5', seasonId: 's', date: '2026-10-29', number: 5 },
    // A cancelled night needs nothing.
    { id: 'd6', seasonId: 's', date: '2026-09-24', number: 0, status: 'cancelled' },
    // Archived seasons are left out.
    { id: 'o1', seasonId: 'old', date: '2026-09-10', number: 1 },
  ])
  const game = (id: string, day: string, season = 's', status: 'scheduled' | 'played' | 'cancelled' = 'scheduled') => ({
    id,
    seasonId: season,
    matchDayId: day,
    session: 0,
    position: Number(id.at(-1)),
    startTime: '20:00',
    homeTeamId: 'a',
    awayTeamId: 'b',
    status,
  })
  await db
    .insert(matches)
    .values([
      game('m11', 'd1', 's', 'played'),
      game('m21', 'd2'),
      game('m22', 'd2', 's', 'cancelled'),
      game('m31', 'd3', 's', 'played'),
      game('m32', 'd3', 's', 'played'),
      game('m41', 'd4'),
      game('m42', 'd4'),
      game('m51', 'd5'),
      game('m61', 'd6'),
      game('o11', 'o1', 'old'),
    ])
  const r = (matchId: string, kind: 'draft' | 'published', homeSets = 2) => ({
    matchId,
    kind,
    homeSets,
    awaySets: 0,
    homePoints: 50,
    awayPoints: 30,
  })
  await db
    .insert(matchResults)
    .values([
      r('m11', 'published'),
      r('m11', 'draft'),
      r('m21', 'draft'),
      r('m31', 'published'),
      r('m31', 'draft'),
      r('m32', 'published'),
      r('m32', 'draft', 1),
    ])
  await db.insert(pages).values([
    { id: 'p1', path: '/faq', title: 'FAQ', body, status: 'published', updatedAt: '2026-10-01T00:00:00.000Z' },
    { id: 'p2', path: '/enrol', title: 'Enrol', body, status: 'draft' },
    { id: 'p3', path: '/rules', title: 'Rules', body, status: 'published', updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: null },
  ])
  await db.insert(pageRevisions).values([
    // A proposal newer than the page (the content map's): to review.
    { id: 'r1', pageId: 'p1', title: 'FAQ', body, createdAt: '2026-10-10T00:00:00.000Z' },
    // An older revision: nothing to review.
    { id: 'r2', pageId: 'p3', title: 'Rules', body, createdAt: '2026-09-01T00:00:00.000Z' },
  ])
  await db.insert(posts).values({ id: 'n1', slug: 'hello', title: 'Hello', body, status: 'draft' })
})

describe('loadDashboard', () => {
  it('lists this week’s nights and the played nights still to enter or publish', async () => {
    stats.reset()
    const d = await loadDashboard(db, env(), NOW)
    expect(d.today).toBe('2026-10-22')
    expect(d.upcoming.map((x) => [x.matchDayId, x.games])).toEqual([['d4', 2]])
    expect(d.needsResults.map((x) => ({ id: x.matchDayId, games: x.games, published: x.published, unpublished: x.unpublished }))).toEqual([
      { id: 'd3', games: 2, published: 2, unpublished: 1 },
      // The cancelled game doesn't count.
      { id: 'd2', games: 1, published: 0, unpublished: 1 },
    ])
    expect(d.needsResults[0]).toMatchObject({ seasonName: 'TNL Q4 2026', leagueCode: 'TNL', seasonId: 's', matchDay: 3 })
    // One batch of five plus the enrolment targets and the audit log, well under D1's 50.
    expect(stats.queries).toBeLessThanOrEqual(20)
  })

  it('lists drafts to review', async () => {
    const d = await loadDashboard(db, env(), NOW)
    expect(d.content.draftProgrammes.map((p) => p.code)).toEqual(['ADP'])
    expect(d.content.draftPages.map((p) => p.path)).toEqual(['/enrol'])
    expect(d.content.pagesToReview.map((p) => p.path)).toEqual(['/faq'])
    expect(d.content.draftPosts.map((p) => p.title)).toEqual(['Hello'])
  })

  it('stops listing a page once it has been saved since the proposal, or edited in the admin', async () => {
    await db.update(pages).set({ updatedAt: '2026-10-11T00:00:00.000Z' }).where(eq(pages.id, 'p1'))
    expect((await loadDashboard(db, env(), NOW)).content.pagesToReview).toEqual([])
    await db.update(pages).set({ updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: 'u1' }).where(eq(pages.id, 'p1'))
    expect((await loadDashboard(db, env(), NOW)).content.pagesToReview).toEqual([])
  })

  it('reports setup still needed to admins only', async () => {
    const d = await loadDashboard(db, env(), NOW)
    expect(d.setup.map((s) => s.key)).toEqual(['resend', 'turnstile', 'analytics'])
    expect(d.enrolment).toEqual([])
    expect(d.recent).toEqual([])
    const e = await loadDashboard(db, env({ role: 'editor' }), NOW)
    expect(e.setup).toEqual([])
    expect(e.enrolment).toBeNull()
    expect(e.recent).toBeNull()
    expect(e.upcoming).toHaveLength(1)
  })
})
