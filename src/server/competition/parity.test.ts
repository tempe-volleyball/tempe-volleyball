import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { fullCsv, generate, importFixturesCsv, pushBack, shapeKey, type Result, type Week } from '../../lib/fixtures'
import { createTestDb, type QueryStats, type TestDb } from '../db/testing'
import { auditLog, courts, leagues, matchDays, matches, matchResults, seasons, seasonTeams, user, venues } from '../db/schema'
import { HttpError } from '../http'
import { tags } from '../cache'
import { fixtureRows, ladderRows, toCompetition } from './adapter'
import { listMatches } from './match-list'
import { setNightStatus } from './nights'
import { publishResults, saveResults, setMatchStatus } from './results'
import { createSeason, getSeason, loadSeason, saveDraw, setSeasonStatus, setSeasonTeams, updateSeason, type SeasonView } from './seasons'
import { createTeam } from './teams'
import { reinstateTeam, withdrawTeam } from './withdraw'

// Fixtures parity (docs/admin.md §1): postponed/TBD games, a whole night postponed or cancelled (with or without
// pushing the season back), withdrawn teams, tie-break order, the cross-league match list and CSV import.

const NOW = new Date('2026-10-18T00:00:00.000Z')
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

let db: TestDb
let stats: QueryStats
const admin = { id: 'adm', ip: '203.0.113.9' }

const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpError)
  expect({ status: (e as HttpError).status, code: (e as HttpError).code }).toEqual({ status, code: code ?? (e as HttpError).code })
  return e as HttpError
}

const NAMES = [
  'Aces',
  'Blockers',
  'Chaos',
  'Diggers',
  'Easy Spikers',
  'Floaters',
  'Gamers',
  'Hitmen',
  'Ice Cold',
  'Jumpers',
  'KBU',
  'Liberos',
]

beforeEach(async () => {
  const t = createTestDb()
  db = t.db
  stats = t.stats
  await db.insert(user).values({ id: 'adm', name: 'adm', email: 'adm@example.com', emailVerified: true, role: 'admin' })
  await db.insert(venues).values([
    { id: 'tempe', name: 'Robyn Webster Sports Centre', slug: 'robyn-webster', sort: 0 },
    { id: 'fivedock', name: 'Five Dock Leisure Centre', slug: 'five-dock', sort: 1 },
  ])
  await db.insert(courts).values([
    { id: 'c1', venueId: 'tempe', name: 'Court 1', sort: 1 },
    { id: 'c2', venueId: 'tempe', name: 'Court 2', sort: 2 },
    { id: 'c3', venueId: 'tempe', name: 'Court 3', sort: 3 },
    { id: 'fd1', venueId: 'fivedock', name: 'Court 1', sort: 4 },
  ])
  await db.insert(leagues).values([
    { id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4, defaultVenueId: 'tempe', sort: 0 },
    { id: 'sal', code: 'SAL', name: 'Sunday Afternoon League', slug: 'sal', weekday: 0, defaultVenueId: 'fivedock', sort: 3 },
  ])
})

/** A season with `n` teams, its draw generated (as the browser does) and saved; published unless `draft`. */
async function season(n: number, opts: { league?: string; meetings?: number; draft?: boolean; quarter?: number } = {}) {
  const league = opts.league ?? 'tnl'
  let v = await createSeason(db, admin, { leagueId: league, year: 2027, quarter: opts.quarter ?? 1, copyFrom: null }, NOW)
  const ids: string[] = []
  for (const name of NAMES.slice(0, n)) ids.push((await createTeam(db, admin, { name: `${name} ${league}${opts.quarter ?? 1}` }, NOW)).id)
  v = await setSeasonTeams(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, teamIds: ids }, at(1))
  const courtsFor = league === 'sal' ? ['Court 1'] : ['Court 1', 'Court 2', 'Court 3']
  v = (
    await updateSeason(
      db,
      admin,
      v.season.id,
      { baseUpdatedAt: v.season.updatedAt, settings: { courts: courtsFor, meetings: opts.meetings ?? 1, includeFinals: true } },
      at(2),
    )
  ).result
  const s = v.competition.settings
  const saved = await saveDraw(
    db,
    admin,
    v.season.id,
    { baseUpdatedAt: v.season.updatedAt, weeks: generate(s), generatedFrom: shapeKey(s), edited: false },
    at(3),
  )
  if (opts.draft) return getSeason(db, v.season.id)
  return (await setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: saved.result.season.updatedAt, status: 'published' }, at(4)))
    .result
}

