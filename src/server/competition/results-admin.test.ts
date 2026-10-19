import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { generate, isTeam, shapeKey, type Result, type Week } from '../../lib/fixtures'
import { createTestDb, type QueryStats, type TestDb } from '../db/testing'
import {
  auditLog,
  courts,
  interestMembers,
  interestProgrammes,
  interests,
  leagues,
  matchDays,
  matches,
  players,
  redirects,
  seasons,
  seasonTeamPlayers,
  seasonTeams,
  teams,
  user,
  venues,
} from '../db/schema'
import { HttpError } from '../http'
import { fixtureRows, ladderRows, toCompetition } from './adapter'
import { moveMatch, undoMoveMatch } from './move'
import { publishResults, saveResults, setMatchDetails, setMatchStatus } from './results'
import { createSeason, getSeason, loadSeason, saveDraw, setSeasonStatus, setSeasonTeams, updateSeason, type SeasonView } from './seasons'
import { createTeam, listTeams, mergeTeams, recentMerges, undoMerge } from './teams'

// Results tab parity (docs/admin.md §1 "Results", "Matches", "Teams and rollover"): outcomes decided by hand, forfeit
// scores and the 1–1 rule per season, a game's referee, moving one game to another night, and merging teams.

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

const NAMES = ['Aces', 'Blockers', 'Chaos', 'Diggers', 'Easy Spikers', 'Floaters', 'Gamers', 'Hitmen']

beforeEach(async () => {
  const t = createTestDb()
  db = t.db
  stats = t.stats
  await db.insert(user).values({ id: 'adm', name: 'adm', email: 'adm@example.com', emailVerified: true, role: 'admin' })
  await db.insert(venues).values([{ id: 'tempe', name: 'Robyn Webster Sports Centre', slug: 'robyn-webster', sort: 0 }])
  await db.insert(courts).values([
    { id: 'c1', venueId: 'tempe', name: 'Court 1', sort: 1 },
    { id: 'c2', venueId: 'tempe', name: 'Court 2', sort: 2 },
    { id: 'c3', venueId: 'tempe', name: 'Court 3', sort: 3 },
  ])
  await db.insert(leagues).values([
    { id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4, defaultVenueId: 'tempe', sort: 0 },
    { id: 'fnl', code: 'FNL', name: 'Friday Night League', slug: 'fnl', weekday: 5, defaultVenueId: 'tempe', sort: 1 },
  ])
})

/** A published season with `n` teams and a generated draw. */
async function season(n: number, opts: { league?: string; quarter?: number; teamIds?: string[] } = {}) {
  const league = opts.league ?? 'tnl'
  let v = await createSeason(db, admin, { leagueId: league, year: 2027, quarter: opts.quarter ?? 1, copyFrom: null }, NOW)
  const ids = opts.teamIds ?? []
  if (!opts.teamIds)
    for (const name of NAMES.slice(0, n)) ids.push((await createTeam(db, admin, { name: `${name} ${league}${opts.quarter ?? 1}` }, NOW)).id)
  v = await setSeasonTeams(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, teamIds: ids }, at(1))
  v = (
    await updateSeason(
      db,
      admin,
      v.season.id,
      { baseUpdatedAt: v.season.updatedAt, settings: { courts: ['Court 1', 'Court 2', 'Court 3'], includeFinals: true } },
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
  return (await setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: saved.result.season.updatedAt, status: 'published' }, at(4)))
    .result
}

const nights = (v: SeasonView) => v.competition.weeks!.filter((w) => w.kind === 'regular')
const sets = (...s: [number, number][]): Result => ({ home: null, away: null, sets: s })
const win = sets([25, 20], [25, 20])

/** Saves `results` (by game id; the rest of the night gets `win`) and publishes the night. */
async function publishNight(v: SeasonView, w: Week, results: Record<string, Result>, when: Date) {
  const all = Object.fromEntries(w.games.map((g) => [g.id, results[g.id] ?? win]))
  const day = await saveResults(db, admin, v.season.id, w.id, { baseUpdatedAt: v.matchDays[w.id]!.updatedAt, results: all }, when)
  await publishResults(db, admin, v.season.id, w.id, { baseUpdatedAt: day.updatedAt }, when)
  return getSeason(db, v.season.id)
}

