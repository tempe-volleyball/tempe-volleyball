import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '../db/testing'
import {
  courts,
  ladderAdjustments,
  leagues,
  matchDays,
  matches,
  matchResults,
  menuItems,
  pages,
  redirects,
  seasons,
  seasonTeams,
  teams,
  venues,
  type NewMatch,
} from '../db/schema'
import { loadSeason, loadSite, lookupPath } from '../site'
import { fixtureRows, ladderRows, toCompetition } from './adapter'
import { currentSeason, publicSeasons } from './load'

// A small TNL season in the in-memory DB: 3 teams (so a bye every week), two courts, two played weeks, a week off,
// and a final with placeholder sides. Plus an archived older season and a draft one.

const settings = (courtIds: string[]) => ({
  sessions: ['20:00', '21:00'],
  sessionMinutes: 60,
  meetings: 1,
  includeFinals: true,
  seed: 0,
  skipDates: [{ date: '2026-10-08', reason: 'NO MATCHES' }],
  defaultCourtIds: courtIds,
})

const m = (x: Partial<NewMatch> & Pick<NewMatch, 'id' | 'matchDayId'>): NewMatch => ({ seasonId: 's4', session: 0, position: 0, ...x })

async function seed(db: TestDb) {
  await db.insert(venues).values({ id: 'v1', name: 'Robyn Webster Sports Centre', slug: 'rwsc' })
  await db.insert(courts).values([
    { id: 'c1', venueId: 'v1', name: 'Court 1', sort: 0 },
    { id: 'c3', venueId: 'v1', name: 'Court 3', sort: 2 },
  ])
  await db.insert(leagues).values([
    { id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4, defaultVenueId: 'v1', sort: 0 },
    { id: 'tvsl', code: 'TVSL', name: 'Tempe Volleyball Super League', slug: 'tvsl', weekday: 0, format: 'super', sort: 4 },
  ])
  await db.insert(teams).values([
    { id: 'a', name: 'ACES', slug: 'aces' },
    { id: 'b', name: 'BLOCKERS', slug: 'blockers' },
    { id: 'c', name: 'CHAOS', slug: 'chaos' },
  ])
  await db.insert(seasons).values([
    {
      id: 's4',
      leagueId: 'tnl',
      name: 'TNL Q4 2026',
      slug: 'tnl-q4-2026',
      year: 2026,
      quarter: 4,
      startDate: '2026-09-24',
      status: 'published',
      settings: settings(['c1']),
    },
    {
      id: 's3',
      leagueId: 'tnl',
      name: 'TNL Q3 2026',
      slug: 'tnl-q3-2026',
      year: 2026,
      quarter: 3,
      startDate: '2026-07-02',
      status: 'archived',
      settings: settings(['c1']),
    },
    {
      id: 's1',
      leagueId: 'tnl',
      name: 'TNL Q1 2027',
      slug: 'tnl-q1-2027',
      year: 2027,
      quarter: 1,
      startDate: '2027-01-07',
      status: 'draft',
      settings: settings(['c1']),
    },
  ])
  await db.insert(seasonTeams).values(['a', 'b', 'c'].map((teamId, sort) => ({ seasonId: 's4', teamId, sort })))
  await db.insert(seasonTeams).values([{ seasonId: 's3', teamId: 'a' }])
  await db.insert(matchDays).values([
    { id: 'd1', seasonId: 's4', date: '2026-09-24', kind: 'regular', number: 1, resultsPublishedAt: '2026-09-26T01:00:00.000Z' },
    { id: 'd2', seasonId: 's4', date: '2026-10-01', kind: 'regular', number: 2, resultsPublishedAt: '2026-10-15T23:00:00.000Z' },
    { id: 'dx', seasonId: 's4', date: '2026-10-08', kind: 'skip', number: 0, note: 'NO MATCHES' },
    { id: 'd3', seasonId: 's4', date: '2026-10-15', kind: 'regular', number: 3 },
    { id: 'df', seasonId: 's4', date: '2026-10-22', kind: 'final', number: 4 },
  ])
  await db.insert(matches).values([
    m({
      id: 'm1',
      matchDayId: 'd1',
      startTime: '20:00',
      courtId: 'c1',
      homeTeamId: 'a',
      awayTeamId: 'b',
      dutyTeamId: 'c',
      status: 'played',
    }),
    // Played on Court 3 instead of the default Court 1: a court override for that slot.
    m({
      id: 'm2',
      matchDayId: 'd2',
      startTime: '21:00',
      session: 1,
      courtId: 'c3',
      homeTeamId: 'b',
      awayTeamId: 'c',
      dutyTeamId: 'a',
      status: 'played',
    }),
    m({ id: 'm3', matchDayId: 'd3', startTime: '20:00', courtId: 'c1', homeTeamId: 'c', awayTeamId: 'a', dutyTeamId: 'b' }),
    m({
      id: 'mf',
      matchDayId: 'df',
      startTime: '20:00',
      courtId: 'c1',
      homeLabel: '1st',
      awayLabel: '2nd',
      dutyLabel: '3rd',
      stageTitle: 'Grand Final',
    }),
  ])
  await db.insert(matchResults).values([
    {
      matchId: 'm1',
      kind: 'published',
      homeSets: 2,
      awaySets: 0,
      setScores: [
        [25, 20],
        [25, 18],
      ],
      homePoints: 50,
      awayPoints: 38,
    },
    {
      matchId: 'm1',
      kind: 'draft',
      homeSets: 2,
      awaySets: 0,
      setScores: [
        [25, 20],
        [25, 18],
      ],
      homePoints: 50,
      awayPoints: 38,
    },
    // No set scores (an imported short third set): the totals count as they are.
    { matchId: 'm2', kind: 'published', homeSets: 1, awaySets: 2, homePoints: 55, awayPoints: 60 },
    // A draft only: must not show.
    { matchId: 'm3', kind: 'draft', homeSets: 2, awaySets: 0, homePoints: 50, awayPoints: 10 },
  ])
  await db.insert(ladderAdjustments).values({ seasonId: 's4', teamId: 'b', points: 2, reason: 'wp-import reconciliation' })
}

