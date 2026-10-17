import { beforeEach, describe, expect, it } from 'vitest'
import { tags } from '../cache'
import { seasonCalendarEvents } from '../competition/calendar'
import { createTestDb, type QueryStats, type TestDb } from '../db/testing'
import {
  developmentTerms,
  events,
  matchDays,
  matches,
  products,
  programmes,
  programmeSessions,
  seasons,
  seasonTeams,
  teams,
  venues,
} from '../db/schema'
import { loadSite } from '../site'
import {
  categoryPageTags,
  groupByCategory,
  loadCategoryPage,
  loadListings,
  loadProgrammePage,
  programmePageTags,
  programmeSeo,
  publicTargetSpots,
  spotsText,
} from './public'

// The public category, programme and /enrol loaders (src/server/programmes/public.ts) and the iCal events built
// from a season (src/server/competition/calendar.ts), against the migrated in-memory DB (categories are seeded by
// migration 0003).

const NOW = new Date('2026-10-18T00:00:00.000Z') // Sunday 18 October 2026, 11am in Sydney
const opts = { turnstileSiteKey: 'site-key', now: NOW }

let db: TestDb
let stats: QueryStats

const base = { weekday: 4, defaultVenueId: 'v1', sort: 0 }

async function seed() {
  await db.insert(venues).values({ id: 'v1', name: 'Robyn Webster Sports Centre', slug: 'rwsc', address: 'Holbeach Ave, Tempe NSW 2044' })
  await db.insert(programmes).values([
    {
      ...base,
      id: 'tnl',
      code: 'TNL',
      name: 'Thursday Night League',
      slug: 'tnl',
      categoryId: 'cat_mixed_leagues',
      startTime: '20:00',
      endTime: '22:00',
    },
    {
      ...base,
      id: 'old',
      code: 'MNL',
      name: 'Monday Night League',
      slug: 'mnl',
      weekday: 1,
      categoryId: 'cat_mixed_leagues',
      status: 'retired',
      active: false,
    },
    {
      ...base,
      id: 'wip',
      code: 'WIP',
      name: 'Secret League',
      slug: 'wip',
      categoryId: 'cat_mixed_leagues',
      status: 'draft',
      active: false,
    },
    {
      ...base,
      id: 'scrim',
      kind: 'training',
      code: 'SCRIM',
      name: 'Scrim and Coached Training',
      slug: 'scrim',
      weekday: 3,
      categoryId: 'cat_adult_training',
      startTime: '18:30',
      endTime: '20:00',
      enrolmentOpen: true,
      capPlayers: 40,
      summaryLine: 'Wednesday training for every level',
    },
    { ...base, id: 'jdp', kind: 'development', code: 'JDP', name: 'VolleyJoeys', slug: 'jdp', weekday: 6, categoryId: 'cat_juniors' },
    {
      ...base,
      id: 'cup',
      kind: 'event',
      code: 'CUP',
      name: 'Tempe Cup',
      slug: 'tempe-cup',
      weekday: 6,
      categoryId: 'cat_juniors',
      status: 'retired',
      active: false,
    },
  ])
  await db.insert(programmeSessions).values([
    { id: 'ps-past', programmeId: 'scrim', date: '2026-10-14' },
    { id: 'ps1', programmeId: 'scrim', date: '2026-10-21' },
    { id: 'ps2', programmeId: 'scrim', date: '2026-10-28', status: 'postponed', note: 'Venue booked', originalDate: '2026-10-27' },
  ])
  await db.insert(products).values([
    {
      id: 'p1',
      programmeId: 'scrim',
      sessionId: 'ps1',
      kind: 'training_session',
      name: 'Scrim 21 Oct',
      slug: 'p1',
      priceCents: 1500,
      capacity: 2,
    },
    { id: 'p2', programmeId: 'scrim', sessionId: 'ps2', kind: 'training_session', name: 'Scrim 28 Oct', slug: 'p2', priceCents: 1500 },
  ])
  await db.insert(developmentTerms).values({
    id: 't4',
    programmeId: 'jdp',
    name: 'Term 4 2026',
    slug: 'term-4-2026',
    startDate: '2026-10-10',
    endDate: '2026-12-12',
    ageGroup: 'Ages 8–11',
  })
  await db.insert(events).values({ id: 'e1', programmeId: 'cup', name: 'Tempe Cup 2025', slug: 'tempe-cup-2025', startDate: '2025-11-01' })
  // TNL's current season: two nights, a duty team.
  await db.insert(teams).values([
    { id: 'a', name: 'Aces', slug: 'aces' },
    { id: 'b', name: 'Blockers', slug: 'blockers' },
    { id: 'c', name: 'Chaos', slug: 'chaos' },
  ])
  await db.insert(seasons).values({
    id: 's4',
    leagueId: 'tnl',
    name: 'TNL Q4 2026',
    slug: 'tnl-q4-2026',
    year: 2026,
    quarter: 4,
    startDate: '2026-10-15',
    status: 'published',
    settings: {
      sessions: ['20:00', '21:00'],
      sessionMinutes: 60,
      meetings: 1,
      includeFinals: false,
      seed: 0,
      skipDates: [],
      defaultCourtIds: [],
    },
  })
  await db.insert(seasonTeams).values(['a', 'b', 'c'].map((teamId, sort) => ({ seasonId: 's4', teamId, sort })))
  await db.insert(matchDays).values([
    { id: 'd1', seasonId: 's4', date: '2026-10-15', kind: 'regular', number: 1, status: 'scheduled' },
    { id: 'd2', seasonId: 's4', date: '2026-10-22', kind: 'regular', number: 2, status: 'scheduled' },
  ])
  await db.insert(matches).values([
    {
      id: 'm1',
      seasonId: 's4',
      matchDayId: 'd1',
      session: 0,
      position: 0,
      startTime: '20:00',
      homeTeamId: 'a',
      awayTeamId: 'b',
      dutyTeamId: 'c',
    },
    {
      id: 'm2',
      seasonId: 's4',
      matchDayId: 'd2',
      session: 1,
      position: 0,
      startTime: '21:00',
      homeTeamId: 'b',
      awayTeamId: 'c',
      dutyTeamId: 'a',
      status: 'cancelled',
    },
  ])
}