const team = (v: SeasonView, ref: { team: string } | { label: string }) => (isTeam(ref) ? ref.team : '')
const ladderOf = async (seasonId: string) => {
  const d = await loadSeason(db, seasonId)
  return ladderRows(toCompetition(d), d.adjustments)
}

describe('deciding the outcome by hand', () => {
  it('is saved with its reason, publishes, counts on the ladder and shows on the fixtures', async () => {
    let v = await season(6)
    const w = nights(v)[0]!
    const g = w.games[0]!
    await rejects(
      saveResults(db, admin, v.season.id, w.id, {
        baseUpdatedAt: v.matchDays[w.id]!.updatedAt,
        results: { [g.id]: { ...win, outcome: 'away' } },
      }),
      400,
      'invalid_input',
    )
    v = await publishNight(v, w, { [g.id]: { ...win, outcome: 'away', note: 'Ineligible player' } }, at(10))
    const saved = v.competition.weeks!.find((x) => x.id === w.id)!.games.find((x) => x.id === g.id)!
    expect(saved.publishedResult).toMatchObject({ home: 2, away: 0, outcome: 'away', note: 'Ineligible player' })
    const ladder = await ladderOf(v.season.id)
    expect(ladder.find((r) => r.teamId === team(v, g.away))).toMatchObject({ won: 1, points: 3, setsFor: 0 })
    expect(ladder.find((r) => r.teamId === team(v, g.home))).toMatchObject({ lost: 1, points: 1, setsFor: 2 })
    const row = fixtureRows(toCompetition(await loadSeason(db, v.season.id))).find((r) => r.key === g.id)!
    expect(row.result).toBe('2 - 0')
    expect(row.resultNote).toMatch(/ awarded the win: Ineligible player$/)
  })

  it('can be only an outcome, which shows as W - L', async () => {
    let v = await season(6)
    const w = nights(v)[0]!
    const g = w.games[0]!
    v = await publishNight(v, w, { [g.id]: { home: null, away: null, outcome: 'home', note: 'Walkover' } }, at(10))
    const row = fixtureRows(toCompetition(await loadSeason(db, v.season.id))).find((r) => r.key === g.id)!
    expect(row.result).toBe('W - L')
  })
})

describe('forfeits and the 1–1 rule', () => {
  it('a forfeit gets the season’s score as its draft result, which still publishes like any other', async () => {
    let v = await season(6)
    const w = nights(v)[0]!
    const g = w.games[0]!
    const r = await setMatchStatus(db, admin, v.season.id, w.id, g.id, {
      baseUpdatedAt: v.matchDays[w.id]!.updatedAt,
      status: 'forfeit',
      forfeitedBy: 'home',
    })
    expect(r.result.result).toMatchObject({ home: 0, away: 2, outcome: 'away', note: 'Forfeit' })
    v = await getSeason(db, v.season.id)
    const draft = v.competition.weeks!.find((x) => x.id === w.id)!.games.find((x) => x.id === g.id)!.result
    expect(draft).toMatchObject({
      home: 0,
      away: 2,
      homePoints: 0,
      awayPoints: 50,
      sets: [
        [0, 25],
        [0, 25],
      ],
      outcome: 'away',
    })
    // Publish the rest of the night around it (leaving the forfeit's own draft as it is).
    const others = Object.fromEntries(w.games.filter((x) => x.id !== g.id).map((x) => [x.id, win]))
    const day = await saveResults(db, admin, v.season.id, w.id, { baseUpdatedAt: v.matchDays[w.id]!.updatedAt, results: others })
    await publishResults(db, admin, v.season.id, w.id, { baseUpdatedAt: day.updatedAt })
    let ladder = await ladderOf(v.season.id)
    expect(ladder.find((x) => x.teamId === team(v, g.home))).toMatchObject({ lost: 1, points: 1 })

    // No loss points for forfeiting: a ladder-only setting, so it changes on a published season.
    v = await getSeason(db, v.season.id)
    const rule = { winnerSets: 2, loserSets: 0, winnerSetPoints: 25, loserSetPoints: 0, lossPoints: false }
    await updateSeason(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, settings: { forfeit: rule } })
    ladder = await ladderOf(v.season.id)
    expect(ladder.find((x) => x.teamId === team(v, g.home))).toMatchObject({ lost: 1, points: 0 })
    v = await getSeason(db, v.season.id)
    expect(v.competition.settings.forfeit).toEqual(rule)
    // A rule that doesn't fit the sets per match is refused.
    await rejects(
      updateSeason(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, settings: { forfeit: { ...rule, winnerSets: 3 } } }),
      400,
      'invalid_input',
    )
  })

  it('the 1–1 rule is per season: a draw by default, or decided on points', async () => {
    let v = await season(6)
    const w = nights(v)[0]!
    const g = w.games[0]!
    v = await publishNight(v, w, { [g.id]: sets([25, 20], [18, 25]) }, at(10))
    expect((await ladderOf(v.season.id)).find((x) => x.teamId === team(v, g.away))).toMatchObject({ drawn: 1, points: 2 })
    const r = await updateSeason(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, settings: { levelSets: 'points' } })
    expect(r.result.competition.settings.levelSets).toBe('points')
    expect((await ladderOf(v.season.id)).find((x) => x.teamId === team(v, g.away))).toMatchObject({ won: 1, points: 3 })
    await rejects(updateSeason(db, admin, v.season.id, { baseUpdatedAt: r.result.season.updatedAt, settings: { levelSets: 'coin' } }), 400)
  })
})