const playing = (v: SeasonView) => v.competition.weeks!.filter((w) => w.kind !== 'skip')
const win: Result = {
  home: 2,
  away: 0,
  sets: [
    [25, 20],
    [25, 20],
  ],
}

/** Enters and publishes a 2-0 home win for every game of a night. */
async function publishNight(v: SeasonView, w: Week, when: Date) {
  const results = Object.fromEntries(w.games.map((g) => [g.id, win]))
  const day = await saveResults(db, admin, v.season.id, w.id, { baseUpdatedAt: v.matchDays[w.id]!.updatedAt, results }, when)
  await publishResults(db, admin, v.season.id, w.id, { baseUpdatedAt: day.updatedAt }, when)
  return getSeason(db, v.season.id)
}

describe('postponed and TBD games', () => {
  it('take a note, take no result, and don’t hold up publishing the night', async () => {
    const v = await season(4)
    const w = playing(v)[0]!
    const [g1, g2] = w.games
    let token = v.matchDays[w.id]!.updatedAt
    const r1 = await setMatchStatus(
      db,
      admin,
      v.season.id,
      w.id,
      g1!.id,
      { baseUpdatedAt: token, status: 'postponed', note: 'Ref sick' },
      at(10),
    )
    expect(r1.result.match).toEqual({ id: g1!.id, status: 'postponed', statusNote: 'Ref sick' })
    expect(r1.purge.tags).toContain(tags.site)
    token = r1.result.matchDay.updatedAt
    await rejects(saveResults(db, admin, v.season.id, w.id, { baseUpdatedAt: token, results: { [g1!.id]: win } }), 400)
    token = (await saveResults(db, admin, v.season.id, w.id, { baseUpdatedAt: token, results: { [g2!.id]: win } }, at(11))).updatedAt
    await publishResults(db, admin, v.season.id, w.id, { baseUpdatedAt: token }, at(12))
    const fresh = await getSeason(db, v.season.id)
    const games = fresh.competition.weeks!.find((x) => x.id === w.id)!.games
    expect(games.find((g) => g.id === g1!.id)).toMatchObject({ status: 'postponed', statusNote: 'Ref sick' })
    expect(games.find((g) => g.id === g1!.id)!.publishedResult).toBeUndefined()
    const rows = fixtureRows(toCompetition(await loadSeason(db, v.season.id)))
    expect(rows.find((r) => r.key === g1!.id)).toMatchObject({ result: 'Postponed', note: 'Ref sick', status: 'postponed' })
    // TBD, then back to played (the note goes).
    token = fresh.matchDays[w.id]!.updatedAt
    token = (await setMatchStatus(db, admin, v.season.id, w.id, g1!.id, { baseUpdatedAt: token, status: 'tbd' }, at(13))).result.matchDay
      .updatedAt
    expect(fixtureRows(toCompetition(await loadSeason(db, v.season.id))).find((r) => r.key === g1!.id)!.result).toBe('TBD')
    const back = await setMatchStatus(db, admin, v.season.id, w.id, g1!.id, { baseUpdatedAt: token, status: 'played' }, at(14))
    expect(back.result.match).toEqual({ id: g1!.id, status: 'scheduled', statusNote: null })
  })
})