beforeEach(async () => {
  const t = createTestDb()
  db = t.db
  stats = t.stats
  await seed()
})

describe('loadListings and category pages', () => {
  it('lists active programmes only, with generated text and live enrolment', async () => {
    const l = await loadListings(db, NOW)
    // Sort order, then name.
    expect(l.programmes.map((p) => p.code)).toEqual(['SCRIM', 'TNL', 'JDP'])
    const scrim = l.programmes.find((p) => p.code === 'SCRIM')!
    expect(scrim).toMatchObject({
      path: '/training/scrim',
      summary: 'Wednesday training for every level',
      schedule: 'Wednesdays 6:30–8pm',
      venue: 'Robyn Webster Sports Centre, Tempe',
      nextStarts: 'Next session starts Wednesday 21 October 2026',
      enrolmentOpen: true,
    })
    // The postponed session isn't open for enrolment.
    expect(scrim.targets.map((t) => t.spots)).toEqual(['2 spots left'])
    const tnl = l.programmes.find((p) => p.code === 'TNL')!
    expect(tnl.enrolmentOpen).toBe(false)
    expect(tnl.summary).toBe('Thursday Night League (TNL) @ Robyn Webster Sports Centre, Tempe, Thursdays 8–10pm')
    expect(groupByCategory(l).map((g) => g.category?.slug)).toEqual(['mixed-leagues', 'juniors', 'adult-training'])
  })

  it('finds a category by slug, never a missing one, in a bounded number of queries', async () => {
    stats.reset()
    const page = await loadCategoryPage(db, 'mixed-leagues', NOW)
    expect(stats.queries).toBeLessThanOrEqual(25)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(page?.category.name).toBe('Mixed Leagues')
    expect(page?.cards.map((c) => c.code)).toEqual(['TNL'])
    stats.reset()
    expect(await loadCategoryPage(db, 'contact', NOW)).toBeNull()
    expect(stats.queries).toBe(1)
    expect(categoryPageTags('mixed-leagues')).toEqual([
      tags.category('mixed-leagues'),
      tags.programmes,
      tags.venues,
      tags.page('/mixed-leagues'),
    ])
  })
})

describe('loadProgrammePage', () => {
  it('hides drafts and unknown slugs, and sends other kinds to their own URL', async () => {
    expect(await loadProgrammePage(db, 'league', 'wip', opts)).toBeNull()
    expect(await loadProgrammePage(db, 'training', 'nope', opts)).toBeNull()
    expect(await loadProgrammePage(db, 'training', 'tnl', opts)).toEqual({ redirect: '/leagues/tnl' })
    expect(await loadProgrammePage(db, 'league', 'scrim', opts)).toEqual({ redirect: '/training/scrim' })
  })

  it('loads a training programme: upcoming sessions, its category and the enrolment form', async () => {
    stats.reset()
    const r = await loadProgrammePage(db, 'training', 'scrim', opts)
    expect(stats.queries).toBeLessThanOrEqual(30)
    if (!r || !('found' in r)) throw new Error('not found')
    const p = r.found
    expect(p.path).toBe('/training/scrim')
    expect(p.category?.slug).toBe('adult-training')
    expect(p.upcoming.map((i) => [i.id, i.status, i.movedFrom])).toEqual([
      ['ps1', 'scheduled', null],
      ['ps2', 'postponed', '2026-10-27'],
    ])
    expect(p.past.map((i) => i.id)).toEqual(['ps-past'])
    expect(p.nextInstanceDate).toBe('2026-10-21')
    expect(p.enrolment?.turnstileSiteKey).toBe('site-key')
    expect(p.enrolment?.targets.map((t) => [t.id, publicTargetSpots(t)])).toEqual([['ps1', '2 spots left']])
    expect(programmePageTags(p.programme, 'adult-training')).toEqual([
      tags.programme('scrim'),
      tags.category('adult-training'),
      tags.venues,
      tags.page('/training/scrim'),
    ])
  })

  it('loads terms and events, retired programmes included, and skips the form while enrolment is off', async () => {
    const jdp = await loadProgrammePage(db, 'development', 'jdp', opts)
    if (!jdp || !('found' in jdp)) throw new Error('not found')
    expect(jdp.found.upcoming.map((t) => [t.title, t.ageGroup, t.endDate])).toEqual([['Term 4 2026', 'Ages 8–11', '2026-12-12']])
    expect(jdp.found.enrolment).toBeNull()
    const cup = await loadProgrammePage(db, 'event', 'tempe-cup', opts)
    if (!cup || !('found' in cup)) throw new Error('not found')
    expect(cup.found.programme.status).toBe('retired')
    expect(cup.found.past.map((e) => e.title)).toEqual(['Tempe Cup 2025'])
    const mnl = await loadProgrammePage(db, 'league', 'mnl', opts)
    expect(mnl && 'found' in mnl && mnl.found.programme.status).toBe('retired')
  })
})