describe('the referee', () => {
  it('is set and cleared per game, audited, and shows on the fixtures', async () => {
    const v = await season(6)
    const w = nights(v)[0]!
    const g = w.games[0]!
    const r = await setMatchDetails(db, admin, v.season.id, w.id, g.id, {
      baseUpdatedAt: v.matchDays[w.id]!.updatedAt,
      referee: '  Sam  Lee ',
    })
    expect(r.result.match.referee).toBe('Sam Lee')
    expect(r.purge.tags?.length).toBeGreaterThan(0)
    const d = await loadSeason(db, v.season.id)
    expect(
      toCompetition(d)
        .weeks.find((x) => x.id === w.id)!
        .games.find((x) => x.id === g.id)!.referee,
    ).toBe('Sam Lee')
    expect(fixtureRows(toCompetition(d)).find((x) => x.key === g.id)!.referee).toBe('Sam Lee')
    await rejects(setMatchDetails(db, admin, v.season.id, w.id, g.id, { baseUpdatedAt: v.matchDays[w.id]!.updatedAt, referee: '' }), 409)
    const cleared = await setMatchDetails(db, admin, v.season.id, w.id, g.id, { baseUpdatedAt: r.result.matchDay.updatedAt, referee: null })
    expect(cleared.result.match.referee).toBeNull()
    const log = await db.select().from(auditLog).where(eq(auditLog.action, 'match.update'))
    expect(log).toHaveLength(2)
  })
})