describe('a whole night', () => {
  it('postpones every game (keeping the date), shows why, and restores exactly what was there', async () => {
    let v = await season(4)
    const w = playing(v)[1]!
    const g = w.games[0]!
    // One game was already a forfeit: restoring puts it back as a forfeit.
    await setMatchStatus(db, admin, v.season.id, w.id, g.id, { baseUpdatedAt: v.matchDays[w.id]!.updatedAt, status: 'forfeit' }, at(10))
    v = await getSeason(db, v.season.id)
    await rejects(setNightStatus(db, admin, v.season.id, w.id, { baseUpdatedAt: 'stale', action: 'postpone' }), 409, 'conflict')
    stats.reset()
    const r = await setNightStatus(
      db,
      admin,
      v.season.id,
      w.id,
      { baseUpdatedAt: v.season.updatedAt, action: 'postpone', note: 'Hall flooded' },
      at(11),
    )
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(r.purge.tags).toEqual([tags.season(v.season.slug), tags.league('tnl'), tags.site])
    v = r.result
    const night = v.competition.weeks!.find((x) => x.id === w.id)!
    expect(night).toMatchObject({ date: w.date, status: 'postponed', note: 'Hall flooded' })
    expect(night.games.every((x) => x.status === 'postponed')).toBe(true)
    // Nothing to enter, so the night can be published as is (nobody's ladder changes).
    await publishResults(db, admin, v.season.id, w.id, { baseUpdatedAt: v.matchDays[w.id]!.updatedAt }, at(12))
    v = await getSeason(db, v.season.id)

    v = (await setNightStatus(db, admin, v.season.id, w.id, { baseUpdatedAt: v.season.updatedAt, action: 'restore' }, at(13))).result
    const restored = v.competition.weeks!.find((x) => x.id === w.id)!
    expect(restored.status).toBeUndefined()
    expect(restored.note).toBeUndefined()
    expect(restored.games.find((x) => x.id === g.id)!.status).toBe('forfeit')
    expect(restored.games.filter((x) => x.id !== g.id).every((x) => x.status === undefined)).toBe(true)
    const actions = (await db.select().from(auditLog).all()).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['match_day.postpone', 'match_day.restore']))
    await rejects(
      setNightStatus(db, admin, v.season.id, w.id, { baseUpdatedAt: v.season.updatedAt, action: 'restore' }),
      409,
      'bad_transition',
    )
  })

  it('cancels a night (dropping draft results) and refuses nights with published results', async () => {
    let v = await season(4)
    const [w1, w2] = playing(v)
    v = await publishNight(v, w1!, at(10))
    await rejects(
      setNightStatus(db, admin, v.season.id, w1!.id, { baseUpdatedAt: v.season.updatedAt, action: 'cancel' }),
      409,
      'has_results',
    )
    await saveResults(
      db,
      admin,
      v.season.id,
      w2!.id,
      { baseUpdatedAt: v.matchDays[w2!.id]!.updatedAt, results: { [w2!.games[0]!.id]: win } },
      at(11),
    )
    v = await getSeason(db, v.season.id)
    v = (
      await setNightStatus(db, admin, v.season.id, w2!.id, { baseUpdatedAt: v.season.updatedAt, action: 'cancel', note: 'Storm' }, at(12))
    ).result
    expect(v.competition.weeks!.find((x) => x.id === w2!.id)!.games.every((g) => g.status === 'cancelled' && !g.result)).toBe(true)
    const rows = fixtureRows(toCompetition(await loadSeason(db, v.season.id)))
    expect(rows.filter((r) => r.date === w2!.date).every((r) => r.kind === 'bye' || r.result === 'Cancelled')).toBe(true)
  })

  it('pushes the rest of the season back a week, keeping results attached, and undoes it', async () => {
    let v = await season(6)
    const weeks = playing(v)
    v = await publishNight(v, weeks[0]!, at(10))
    const before = await db.select().from(matchDays).where(eq(matchDays.seasonId, v.season.id)).all()
    const night = weeks[2]!
    // The admin previews with the lib; the server must do exactly the same.
    const preview = pushBack(v.competition.weeks!, night.id, { skipId: 'preview', note: 'x', status: 'postponed', skipDates: [] })

    stats.reset()
    const r = await setNightStatus(
      db,
      admin,
      v.season.id,
      night.id,
      { baseUpdatedAt: v.season.updatedAt, action: 'postpone', note: 'Venue booked out', pushBack: true },
      at(11),
    )
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    v = r.result
    const after = v.competition.weeks!
    expect(after).toHaveLength(weeks.length + 1)
    const off = after.find((w) => w.kind === 'skip')!
    expect(off).toMatchObject({ date: night.date, status: 'postponed', note: 'Postponed – Venue booked out' })
    for (const m of preview.moves) expect(after.find((w) => w.id === m.weekId)).toMatchObject({ date: m.to, originalDate: m.from })
    // Earlier nights stay, with their results; the games keep their ids.
    expect(after[0]).toMatchObject({ id: weeks[0]!.id, date: weeks[0]!.date })
    expect(after[0]!.games.every((g) => g.publishedResult)).toBe(true)
    expect(after.filter((w) => w.kind !== 'skip').map((w) => w.games.map((g) => g.id))).toEqual(weeks.map((w) => w.games.map((g) => g.id)))
    expect(v.competition.settings.skipDates).toEqual([{ date: night.date, reason: 'Postponed – Venue booked out' }])
    // The public fixtures say so.
    const rows = fixtureRows(toCompetition(await loadSeason(db, v.season.id)))
    expect(rows.find((x) => x.kind === 'skip')).toMatchObject({ date: night.date, match: 'Postponed – Venue booked out' })
    expect(rows.find((x) => x.key === night.games[0]!.id)!.movedFrom).toBe(night.date)
    // A night that has moved can't be pushed back from a night before published results… but it can be undone.
    v = (await setNightStatus(db, admin, v.season.id, off.id, { baseUpdatedAt: v.season.updatedAt, action: 'restore' }, at(12))).result
    const restored = await db.select().from(matchDays).where(eq(matchDays.seasonId, v.season.id)).all()
    const shape = (rows: typeof before) => rows.map((d) => [d.id, d.date, d.originalDate, d.kind]).toSorted()
    expect(shape(restored)).toEqual(shape(before))
    expect(v.competition.settings.skipDates).toEqual([])
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'season.push_back')).all()).toHaveLength(1)
  })

  it('refuses to push back over published results, and undo after the nights moved again', async () => {
    let v = await season(4)
    const weeks = playing(v)
    v = await publishNight(v, weeks[2]!, at(10))
    await rejects(
      setNightStatus(db, admin, v.season.id, weeks[1]!.id, { baseUpdatedAt: v.season.updatedAt, action: 'postpone', pushBack: true }),
      409,
      'cannot_move',
    )
    // Two push-backs in a row: only the latest can be undone.
    let r = await setNightStatus(
      db,
      admin,
      v.season.id,
      weeks[3]!.id,
      { baseUpdatedAt: v.season.updatedAt, action: 'postpone', pushBack: true },
      at(11),
    )
    const first = r.result.competition.weeks!.find((w) => w.kind === 'skip' && w.status === 'postponed')!
    r = await setNightStatus(
      db,
      admin,
      v.season.id,
      weeks[3]!.id,
      { baseUpdatedAt: r.result.season.updatedAt, action: 'cancel', pushBack: true },
      at(12),
    )
    await rejects(
      setNightStatus(db, admin, v.season.id, first.id, { baseUpdatedAt: r.result.season.updatedAt, action: 'restore' }),
      409,
      'cannot_undo',
    )
    expect(r.result.competition.weeks!.find((w) => w.id === weeks[3]!.id)!.originalDate).toBe(weeks[3]!.date)
  })

  it('stays under D1’s limits for the biggest season', async () => {
    const v = await season(12, { meetings: 2 })
    const first = playing(v)[0]!
    stats.reset()
    const r = await setNightStatus(
      db,
      admin,
      v.season.id,
      first.id,
      { baseUpdatedAt: v.season.updatedAt, action: 'postpone', pushBack: true },
      at(11),
    )
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(r.result.competition.weeks!.length).toBe(v.competition.weeks!.length + 1)
    stats.reset()
    const skip = r.result.competition.weeks!.find((w) => w.kind === 'skip')!
    await setNightStatus(db, admin, v.season.id, skip.id, { baseUpdatedAt: r.result.season.updatedAt, action: 'restore' }, at(12))
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
  })

  it('needs a published season', async () => {
    const v = await season(4, { draft: true })
    const e = await rejects(
      setNightStatus(db, admin, v.season.id, playing(v)[0]!.id, { baseUpdatedAt: v.season.updatedAt, action: 'postpone' }),
      409,
      'season_not_published',
    )
    expect(e.message).toMatch(/draft/)
  })
})