describe('public competition data', () => {
  let db: TestDb
  beforeEach(async () => {
    db = createTestDb().db
    await seed(db)
  })

  it('loads each league’s current published season with its ladder (adjustments included, drafts ignored)', async () => {
    const site = await loadSite(db)
    expect(site.current.map((c) => c.summary.slug)).toEqual(['tnl-q4-2026'])
    const [tnl] = site.current
    expect(
      tnl!.ladder.map((r) => [r.pos, r.name, r.points, r.played, r.won, r.lost, r.setsFor, r.setsAgainst, r.pointsFor, r.pointsAgainst]),
    ).toEqual([
      // B: two losses (1 + 1) plus a 2-point adjustment = 4. A and C won once each (3); A is ahead on set difference.
      [1, 'BLOCKERS', 4, 2, 0, 2, 1, 4, 93, 110],
      [2, 'ACES', 3, 1, 1, 0, 2, 0, 50, 38],
      [3, 'CHAOS', 3, 1, 1, 0, 2, 1, 60, 55],
    ])
    expect(tnl!.ladder[1]!.ratio).toBe('0.568')
  })

  it('builds the fixtures table rows: times, court overrides, byes, skipped weeks, unresolved finals', async () => {
    const [tnl] = (await loadSite(db)).current
    const rows = fixtureRows(tnl!.competition, tnl!.data.matches)
    expect(rows.map((r) => [r.date, r.match, r.time, r.result, r.court, r.matchDay, r.duty, r.kind])).toEqual([
      ['2026-09-24', 'ACES vs BLOCKERS', '20:00', '2 - 0', 'Court 1', 1, 'CHAOS', 'game'],
      ['2026-09-24', 'BYE - CHAOS', 'Bye', '-', '', 1, '-', 'bye'],
      ['2026-10-01', 'BLOCKERS vs CHAOS', '21:00', '1 - 2', 'Court 3', 2, 'ACES', 'game'],
      ['2026-10-01', 'BYE - ACES', 'Bye', '-', '', 2, '-', 'bye'],
      ['2026-10-08', 'NO MATCHES', '', '', '', 0, '', 'skip'],
      ['2026-10-15', 'CHAOS vs ACES', '20:00', '', 'Court 1', 3, 'BLOCKERS', 'game'],
      ['2026-10-15', 'BYE - BLOCKERS', 'Bye', '-', '', 3, '-', 'bye'],
      // Round robin not finished, so the seeds stay placeholders.
      ['2026-10-22', 'GRAND FINAL - (1ST) vs (2ND)', '20:00', '', 'Court 1', 4, '(3RD)', 'game'],
    ])
    expect(rows[0]!.sets).toBe('25-20, 25-18')
    expect(rows[2]!.sets).toBe('')
  })

  it('maps match days to library weeks with the ladder heading data', async () => {
    const [tnl] = (await loadSite(db)).current
    const c = tnl!.competition
    expect(c.settings.courts).toEqual(['Court 1'])
    expect(c.settings.duty).toBe(true)
    expect(c.settings.points).toEqual({ win: 3, draw: 2, loss: 1 })
    expect(c.weeks.find((w) => w.id === 'd2')!.courtOverrides).toEqual({ '1:0': 'Court 3' })
    expect(c.weeks.find((w) => w.id === 'd3')!.games[0]!.publishedResult).toBeUndefined()
  })

  it('loads an archived season on its own, and lists public seasons newest first', async () => {
    const site = await loadSite(db)
    const data = await loadSeason(db, 's3', site)
    expect(data?.season.slug).toBe('tnl-q3-2026')
    expect(data?.teams.map((t) => t.name)).toEqual(['ACES'])
    expect(publicSeasons(site.seasons, 'tnl').map((s) => s.slug)).toEqual(['tnl-q4-2026', 'tnl-q3-2026'])
    expect(currentSeason(site.seasons, 'tvsl')).toBeUndefined()
  })

  it('falls back to the newest archived season when nothing is published', () => {
    const list = [
      { leagueId: 'x', year: 2025, quarter: 4, status: 'archived' as const, id: 'old' },
      { leagueId: 'x', year: 2026, quarter: 1, status: 'archived' as const, id: 'new' },
      { leagueId: 'x', year: 2026, quarter: 2, status: 'draft' as const, id: 'draft' },
    ]
    expect(currentSeason(list, 'x')?.id).toBe('new')
  })

  it('builds the menu with league routes and only published pages', async () => {
    await db.insert(pages).values([
      { id: 'p1', path: '/', title: 'Home', template: 'home', body: { blocks: [], html: '' }, status: 'published' },
      { id: 'p2', path: '/secret', title: 'Secret', body: { blocks: [], html: '' }, status: 'draft' },
    ])
    await db.insert(menuItems).values([
      { id: 'i1', label: 'Home', kind: 'page', pageId: 'p1', sort: 0 },
      { id: 'i2', label: 'Leagues', kind: 'url', sort: 1 },
      { id: 'i3', parentId: 'i2', label: 'TNL Ladder', kind: 'league_ladder', leagueId: 'tnl' },
      { id: 'i4', label: 'Secret', kind: 'page', pageId: 'p2', sort: 2 },
    ])
    const site = await loadSite(db)
    expect(site.menu.map((m) => [m.label, m.href, m.children.map((c) => c.href)])).toEqual([
      ['Home', '/', []],
      ['Leagues', null, ['/leagues/tnl#ladder']],
    ])
  })

  it('looks up a published page, a redirect and page titles in one batch', async () => {
    await db.insert(pages).values({
      id: 'p1',
      path: '/contact',
      title: 'CONTACT',
      template: 'contact',
      body: { blocks: [], html: '<p>x</p>' },
      status: 'published',
    })
    await db.insert(redirects).values({ fromPath: '/ladders', toPath: '/leagues/tnl#ladder', source: 'wp-import' })
    const page = await lookupPath(db, '/contact')
    expect(page.page?.title).toBe('CONTACT')
    expect(page.titles.get('/contact')).toBe('CONTACT')
    const old = await lookupPath(db, '/ladders')
    expect(old.page).toBeUndefined()
    expect(old.redirect).toMatchObject({ toPath: '/leagues/tnl#ladder', status: 301 })
  })
})

describe('ladderRows', () => {
  it('re-sorts after adjustments, so a penalty can drop a team', () => {
    const c = toCompetition({
      season: {
        id: 's',
        name: 'X',
        startDate: '2026-01-01',
        settings: settings([]),
        pointsWin: 3,
        pointsDraw: 2,
        pointsLoss: 1,
        dutyEnabled: true,
      } as never,
      league: {} as never,
      teams: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
      ] as never,
      matchDays: [{ id: 'd', date: '2026-01-01', kind: 'regular', number: 1, courtOverrides: {} }] as never,
      matches: [{ id: 'm', matchDayId: 'd', session: 0, position: 0, homeTeamId: 'a', awayTeamId: 'b' }] as never,
      results: [{ matchId: 'm', kind: 'published', homeSets: 2, awaySets: 0, homePoints: 50, awayPoints: 30 }] as never,
      adjustments: [],
      courts: [],
    })
    expect(ladderRows(c, []).map((r) => r.name)).toEqual(['A', 'B'])
    expect(ladderRows(c, [{ teamId: 'a', points: -3 }]).map((r) => [r.name, r.points])).toEqual([
      ['B', 1],
      ['A', 0],
    ])
  })
})