describe('moving one game to another night', () => {
  it('moves a postponed game to a new night, shows it on both, and undoes', async () => {
    let v = await season(6)
    const w = nights(v)[0]!
    const g = w.games[0]!
    await setMatchStatus(db, admin, v.season.id, w.id, g.id, {
      baseUpdatedAt: v.matchDays[w.id]!.updatedAt,
      status: 'postponed',
      note: 'Rain',
    })
    v = await getSeason(db, v.season.id)
    const last = v.competition.weeks!.at(-1)!.date
    stats.reset()
    const r = await moveMatch(db, admin, v.season.id, g.id, {
      baseUpdatedAt: v.season.updatedAt,
      date: '2027-06-03',
      session: 0,
      position: 0,
    })
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(r.result.created).toBe(true)
    v = r.result
    const moved = v.competition.weeks!.find((x) => x.date === '2027-06-03')!
    expect(moved).toMatchObject({ kind: 'regular', matchDay: w.matchDay })
    expect(moved.games.map((x) => x.id)).toEqual([g.id])
    expect(moved.games[0]).toMatchObject({ originalWeekId: w.id })
    expect(v.matches[g.id]).toMatchObject({ status: 'scheduled', statusNote: null, courtId: 'c1' })
    expect(v.competition.weeks!.at(-2)!.date).toBe(last)
    const rows = fixtureRows(toCompetition(await loadSeason(db, v.season.id)))
    expect(rows.find((x) => x.key === g.id)).toMatchObject({ date: '2027-06-03', movedFrom: w.date, kind: 'game' })
    expect(rows.find((x) => x.key === `${w.id}:moved:${g.id}`)).toMatchObject({
      result: 'Moved',
      note: 'Moved to 03/06/2027',
      movedTo: '2027-06-03',
    })
    // Neither night lists the two teams as having a bye.
    const byes = rows.filter((x) => x.kind === 'bye').map((x) => x.teamIds.home)
    expect(byes.filter((t) => t === team(v, g.home) || t === team(v, g.away))).toEqual([])
    expect(rows.filter((x) => x.kind === 'bye' && x.date === '2027-06-03')).toEqual([])

    // A season token is needed; then undo puts it back and removes the catch-up night.
    await rejects(undoMoveMatch(db, admin, v.season.id, g.id, { baseUpdatedAt: 'stale' }), 409, 'conflict')
    v = (await undoMoveMatch(db, admin, v.season.id, g.id, { baseUpdatedAt: v.season.updatedAt })).result
    expect(v.competition.weeks!.some((x) => x.date === '2027-06-03')).toBe(false)
    expect(v.matches[g.id]).toMatchObject({ status: 'postponed', statusNote: 'Rain' })
    expect(v.competition.weeks!.find((x) => x.id === w.id)!.games.some((x) => x.id === g.id)).toBe(true)
    await rejects(undoMoveMatch(db, admin, v.season.id, g.id, { baseUpdatedAt: v.season.updatedAt }), 409, 'cannot_undo')
    const log = await db.select({ action: auditLog.action }).from(auditLog)
    expect(log.map((x) => x.action)).toEqual(expect.arrayContaining(['match.move', 'match.move_undo']))
  })

  it('moves into a free slot on an existing night, and refuses taken slots, drafts and court clashes', async () => {
    let v = await season(6)
    const [first, second] = nights(v) as [Week, Week]
    const g = first.games[0]!
    // 6 teams, 3 courts and (by default) 2 sessions: 3 games a night, so there are free slots.
    const taken = second.games[0]!
    await rejects(
      moveMatch(db, admin, v.season.id, g.id, {
        baseUpdatedAt: v.season.updatedAt,
        toWeekId: second.id,
        session: taken.session,
        position: taken.court,
      }),
      409,
      'cannot_move',
    )
    // Another league at the same venue on that date, on Court 3 at the same time.
    const fnl = await season(4, { league: 'fnl' })
    const fnlNight = nights(fnl)[0]!
    const clashDate = '2027-06-10'
    await db.update(matchDays).set({ date: clashDate }).where(eq(matchDays.id, fnlNight.id))
    const fnlGame = fnlNight.games[0]!
    await db.update(matches).set({ courtId: 'c3', position: 2 }).where(eq(matches.id, fnlGame.id))
    v = await getSeason(db, v.season.id)
    const session = v.competition.settings.sessions.indexOf(fnl.competition.settings.sessions[fnlGame.session]!)
    const e = await rejects(
      moveMatch(db, admin, v.season.id, g.id, {
        baseUpdatedAt: v.season.updatedAt,
        date: clashDate,
        session: Math.max(0, session),
        position: 2,
      }),
      409,
      'cannot_move',
    )
    expect(e.message).toMatch(/court is taken/)
    // An existing night with a free slot: a catch-up night made by moving one game, then a second game joins it.
    const made = (
      await moveMatch(db, admin, v.season.id, g.id, { baseUpdatedAt: v.season.updatedAt, date: '2027-06-17', session: 0, position: 0 })
    ).result
    const catchUp = made.competition.weeks!.find((x) => x.date === '2027-06-17')!
    const h = first.games[1]!
    const joined = (
      await moveMatch(db, admin, v.season.id, h.id, { baseUpdatedAt: made.season.updatedAt, toWeekId: catchUp.id, session: 1, position: 1 })
    ).result
    expect(joined.created).toBe(false)
    expect(joined.competition.weeks!.find((x) => x.id === catchUp.id)!.games.map((x) => x.id)).toEqual([g.id, h.id])
    expect(joined.matches[h.id]).toMatchObject({ courtId: 'c2', startTime: v.competition.settings.sessions[1] })
  })
})