describe('withdrawn teams', () => {
  it('cancels their remaining games, follows the ladder policy, and reinstates', async () => {
    let v = await season(5)
    const weeks = playing(v)
    v = await publishNight(v, weeks[0]!, at(10))
    const out = v.competition.settings.teams[0]!
    const theirs = (w: Week) => w.games.filter((g) => [g.home, g.away].some((r) => 'team' in r && r.team === out.id))
    stats.reset()
    const r = await withdrawTeam(
      db,
      admin,
      v.season.id,
      out.id,
      { baseUpdatedAt: v.season.updatedAt, reason: 'Folded', from: weeks[1]!.date },
      at(11),
    )
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    v = r.result
    const remaining = weeks
      .slice(1)
      .filter((w) => w.kind === 'regular')
      .flatMap(theirs)
    expect(r.result.cancelled).toBeGreaterThanOrEqual(remaining.length)
    expect(v.competition.settings.teams[0]!.withdrawn).toMatchObject({ reason: 'Folded' })
    const games = v.competition.weeks!.flatMap((w) => w.games)
    for (const g of remaining)
      expect(games.find((x) => x.id === g.id)).toMatchObject({ status: 'cancelled', statusNote: `${out.name} withdrew` })
    // Their played game stays.
    for (const g of theirs(weeks[0]!)) expect(games.find((x) => x.id === g.id)!.status).toBe('played')
    await rejects(
      withdrawTeam(db, admin, v.season.id, out.id, { baseUpdatedAt: v.season.updatedAt, reason: 'again' }),
      409,
      'already_withdrawn',
    )

    // Ladder: marked and last by default…
    let c = toCompetition(await loadSeason(db, v.season.id))
    expect(ladderRows(c, []).at(-1)).toMatchObject({ teamId: out.id, withdrawn: true })
    // …hidden, or with their results voided, as the season says. Cancelled games show as byes if asked.
    v = (
      await updateSeason(
        db,
        admin,
        v.season.id,
        { baseUpdatedAt: v.season.updatedAt, settings: { withdrawn: { ladder: 'hide', results: 'void', fixtures: 'bye' } } },
        at(12),
      )
    ).result
    c = toCompetition(await loadSeason(db, v.season.id))
    expect(ladderRows(c, []).map((x) => x.teamId)).not.toContain(out.id)
    expect(ladderRows(c, []).every((x) => x.played <= 1)).toBe(true)
    const rows = fixtureRows(c)
    expect(rows.some((x) => x.key === remaining[0]!.id)).toBe(false)
    expect(rows.filter((x) => x.kind === 'bye' && x.note === `${out.name} withdrew`).length).toBeGreaterThan(0)

    const back = await reinstateTeam(db, admin, v.season.id, out.id, { baseUpdatedAt: v.season.updatedAt }, at(13))
    expect(back.result.restored).toBe(r.result.cancelled)
    expect(back.result.competition.settings.teams[0]!.withdrawn).toBeUndefined()
    const now = back.result.competition.weeks!.flatMap((w) => w.games)
    for (const g of remaining) expect(now.find((x) => x.id === g.id)!.status).toBeUndefined()
    const row = await db
      .select()
      .from(seasonTeams)
      .where(and(eq(seasonTeams.seasonId, v.season.id), eq(seasonTeams.teamId, out.id)))
      .get()
    expect(row).toMatchObject({ withdrawnAt: null, withdrawnReason: null })
  })
})