describe('text helpers', () => {
  it('describes spots', () => {
    const c = (players: number | null, teams: number | null, n = 0, waitlist = 0) => ({
      caps: { players, teams },
      counts: { players: n, teams: 0, waitlist, offered: 0, teamsWaitlist: 0, unpaid: 0 },
    })
    expect(spotsText(c(null, null))).toBe('')
    expect(spotsText(c(10, null, 9))).toBe('1 spot left')
    expect(spotsText(c(10, 8, 3))).toBe('8 team spots left, 7 spots left')
    expect(spotsText(c(10, null, 10))).toBe('Waitlist only')
    expect(spotsText(c(10, null, 3, 1))).toBe('Waitlist only')
    expect(spotsText(c(10, null, 10), false)).toBe('Full')
    expect(publicTargetSpots({ full: false, waitlistOnly: false, spotsLeft: null, teamSpotsLeft: null })).toBe('Open')
    expect(publicTargetSpots({ full: true, waitlistOnly: false, spotsLeft: 0, teamSpotsLeft: null })).toBe('Full')
  })
  it('uses the SEO fields when set, else generated text', () => {
    const p = {
      kind: 'league' as const,
      name: 'Thursday Night League',
      seoTitle: null,
      seoDescription: null,
      description: { blocks: [], html: '' },
    }
    const s = programmeSeo(
      p,
      'Thursday Night League (TNL) @ Robyn Webster Sports Centre, Tempe, Thursdays 8–10pm',
      'Next season starts Thursday 14 January 2027',
    )
    expect(s.title).toBe('Thursday Night League Ladder, Fixtures and Results')
    expect(s.description).toBe(
      'Thursday Night League (TNL) @ Robyn Webster Sports Centre, Tempe, Thursdays 8–10pm. Next season starts Thursday 14 January 2027',
    )
    expect(programmeSeo({ ...p, seoTitle: 'TNL', seoDescription: 'Hand-written description that is long enough to use.' }, '', '')).toEqual(
      {
        title: 'TNL',
        description: 'Hand-written description that is long enough to use.',
      },
    )
  })
})

describe('season calendar events', () => {
  it("builds a league's events in UTC with stable UIDs, and one team's games and duties", async () => {
    const site = await loadSite(db)
    const tnl = site.current.find((c) => c.league.slug === 'tnl')!
    const venue = site.venues[0]
    const all = seasonCalendarEvents(tnl, { venue, pageUrl: 'https://www.tempevb.com/leagues/tnl' })
    expect(all).toEqual([
      {
        uid: 'm1@tempevb.com',
        // 8pm Sydney in October is AEDT (UTC+11).
        start: '2026-10-15T09:00:00.000Z',
        end: '2026-10-15T10:00:00.000Z',
        summary: 'TNL: Aces vs Blockers',
        location: 'Robyn Webster Sports Centre, Holbeach Ave, Tempe NSW 2044',
        description: 'Match day 1\nDuty: Chaos',
        status: 'CONFIRMED',
        url: 'https://www.tempevb.com/leagues/tnl',
      },
      expect.objectContaining({
        uid: 'm2@tempevb.com',
        start: '2026-10-22T10:00:00.000Z',
        summary: 'Cancelled: TNL: Blockers vs Chaos',
        status: 'CANCELLED',
      }),
    ])
    const aces = seasonCalendarEvents(tnl, { teamId: 'a' })
    expect(aces.map((e) => e.summary)).toEqual(['TNL: Aces vs Blockers', 'Cancelled: TNL duty: Blockers vs Chaos'])
    expect(seasonCalendarEvents(tnl, { teamId: 'zz' })).toEqual([])
  })
})