describe('merging teams', () => {
  it('re-points seasons, games, adjustments and groups, leaves feed redirects, and deletes the duplicate', async () => {
    const a = (await createTeam(db, admin, { name: 'Ice Cold' }, NOW)).id
    const b = (await createTeam(db, admin, { name: 'Ice Cold!' }, NOW)).id
    const others = []
    for (const name of ['P', 'Q', 'R']) others.push((await createTeam(db, admin, { name }, NOW)).id)
    await season(4, { quarter: 1, teamIds: [a, ...others] })
    await season(4, { quarter: 2, teamIds: [b, ...others] })
    const gamesOfB = (await db.select().from(matches)).filter((m) => m.homeTeamId === b || m.awayTeamId === b || m.dutyTeamId === b).length
    expect(gamesOfB).toBeGreaterThan(0)
    stats.reset()
    const r = await mergeTeams(db, admin, a, { mergeId: b })
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(r.result).toMatchObject({ team: { id: a, name: 'Ice Cold' }, merged: { id: b, name: 'Ice Cold!' }, seasons: 2 })
    expect(await db.select().from(teams).where(eq(teams.id, b))).toEqual([])
    const rows = await db.select().from(matches)
    expect(rows.some((m) => m.homeTeamId === b || m.awayTeamId === b || m.dutyTeamId === b)).toBe(false)
    expect((await db.select().from(seasonTeams).where(eq(seasonTeams.teamId, a))).length).toBe(2)
    expect(await db.select({ from: redirects.fromPath, to: redirects.toPath }).from(redirects)).toEqual([
      { from: '/leagues/tnl/teams/ice-cold-2.ics', to: '/leagues/tnl/teams/ice-cold.ics' },
    ])
    const list = await listTeams(db)
    expect(list.find((t) => t.id === a)).toMatchObject({ seasons: 2 })
    expect(list.find((t) => t.id === a)!.history.map((h) => h.leagueCode)).toEqual(['TNL', 'TNL'])
  })

  it('can be undone from its audit row: B, its seasons, games, feeds and draw keys come back exactly', async () => {
    const a = (await createTeam(db, admin, { name: 'Ice Cold' }, NOW)).id
    const b = (await createTeam(db, admin, { name: 'Ice Cold!' }, NOW)).id
    await db.update(teams).set({ wpId: 77 }).where(eq(teams.id, b))
    const others = []
    for (const name of ['P', 'Q', 'R']) others.push((await createTeam(db, admin, { name }, NOW)).id)
    const first = await season(4, { quarter: 1, teamIds: [a, ...others] })
    const second = await season(4, { quarter: 2, teamIds: [b, ...others] })
    // Rosters: A's in Q1, B's in Q2, and a team EOI placed into B.
    await db.insert(players).values([
      { id: 'pa', pool: 'competition', firstName: 'Ann', lastName: 'A', email: 'pa@example.com' },
      { id: 'pb', pool: 'competition', firstName: 'Ben', lastName: 'B', email: 'pb@example.com' },
    ])
    await db.insert(seasonTeamPlayers).values([
      { seasonId: first.season.id, teamId: a, playerId: 'pa', role: 'captain' },
      { seasonId: second.season.id, teamId: b, playerId: 'pb' },
      { seasonId: second.season.id, teamId: b, playerId: 'pa', sort: 1 },
    ])
    await db.insert(interests).values({ id: 'eoi', kind: 'team', reference: 'EOI-AAAA', teamName: 'Ice Cold!' })
    await db
      .insert(interestMembers)
      .values({ interestId: 'eoi', playerId: 'pb', role: 'captain', details: { firstName: 'Ben', lastName: 'B' } as never })
    await db
      .insert(interestProgrammes)
      .values({
        interestId: 'eoi',
        programmeId: 'tnl',
        status: 'placed',
        seasonId: second.season.id,
        teamId: b,
        createdAt: NOW.toISOString(),
      })
    // A redirect that already led to B's feed (an earlier merge into B).
    await db
      .insert(redirects)
      .values({ fromPath: '/leagues/tnl/teams/old.ics', toPath: '/leagues/tnl/teams/ice-cold-2.ics', source: 'manual' })
    const snapshot = async () => ({
      teams: await db.select({ id: teams.id, name: teams.name, slug: teams.slug, wpId: teams.wpId }).from(teams).orderBy(teams.id),
      members: await db
        .select({ s: seasonTeams.seasonId, t: seasonTeams.teamId })
        .from(seasonTeams)
        .orderBy(seasonTeams.seasonId, seasonTeams.teamId),
      games: await db
        .select({ id: matches.id, h: matches.homeTeamId, a: matches.awayTeamId, d: matches.dutyTeamId })
        .from(matches)
        .orderBy(matches.id),
      redirects: await db.select({ from: redirects.fromPath, to: redirects.toPath }).from(redirects).orderBy(redirects.fromPath),
      keys: await db.select({ id: seasons.id, g: seasons.generatedFrom }).from(seasons).orderBy(seasons.id),
      rosters: await db
        .select({ s: seasonTeamPlayers.seasonId, t: seasonTeamPlayers.teamId, p: seasonTeamPlayers.playerId, r: seasonTeamPlayers.role })
        .from(seasonTeamPlayers)
        .orderBy(seasonTeamPlayers.seasonId, seasonTeamPlayers.playerId),
      placed: await db.select({ t: interestProgrammes.teamId, s: interestProgrammes.status }).from(interestProgrammes),
    })
    const before = await snapshot()
    await mergeTeams(db, admin, a, { mergeId: b }, at(1))
    // B's roster and EOI placement now belong to A (nothing lost to B's delete cascading).
    expect((await db.select().from(seasonTeamPlayers).where(eq(seasonTeamPlayers.teamId, a))).length).toBe(3)
    expect(await db.select({ t: interestProgrammes.teamId }).from(interestProgrammes)).toEqual([{ t: a }])
    // The draw key follows the merge, so B's season doesn't say "Settings changed".
    const merged = await getSeason(db, second.season.id)
    expect(merged.competition.generatedFrom).toBe(shapeKey(merged.competition.settings))
    expect((await getSeason(db, first.season.id)).competition.generatedFrom).toBe(first.competition.generatedFrom)

    const [recent] = await recentMerges(db, at(2))
    expect(recent).toMatchObject({ kept: { id: a, name: 'Ice Cold' }, merged: { id: b, name: 'Ice Cold!' }, blocked: null })
    stats.reset()
    const r = await undoMerge(db, admin, recent!.auditId, at(3))
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(r.result).toMatchObject({ team: { id: b, name: 'Ice Cold!' }, kept: { id: a } })
    expect(await snapshot()).toEqual(before)
    expect((await getSeason(db, second.season.id)).competition.generatedFrom).toBe(second.competition.generatedFrom)
    const undoRow = await db.select().from(auditLog).where(eq(auditLog.action, 'team.merge_undo')).get()
    expect(undoRow).toMatchObject({ targetId: b, after: { mergeAuditId: recent!.auditId } })

    // Once undone, it can't be applied again, and the list says so.
    expect((await recentMerges(db, at(4)))[0]!.blocked).toMatch(/Already undone/)
    await rejects(undoMerge(db, admin, recent!.auditId, at(4)), 409, 'cannot_undo')
  })

  it('refuses to undo after 30 days, or when another team took the name', async () => {
    const a = (await createTeam(db, admin, { name: 'Spikers' }, NOW)).id
    const b = (await createTeam(db, admin, { name: 'Spikers 2' }, NOW)).id
    await mergeTeams(db, admin, a, { mergeId: b }, NOW)
    const [m] = await recentMerges(db, NOW)
    const later = new Date(NOW.getTime() + 31 * 86_400_000)
    expect(await recentMerges(db, later)).toEqual([])
    await rejects(undoMerge(db, admin, m!.auditId, later), 409, 'cannot_undo')
    await createTeam(db, admin, { name: 'Spikers 2' }, at(5))
    const e = await rejects(undoMerge(db, admin, m!.auditId, at(6)), 409, 'cannot_undo')
    expect(e.message).toMatch(/web address|Rename it first/)
  })

  it('refuses teams that played in the same season', async () => {
    const v = await season(4)
    const [x, y] = v.competition.settings.teams
    const e = await rejects(mergeTeams(db, admin, x!.id, { mergeId: y!.id }), 409, 'same_season')
    expect(e.message).toMatch(/both played in TNL Q1 2027/)
    await rejects(mergeTeams(db, admin, x!.id, { mergeId: x!.id }), 400)
  })
})