describe('tie-break order', () => {
  it('is a season setting that can change on a published season, and is copied to the next season', async () => {
    const v = await season(4)
    await rejects(updateSeason(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, settings: { tieBreaks: ['nonsense'] } }), 400)
    const r = await updateSeason(
      db,
      admin,
      v.season.id,
      { baseUpdatedAt: v.season.updatedAt, settings: { tieBreaks: ['headToHead', 'pointRatio'] } },
      at(10),
    )
    expect(r.result.competition.settings.tieBreaks).toEqual(['headToHead', 'pointRatio', 'name'])
    const row = await db.select().from(seasons).where(eq(seasons.id, v.season.id)).get()
    expect(row!.settings.tieBreaks).toEqual(['headToHead', 'pointRatio', 'name'])
    expect(row!.settings.defaultCourtIds).toEqual(['c1', 'c2', 'c3'])
    // Other settings saves keep it.
    await updateSeason(
      db,
      admin,
      v.season.id,
      { baseUpdatedAt: r.result.season.updatedAt, settings: { sessions: ['19:00', '20:00'] } },
      at(11),
    )
    expect((await db.select().from(seasons).where(eq(seasons.id, v.season.id)).get())!.settings.tieBreaks).toEqual([
      'headToHead',
      'pointRatio',
      'name',
    ])
    const next = await createSeason(db, admin, { leagueId: 'tnl', year: 2027, quarter: 2 }, at(12))
    expect(next.competition.settings.tieBreaks).toEqual(['headToHead', 'pointRatio', 'name'])
  })
})

describe('the cross-league match list', () => {
  it('filters by date, league, team, venue, court and status, and leaves drafts out', async () => {
    const tnl = await season(4)
    const sal = await season(4, { league: 'sal' })
    await season(4, { quarter: 2, draft: true })
    const night = playing(tnl)[0]!
    const all = await listMatches(db, { from: '2027-01-01', to: '2027-12-31' })
    const total = [tnl, sal].flatMap((v) => playing(v).flatMap((w) => w.games)).length
    expect(all.rows).toHaveLength(total)
    expect(all.truncated).toBe(false)
    expect(all.rows.map((r) => r.date)).toEqual(all.rows.map((r) => r.date).toSorted())
    expect(all.options.leagues.map((l) => l.code)).toEqual(['TNL', 'SAL'])

    const thursday = await listMatches(db, { from: night.date, to: night.date })
    expect(thursday.rows.map((r) => r.id).toSorted()).toEqual(night.games.map((g) => g.id).toSorted())
    expect(thursday.rows[0]).toMatchObject({
      leagueCode: 'TNL',
      seasonName: tnl.season.name,
      matchDayId: night.id,
      venueName: 'Robyn Webster Sports Centre',
    })
    expect(thursday.rows[0]!.home).toHaveProperty('name')

    expect(
      (await listMatches(db, { from: '2027-01-01', to: '2027-12-31', leagueId: 'sal' })).rows.every((r) => r.leagueCode === 'SAL'),
    ).toBe(true)
    expect(
      (await listMatches(db, { from: '2027-01-01', to: '2027-12-31', venueId: 'fivedock' })).rows.every((r) => r.leagueCode === 'SAL'),
    ).toBe(true)
    expect((await listMatches(db, { from: '2027-01-01', to: '2027-12-31', courtId: 'c2' })).rows.every((r) => r.courtId === 'c2')).toBe(
      true,
    )
    const team = tnl.competition.settings.teams[0]!.id
    const mine = await listMatches(db, { from: '2027-01-01', to: '2027-12-31', teamId: team })
    expect(mine.rows.length).toBeGreaterThan(0)
    expect(mine.rows.every((r) => [r.home, r.away, r.duty].some((x) => x && 'teamId' in x && x.teamId === team))).toBe(true)
    await setMatchStatus(
      db,
      admin,
      tnl.season.id,
      night.id,
      night.games[0]!.id,
      { baseUpdatedAt: tnl.matchDays[night.id]!.updatedAt, status: 'tbd' },
      at(20),
    )
    expect((await listMatches(db, { from: '2027-01-01', to: '2027-12-31', status: 'tbd' })).rows.map((r) => r.id)).toEqual([
      night.games[0]!.id,
    ])
    expect((await listMatches(db, { from: '2027-01-01', to: '2027-12-31', drafts: true })).rows.length).toBeGreaterThan(total)
    await expect(listMatches(db, { from: '2027-02-01', to: '2027-01-01' })).rejects.toThrow(/before/)
    await expect(listMatches(db, { from: '2027-01-01', to: '2029-01-01' })).rejects.toThrow(/at most/)
  })
})

describe('CSV fixture import', () => {
  it('saves an imported draw on a draft (audited as fixtures.import) and refuses it once published', async () => {
    const v = await season(4, { draft: true })
    const s = v.competition.settings
    const csv = fullCsv(s, v.competition.weeks!)
    const imported = importFixturesCsv(csv, { teams: s.teams, courtNames: v.courts.map((c) => c.name) })
    expect(imported.issues.filter((i) => i.level === 'error')).toEqual([])
    const settings = { ...s, ...imported.settings }
    const r = await saveDraw(
      db,
      admin,
      v.season.id,
      {
        baseUpdatedAt: v.season.updatedAt,
        weeks: imported.weeks,
        generatedFrom: shapeKey(settings),
        edited: true,
        source: 'csv',
        settings: { courts: imported.settings.courts, sessions: imported.settings.sessions, startDate: imported.settings.startDate },
      },
      at(10),
    )
    expect(r.result.issues.filter((i) => i.level === 'error')).toEqual([])
    const entry = await db.select().from(auditLog).where(eq(auditLog.action, 'fixtures.import')).get()
    expect(entry).toMatchObject({ targetId: v.season.id })
    expect(await db.select().from(matches).where(eq(matches.seasonId, v.season.id)).all()).toHaveLength(imported.games)
    const published = await setSeasonStatus(
      db,
      admin,
      v.season.id,
      { baseUpdatedAt: r.result.season.updatedAt, status: 'published' },
      at(11),
    )
    await rejects(
      saveDraw(db, admin, v.season.id, { baseUpdatedAt: published.result.season.updatedAt, weeks: imported.weeks, source: 'csv' }),
      409,
      'draw_locked',
    )
    expect(await db.select().from(matchResults).all()).toEqual([])
  })
})
