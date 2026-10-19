import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  courtClashes,
  generate,
  publishWeekResults,
  setCourt,
  setResult,
  shapeKey,
  standings,
  type Settings,
  type Week,
} from '../../lib/fixtures'
import { createTestDb, type QueryStats, type TestDb } from '../db/testing'
import {
  auditLog,
  redirects,
  courts,
  leagues,
  matchDays,
  matches,
  matchResults,
  seasons,
  seasonTeams,
  teams,
  user,
  venues,
  type NewMatch,
} from '../db/schema'
import { HttpError } from '../http'
import { tags } from '../cache'
import { loadSite } from '../site'
import { ladderRows, toCompetition } from './adapter'
import { addAdjustment, deleteAdjustment, updateAdjustment } from './adjustments'
import { clashDraws } from './clashes'
import { chunkByParams } from './draw'
import { publishResults, saveResults, setMatchStatus, undoResults } from './results'
import {
  createSeason,
  deleteSeason,
  firstGameNight,
  getSeason,
  listLeagues,
  loadSeason,
  saveDraw,
  setSeasonStatus,
  setSeasonTeams,
  updateSeason,
  type SeasonView,
} from './seasons'
import { createTeam, listTeams, renameTeam } from './teams'

const NOW = new Date('2026-10-18T00:00:00.000Z')
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000)

let db: TestDb
let stats: QueryStats
let admin: { id: string; ip: string }

const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpError)
  expect({ status: (e as HttpError).status, code: (e as HttpError).code }).toEqual({ status, code: code ?? (e as HttpError).code })
  return e as HttpError
}

/** Tempe's three courts, a Five Dock "Court 1" (same name, other venue), TNL and SNL at Tempe, SAL at Five Dock. */
async function seedPlaces() {
  await db.insert(user).values({ id: 'adm', name: 'adm', email: 'adm@example.com', emailVerified: true, role: 'admin' })
  admin = { id: 'adm', ip: '203.0.113.9' }
  await db.insert(venues).values([
    { id: 'tempe', name: 'Robyn Webster Sports Centre', slug: 'robyn-webster', sort: 0 },
    { id: 'fivedock', name: 'Five Dock Leisure Centre', slug: 'five-dock', sort: 1 },
  ])
  await db.insert(courts).values([
    { id: 'fd1', venueId: 'fivedock', name: 'Court 1', sort: 0 },
    { id: 'c1', venueId: 'tempe', name: 'Court 1', sort: 1 },
    { id: 'c2', venueId: 'tempe', name: 'Court 2', sort: 2 },
    { id: 'c3', venueId: 'tempe', name: 'Court 3', sort: 3 },
  ])
  await db.insert(leagues).values([
    { id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4, defaultVenueId: 'tempe', sort: 0 },
    { id: 'snl', code: 'SNL', name: 'Saturday Night League', slug: 'snl', weekday: 4, defaultVenueId: 'tempe', sort: 2 },
    { id: 'sal', code: 'SAL', name: 'Sunday Afternoon League', slug: 'sal', weekday: 0, defaultVenueId: 'fivedock', sort: 3 },
    { id: 'tvsl', code: 'TVSL', name: 'Super League', slug: 'tvsl', weekday: 0, defaultVenueId: 'tempe', format: 'super', sort: 4 },
  ])
}

const TEAM_NAMES = [
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

async function addTeams(n: number) {
  const ids: string[] = []
  for (const name of TEAM_NAMES.slice(0, n)) ids.push((await createTeam(db, admin, { name }, NOW)).id)
  return ids
}

/** A draft TNL season with `n` teams and the 12-team-friendly settings (3 courts x 2 sessions), ready to generate. */
async function draftSeason(n: number, opts: { quarter?: number } = {}) {
  let v = await createSeason(db, admin, { leagueId: 'tnl', year: 2027, quarter: opts.quarter ?? 1, copyFrom: null }, NOW)
  const ids = await addTeams(n)
  v = await setSeasonTeams(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, teamIds: ids }, at(1))
  v = (
    await updateSeason(
      db,
      admin,
      v.season.id,
      { baseUpdatedAt: v.season.updatedAt, settings: { courts: ['Court 1', 'Court 2', 'Court 3'] } },
      at(2),
    )
  ).result
  return v
}

/** What the browser does: generate the draw from the season's settings and save it. */
async function generateAndSave(v: SeasonView, when = at(3)) {
  const s = v.competition.settings
  const weeks = generate(s)
  const res = await saveDraw(
    db,
    admin,
    v.season.id,
    { baseUpdatedAt: v.season.updatedAt, weeks, generatedFrom: shapeKey(s), edited: false },
    when,
  )
  return { weeks, res }
}

const plain = (weeks: Week[]) =>
  weeks.map((w) => ({
    id: w.id,
    kind: w.kind,
    date: w.date,
    matchDay: w.matchDay,
    note: w.note,
    courtOverrides: w.courtOverrides && Object.keys(w.courtOverrides).length ? w.courtOverrides : undefined,
    games: w.games
      .map((g) => ({ id: g.id, session: g.session, court: g.court, home: g.home, away: g.away, duty: g.duty, title: g.title }))
      .toSorted((a, b) => a.id.localeCompare(b.id)),
  }))

beforeEach(async () => {
  const t = createTestDb()
  db = t.db
  stats = t.stats
  await seedPlaces()
})

describe('creating seasons', () => {
  it('creates a blank draft with the league format’s defaults and the first game night of the quarter', async () => {
    const v = await createSeason(db, admin, { leagueId: 'tnl', year: 2027, quarter: 1, copyFrom: null }, NOW)
    expect(v.season).toMatchObject({
      name: 'TNL Q1 2027',
      slug: 'tnl-q1-2027',
      status: 'draft',
      startDate: '2027-01-07',
      setsPerMatch: 2,
      dutyEnabled: true,
    })
    expect(v.competition).toMatchObject({ weeks: null, status: 'draft', edited: false })
    expect(v.competition.settings).toMatchObject({
      courts: ['Court 1', 'Court 2'],
      sessions: ['20:00', '21:00'],
      sessionMinutes: 60,
      teams: [],
      duty: true,
    })
    expect(v.courts.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    const tvsl = await createSeason(db, admin, { leagueId: 'tvsl', year: 2027, quarter: 1, copyFrom: null }, NOW)
    expect(tvsl.season).toMatchObject({ setsPerMatch: 5, dutyEnabled: false })
    expect(tvsl.competition.settings).toMatchObject({ sessionMinutes: 90, duty: false })
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'season.create')).all()
    expect(entry).toMatchObject({ actorUserId: 'adm', targetType: 'season', targetId: v.season.id })
  })

  it('copies teams and settings from the league’s latest season, with a new seed and no skip dates', async () => {
    const q1 = await draftSeason(4)
    const before = await updateSeason(
      db,
      admin,
      q1.season.id,
      {
        baseUpdatedAt: q1.season.updatedAt,
        settings: {
          sessions: ['19:00', '20:00'],
          skipDates: [{ date: '2027-01-28', reason: 'Australia Day' }],
          points: { win: 4, draw: 2, loss: 1 },
        },
      },
      at(5),
    )
    const q2 = await createSeason(db, admin, { leagueId: 'tnl', year: 2027, quarter: 2 }, at(6))
    expect(q2.season.startDate).toBe('2027-04-01')
    expect(q2.competition.settings.teams.map((t) => t.name)).toEqual(before.result.competition.settings.teams.map((t) => t.name))
    expect(q2.competition.settings).toMatchObject({
      sessions: ['19:00', '20:00'],
      courts: ['Court 1', 'Court 2', 'Court 3'],
      skipDates: [],
      points: { win: 4, draw: 2, loss: 1 },
    })
    expect(q2.competition.settings.seed).not.toBe(before.result.competition.settings.seed)
  })

  it('refuses duplicates and bad input', async () => {
    await createSeason(db, admin, { leagueId: 'tnl', year: 2027, quarter: 1 }, NOW)
    await rejects(createSeason(db, admin, { leagueId: 'tnl', year: 2027, quarter: 1 }, NOW), 409, 'season_exists')
    await rejects(createSeason(db, admin, { leagueId: 'nope', year: 2027, quarter: 2 }, NOW), 400)
    await rejects(createSeason(db, admin, { leagueId: 'tnl', year: 2027, quarter: 5 }, NOW), 400)
    await rejects(createSeason(db, admin, { leagueId: 'tnl', year: 2027, quarter: 3, startDate: '2027-02-30' }, NOW), 400)
    expect(await db.select().from(seasons).all()).toHaveLength(1)
  })

  it('finds the first game night of a quarter', () => {
    expect(firstGameNight(2027, 1, 4)).toBe('2027-01-07') // Thursday
    expect(firstGameNight(2026, 4, 4)).toBe('2026-10-01')
    expect(firstGameNight(2027, 3, 0)).toBe('2027-07-04') // Sunday
  })

  it('lists leagues with their venue courts and seasons, newest first', async () => {
    await createSeason(db, admin, { leagueId: 'tnl', year: 2027, quarter: 1 }, NOW)
    await createSeason(db, admin, { leagueId: 'tnl', year: 2027, quarter: 2 }, NOW)
    const list = await listLeagues(db)
    const tnl = list.find((l) => l.id === 'tnl')!
    expect(tnl.venue?.name).toBe('Robyn Webster Sports Centre')
    expect(tnl.courts.map((c) => c.name)).toEqual(['Court 1', 'Court 2', 'Court 3'])
    expect(tnl.seasons.map((s) => s.slug)).toEqual(['tnl-q2-2027', 'tnl-q1-2027'])
  })

  it('deletes drafts only', async () => {
    const v = await createSeason(db, admin, { leagueId: 'tnl', year: 2027, quarter: 1 }, NOW)
    await rejects(deleteSeason(db, admin, v.season.id, { baseUpdatedAt: 'stale' }), 409, 'conflict')
    await deleteSeason(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt })
    await rejects(getSeason(db, v.season.id), 404)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'season.delete')).all()).toHaveLength(1)
  })
})

describe('the draw', () => {
  it('saves a realistic 12-team season within D1’s per-request limits, and reads it back unchanged', async () => {
    const v = await draftSeason(12)
    const s = v.competition.settings
    const weeks = generate(s)
    const games = weeks.reduce((n, w) => n + w.games.length, 0)
    expect(games).toBe(70) // 11 rounds x 6 + 4 finals
    stats.reset()
    const { result } = await saveDraw(
      db,
      admin,
      v.season.id,
      { baseUpdatedAt: v.season.updatedAt, weeks, generatedFrom: shapeKey(s), edited: false },
      at(3),
    )
    // + 1 for requireRole's fresh role read in the route.
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(stats.queries).toBeLessThanOrEqual(30)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(result.issues.filter((i) => i.level === 'error')).toEqual([])

    const back = await getSeason(db, v.season.id)
    expect(plain(back.competition.weeks!)).toEqual(plain(weeks))
    expect(back.competition.generatedFrom).toBe(shapeKey(back.competition.settings))
    expect(back.season.updatedAt).toBe(result.season.updatedAt)
    expect(Object.keys(back.matchDays)).toEqual(weeks.map((w) => w.id))
    const rows = await db.select().from(matches).where(eq(matches.seasonId, v.season.id)).all()
    expect(rows.every((m) => m.startTime === s.sessions[m.session] && m.courtId === ['c1', 'c2', 'c3'][m.position])).toBe(true)
  })

  it('stays under the limits for the biggest season the API accepts', async () => {
    const v = await draftSeason(12)
    const s: Settings = { ...v.competition.settings, meetings: 2 }
    const saved = await updateSeason(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, settings: { meetings: 2 } }, at(3))
    const weeks = generate(s)
    expect(weeks.reduce((n, w) => n + w.games.length, 0)).toBe(136)
    stats.reset()
    await saveDraw(db, admin, v.season.id, { baseUpdatedAt: saved.result.season.updatedAt, weeks, generatedFrom: shapeKey(s) }, at(4))
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
  })

  it('chunks multi-row inserts by bound parameters', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ a: i, b: 'x', c: undefined as number | undefined, d: i % 2 ? 1 : undefined }))
    const chunks = chunkByParams(rows, 10)
    expect(chunks.flat()).toHaveLength(30)
    for (const c of chunks)
      expect(c.reduce((n, r) => n + Object.values(r).filter((x) => x !== undefined).length, 0)).toBeLessThanOrEqual(10)
  })

  it('refuses stale saves, bad shapes, outsiders and draws with errors', async () => {
    const v = await draftSeason(4)
    const s = v.competition.settings
    const weeks = generate(s)
    await rejects(saveDraw(db, admin, v.season.id, { weeks }), 400)
    await rejects(saveDraw(db, admin, v.season.id, { baseUpdatedAt: 'old', weeks }), 409, 'conflict')
    await rejects(saveDraw(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, weeks: [{ id: 'x' }] }), 400)
    // A team that isn't in the season.
    const outsider = structuredClone(weeks)
    outsider[0]!.games[0]!.home = { team: 'someone-else' }
    const e = await rejects(saveDraw(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, weeks: outsider }), 422, 'invalid_draw')
    expect(e.details?.issues).toEqual(expect.arrayContaining([expect.objectContaining({ level: 'error' })]))
    // A court that doesn't exist.
    const unknown = setCourt(weeks, s, weeks[0]!.id, 0, 0, 'Court 9')
    await rejects(saveDraw(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, weeks: unknown }), 400)
    // Duplicate ids.
    const dup = structuredClone(weeks)
    dup[1]!.games[0]!.id = dup[0]!.games[0]!.id
    await rejects(saveDraw(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, weeks: dup }), 400)
  })

  it('refuses a court change that puts two games on one court at once', async () => {
    const v = await draftSeason(8)
    const s = v.competition.settings
    const weeks = generate(s)
    const w = weeks.find((x) => x.kind === 'regular' && x.games.some((a) => x.games.some((b) => b !== a && b.session === a.session)))!
    const a = w.games.find((x) => w.games.some((y) => y !== x && y.session === x.session))!
    const b = w.games.find((y) => y !== a && y.session === a.session)!
    const clash = setCourt(weeks, s, w.id, b.session, b.court, s.courts[a.court]!)
    const e = await rejects(saveDraw(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, weeks: clash }), 422, 'invalid_draw')
    expect(e.message).toMatch(/two games on/)
  })

  it('maps court overrides to court ids, preferring the league’s venue for ambiguous names', async () => {
    const v = await draftSeason(4)
    const s = v.competition.settings
    let weeks = generate(s)
    const w0 = weeks[0]!
    const g = w0.games[0]!
    weeks = setCourt(weeks, s, w0.id, g.session, g.court, 'Court 3')
    await saveDraw(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, weeks, generatedFrom: shapeKey(s) }, at(3))
    const day = await db.select().from(matchDays).where(eq(matchDays.id, w0.id)).get()
    expect(day!.courtOverrides).toEqual({ [`${g.session}:${g.court}`]: 'c3' })
    expect((await db.select().from(matches).where(eq(matches.id, g.id)).get())!.courtId).toBe('c3')
    const back = await getSeason(db, v.season.id)
    expect(back.competition.weeks![0]!.courtOverrides).toEqual({ [`${g.session}:${g.court}`]: 'Court 3' })
    // "Court 1" means Tempe's, not Five Dock's.
    expect((await loadSeason(db, v.season.id)).season.settings.defaultCourtIds[0]).toBe('c1')
  })

  it('saves settings and re-laid weeks together, and clears a draw', async () => {
    const v = await draftSeason(4)
    const { res } = await generateAndSave(v)
    const s = { ...v.competition.settings, startDate: '2027-01-14' }
    const weeks = generate(s)
    const saved = await saveDraw(
      db,
      admin,
      v.season.id,
      { baseUpdatedAt: res.result.season.updatedAt, weeks, generatedFrom: shapeKey(s), settings: { startDate: '2027-01-14' } },
      at(4),
    )
    expect(saved.result.season.startDate).toBe('2027-01-14')
    expect((await getSeason(db, v.season.id)).competition.weeks![0]!.date).toBe('2027-01-14')
    await saveDraw(db, admin, v.season.id, { baseUpdatedAt: saved.result.season.updatedAt, weeks: null }, at(5))
    const cleared = await getSeason(db, v.season.id)
    expect(cleared.competition.weeks).toBeNull()
    expect(cleared.season.generatedFrom).toBeNull()
  })

  it('changes team membership on drafts only', async () => {
    const v = await draftSeason(4)
    const extra = (await createTeam(db, admin, { name: 'Newbies' }, NOW)).id
    const ids = [...v.competition.settings.teams.map((t) => t.id), extra]
    const more = await setSeasonTeams(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, teamIds: ids }, at(5))
    expect(more.competition.settings.teams.map((t) => t.name)).toEqual(['Aces', 'Blockers', 'Chaos', 'Diggers', 'Newbies'])
    await rejects(setSeasonTeams(db, admin, v.season.id, { baseUpdatedAt: more.season.updatedAt, teamIds: ['missing'] }), 400)
    await rejects(setSeasonTeams(db, admin, v.season.id, { baseUpdatedAt: more.season.updatedAt, teamIds: [ids[0], ids[0]] }), 400)
    // Settings can't sneak a different team list in.
    await rejects(updateSeason(db, admin, v.season.id, { baseUpdatedAt: more.season.updatedAt, settings: { teams: [ids[0]] } }), 400)
  })
})

describe('publishing a season', () => {
  it('needs a current, valid draw; then locks it, apart from courts and session times', async () => {
    let v = await draftSeason(4)
    await rejects(setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, status: 'published' }), 422, 'not_ready')
    const { weeks, res } = await generateAndSave(v)
    v = await getSeason(db, v.season.id)
    // Stale: a team was added after generating.
    const t = await createTeam(db, admin, { name: 'Late Entry' }, NOW)
    const stale = await setSeasonTeams(
      db,
      admin,
      v.season.id,
      { baseUpdatedAt: res.result.season.updatedAt, teamIds: [...v.competition.settings.teams.map((x) => x.id), t.id] },
      at(4),
    )
    const e = await rejects(
      setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: stale.season.updatedAt, status: 'published' }),
      422,
      'not_ready',
    )
    expect(e.message).toMatch(/Regenerate/)
    v = await setSeasonTeams(
      db,
      admin,
      v.season.id,
      { baseUpdatedAt: stale.season.updatedAt, teamIds: v.competition.settings.teams.map((x) => x.id) },
      at(5),
    )

    const published = await setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, status: 'published' }, at(6))
    expect(published.result.season).toMatchObject({ status: 'published', publishedAt: at(6).toISOString() })
    expect(published.purge.tags).toEqual([tags.season('tnl-q1-2027'), tags.league('tnl'), tags.site])
    v = published.result

    // The draw is locked…
    const flipped = structuredClone(weeks)
    const g0 = flipped[0]!.games[0]!
    ;[g0.home, g0.away] = [g0.away, g0.home]
    await rejects(saveDraw(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, weeks: flipped }), 409, 'draw_locked')
    await rejects(setSeasonTeams(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, teamIds: [] }), 409, 'draw_locked')
    await rejects(
      updateSeason(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, settings: { meetings: 2 } }),
      409,
      'draw_locked',
    )
    await rejects(
      updateSeason(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, settings: { sessions: ['20:00'] } }),
      409,
      'draw_locked',
    )
    await rejects(
      updateSeason(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, settings: { startDate: '2027-01-14' } }),
      409,
      'draw_locked',
    )

    // …but courts and times can move. Results stay attached (same ids).
    const w0 = v.competition.weeks![0]!
    const g = w0.games[0]!
    // A court nobody else uses in that session, so it can't clash.
    const taken = new Set(w0.games.filter((x) => x.session === g.session).map((x) => v.competition.settings.courts[x.court]))
    const free = v.competition.settings.courts.find((name) => !taken.has(name))!
    const moved = setCourt(v.competition.weeks!, v.competition.settings, w0.id, g.session, g.court, free)
    const saved = await saveDraw(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, weeks: moved }, at(7))
    expect(saved.result.matchDays[w0.id]!.updatedAt).toBe(at(7).toISOString())
    const w1 = v.competition.weeks![1]!.id
    expect(saved.result.matchDays[w1]!.updatedAt).toBe(v.matchDays[w1]!.updatedAt)
    expect((await db.select().from(matches).where(eq(matches.id, g.id)).get())!.courtId).toBe(
      { 'Court 1': 'c1', 'Court 2': 'c2', 'Court 3': 'c3' }[free],
    )
    v = await getSeason(db, v.season.id)
    const timed = await updateSeason(
      db,
      admin,
      v.season.id,
      { baseUpdatedAt: v.season.updatedAt, settings: { sessions: ['19:30', '20:30'], courts: ['Court 2', 'Court 1', 'Court 3'] } },
      at(8),
    )
    const rows = await db.select().from(matches).where(eq(matches.seasonId, v.season.id)).all()
    expect(new Set(rows.map((m) => m.startTime))).toEqual(new Set(['19:30', '20:30']))
    expect(rows.filter((m) => m.position === 1).every((m) => m.courtId === 'c1' || m.courtId === 'c3')).toBe(true)
    expect(timed.result.competition.settings.courts).toEqual(['Court 2', 'Court 1', 'Court 3'])
  })

  it('unpublishes only before results, archives, and keeps archived seasons read-only', async () => {
    let v = await draftSeason(4)
    const { res } = await generateAndSave(v)
    v = (await setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: res.result.season.updatedAt, status: 'published' }, at(4))).result
    v = (await setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, status: 'draft' }, at(5))).result
    expect(v.season).toMatchObject({ status: 'draft', publishedAt: null })
    v = (await setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, status: 'published' }, at(6))).result

    const day = v.competition.weeks!.find((w) => w.kind === 'regular')!
    await saveResults(
      db,
      admin,
      v.season.id,
      day.id,
      {
        baseUpdatedAt: v.matchDays[day.id]!.updatedAt,
        results: { [day.games[0]!.id]: { home: 2, away: 0, homePoints: 50, awayPoints: 30 } },
      },
      at(7),
    )
    await rejects(setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, status: 'draft' }), 409, 'has_results')
    await rejects(setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, status: 'nope' }), 400)

    v = (await setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, status: 'archived' }, at(8))).result
    expect(v.competition.status).toBe('published')
    expect(v.season.status).toBe('archived')
    const fresh = await getSeason(db, v.season.id)
    await rejects(
      updateSeason(db, admin, v.season.id, { baseUpdatedAt: fresh.season.updatedAt, settings: { name: 'x' } }),
      409,
      'season_archived',
    )
    await rejects(
      saveDraw(db, admin, v.season.id, { baseUpdatedAt: fresh.season.updatedAt, weeks: fresh.competition.weeks }),
      409,
      'season_archived',
    )
    await rejects(
      saveResults(db, admin, v.season.id, day.id, { baseUpdatedAt: fresh.matchDays[day.id]!.updatedAt, results: {} }),
      409,
      'season_archived',
    )
    await rejects(
      addAdjustment(db, admin, v.season.id, { teamId: fresh.competition.settings.teams[0]!.id, points: -1, reason: 'x' }),
      409,
      'season_archived',
    )
    v = (await setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: fresh.season.updatedAt, status: 'published' }, at(9))).result
    expect(v.season.status).toBe('published')
    const actions = (await db.select({ action: auditLog.action }).from(auditLog).all()).map((r) => r.action)
    expect(actions).toEqual(
      expect.arrayContaining(['season.publish', 'season.unpublish', 'season.archive', 'season.unarchive', 'season.draw_save']),
    )
  })
})

describe('results', () => {
  async function publishedSeason(n = 4) {
    let v = await draftSeason(n)
    const { res } = await generateAndSave(v)
    v = (await setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: res.result.season.updatedAt, status: 'published' }, at(4))).result
    return v
  }

  it('refuses results on a draft season', async () => {
    const v = await draftSeason(4)
    const { weeks } = await generateAndSave(v)
    const fresh = await getSeason(db, v.season.id)
    await rejects(
      saveResults(db, admin, v.season.id, weeks[0]!.id, { baseUpdatedAt: fresh.matchDays[weeks[0]!.id]!.updatedAt, results: {} }),
      409,
      'season_not_published',
    )
    expect(await db.select().from(matchResults).all()).toEqual([])
  })

  it('enters, checks, publishes and undoes one match day, and the ladder follows', async () => {
    const v = await publishedSeason(4)
    const day = v.competition.weeks!.find((w) => w.kind === 'regular')!
    const [g1, g2] = day.games
    let token = v.matchDays[day.id]!.updatedAt

    await rejects(
      saveResults(db, admin, v.season.id, day.id, {
        baseUpdatedAt: token,
        results: {
          [g1!.id]: {
            sets: [
              [25, 20],
              [25, 18],
              [25, 10],
            ],
          },
        },
      }),
      400,
    )
    await rejects(saveResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token, results: { [g1!.id]: { home: 3, away: 0 } } }), 400)
    await rejects(saveResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token, results: { [g1!.id]: { sets: [[25, -1]] } } }), 400)
    await rejects(saveResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token, results: { 'other-match': null } }), 400)
    await rejects(saveResults(db, admin, v.season.id, day.id, { baseUpdatedAt: 'stale', results: {} }), 409, 'conflict')

    // One game in: not publishable yet.
    token = (
      await saveResults(
        db,
        admin,
        v.season.id,
        day.id,
        {
          baseUpdatedAt: token,
          results: {
            [g1!.id]: {
              sets: [
                [25, 20],
                [18, 25],
              ],
            },
          },
        },
        at(10),
      )
    ).updatedAt
    const e = await rejects(publishResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token }), 422, 'not_ready')
    expect(e.message).toMatch(/remaining game/)
    stats.reset()
    token = (
      await saveResults(
        db,
        admin,
        v.season.id,
        day.id,
        { baseUpdatedAt: token, results: { [g2!.id]: { home: 2, away: 0, homePoints: 50, awayPoints: 31 } } },
        at(11),
      )
    ).updatedAt
    expect(stats.queries + 1).toBeLessThanOrEqual(50)

    const draft = await db.select().from(matchResults).where(eq(matchResults.matchId, g1!.id)).all()
    expect(draft).toEqual([
      expect.objectContaining({
        kind: 'draft',
        homeSets: 1,
        awaySets: 1,
        homePoints: 43,
        awayPoints: 45,
        setScores: [
          [25, 20],
          [18, 25],
        ],
      }),
    ])
    // Nothing public yet.
    expect(
      standings((await getSeason(db, v.season.id)).competition.settings, (await getSeason(db, v.season.id)).competition.weeks!).every(
        (r) => r.played === 0,
      ),
    ).toBe(true)

    stats.reset()
    const pub = await publishResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token }, at(12))
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(pub.result).toEqual({ id: day.id, updatedAt: at(12).toISOString(), resultsPublishedAt: at(12).toISOString() })
    expect(pub.purge.tags).toEqual([tags.season('tnl-q1-2027'), tags.league('tnl'), tags.site])
    const after = await getSeason(db, v.season.id)
    const ladder = ladderRows(after.competition as { settings: Settings; weeks: Week[] }, after.adjustments)
    expect(ladder.reduce((n, r) => n + r.played, 0)).toBe(4)
    expect((await db.select().from(matches).where(eq(matches.id, g2!.id)).get())!.status).toBe('played')
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'results.publish')).all()
    expect(audit).toHaveLength(1)

    // Edit after publishing, then throw the edit away.
    token = (
      await saveResults(db, admin, v.season.id, day.id, { baseUpdatedAt: pub.result.updatedAt, results: { [g2!.id]: null } }, at(13))
    ).updatedAt
    expect(await db.select().from(matchResults).where(eq(matchResults.matchId, g2!.id)).all()).toHaveLength(1)
    await undoResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token }, at(14))
    const restored = await getSeason(db, v.season.id)
    const g2back = restored.competition.weeks!.find((w) => w.id === day.id)!.games.find((g) => g.id === g2!.id)!
    expect(g2back.result).toEqual(g2back.publishedResult)
    expect(g2back.publishedResult).toMatchObject({ home: 2, away: 0 })
  })

  it('takes best-of-5 sets in the Super League', async () => {
    let v = await createSeason(db, admin, { leagueId: 'tvsl', year: 2027, quarter: 1, copyFrom: null }, NOW)
    const ids = await addTeams(4)
    v = await setSeasonTeams(db, admin, v.season.id, { baseUpdatedAt: v.season.updatedAt, teamIds: ids }, at(1))
    const { res } = await generateAndSave(v)
    expect(res.result.issues.filter((i) => i.level === 'error')).toEqual([])
    v = (await setSeasonStatus(db, admin, v.season.id, { baseUpdatedAt: res.result.season.updatedAt, status: 'published' }, at(4))).result
    const day = v.competition.weeks!.find((w) => w.kind === 'regular')!
    expect(day.games.every((g) => g.duty === null)).toBe(true)
    const r = await saveResults(
      db,
      admin,
      v.season.id,
      day.id,
      {
        baseUpdatedAt: v.matchDays[day.id]!.updatedAt,
        results: {
          [day.games[0]!.id]: {
            sets: [
              [25, 20],
              [20, 25],
              [25, 22],
              [23, 25],
              [15, 10],
            ],
          },
        },
      },
      at(5),
    )
    expect(r.updatedAt).toBe(at(5).toISOString())
    await rejects(
      saveResults(db, admin, v.season.id, day.id, {
        baseUpdatedAt: r.updatedAt,
        results: {
          [day.games[0]!.id]: {
            sets: [
              [25, 1],
              [25, 1],
              [25, 1],
              [25, 1],
              [25, 1],
              [25, 1],
            ],
          },
        },
      }),
      400,
    )
  })

  it('refuses a drawn final', async () => {
    const v = await publishedSeason(4)
    const finalDay = v.competition.weeks!.find((w) => w.kind === 'semi')!
    const results = Object.fromEntries(
      finalDay.games.map((g) => [
        g.id,
        {
          sets: [
            [25, 20],
            [20, 25],
          ],
        },
      ]),
    )
    const r = await saveResults(db, admin, v.season.id, finalDay.id, { baseUpdatedAt: v.matchDays[finalDay.id]!.updatedAt, results }, at(5))
    const e = await rejects(publishResults(db, admin, v.season.id, finalDay.id, { baseUpdatedAt: r.updatedAt }), 422, 'not_ready')
    expect(e.message).toMatch(/draw/)
  })

  it('publishes a match day with a cancelled game, and keeps forfeits as results', async () => {
    const v = await publishedSeason(4)
    const day = v.competition.weeks!.find((w) => w.kind === 'regular')!
    const [g1, g2] = day.games
    const two = { sets: [[25, 20] as [number, number], [25, 18] as [number, number]] }
    let token = (
      await saveResults(
        db,
        admin,
        v.season.id,
        day.id,
        { baseUpdatedAt: v.matchDays[day.id]!.updatedAt, results: { [g1!.id]: two, [g2!.id]: two } },
        at(5),
      )
    ).updatedAt
    token = (await publishResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token }, at(6))).result.updatedAt

    await rejects(setMatchStatus(db, admin, v.season.id, day.id, g1!.id, { baseUpdatedAt: token, status: 'abandoned' }), 400)
    await rejects(setMatchStatus(db, admin, v.season.id, day.id, g1!.id, { baseUpdatedAt: 'stale', status: 'cancelled' }), 409, 'conflict')
    await rejects(setMatchStatus(db, admin, v.season.id, day.id, 'nope', { baseUpdatedAt: token, status: 'cancelled' }), 404)

    // Cancel g1: its draft result goes, its published one stays until the day is republished.
    const cancel = await setMatchStatus(db, admin, v.season.id, day.id, g1!.id, { baseUpdatedAt: token, status: 'cancelled' }, at(7))
    expect(cancel.result.match).toEqual({ id: g1!.id, status: 'cancelled', statusNote: null })
    expect(cancel.purge.tags).toEqual([tags.season('tnl-q1-2027'), tags.league('tnl'), tags.site])
    token = cancel.result.matchDay.updatedAt
    expect(token).toBe(at(7).toISOString())
    expect(await db.select().from(matchResults).where(eq(matchResults.matchId, g1!.id)).all()).toEqual([
      expect.objectContaining({ kind: 'published' }),
    ])
    await rejects(saveResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token, results: { [g1!.id]: two } }), 400)

    // Undo doesn't bring the cancelled game's result back as a draft; republishing drops it from the ladder.
    token = (await undoResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token }, at(8))).updatedAt
    expect(await db.select().from(matchResults).where(eq(matchResults.matchId, g1!.id)).all()).toHaveLength(1)
    token = (await publishResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token }, at(9))).result.updatedAt
    expect(await db.select().from(matchResults).where(eq(matchResults.matchId, g1!.id)).all()).toEqual([])
    const after = await getSeason(db, v.season.id)
    expect(ladderRows(after.competition as { settings: Settings; weeks: Week[] }, []).reduce((n, r) => n + r.played, 0)).toBe(2)
    expect(after.matches[g1!.id]!.status).toBe('cancelled')

    // A forfeit keeps its result and its label; publishing doesn't turn it into "played".
    const forfeit = await setMatchStatus(db, admin, v.season.id, day.id, g2!.id, { baseUpdatedAt: token, status: 'forfeit' }, at(10))
    token = forfeit.result.matchDay.updatedAt
    token = (await publishResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token }, at(11))).result.updatedAt
    expect((await db.select().from(matches).where(eq(matches.id, g2!.id)).get())!.status).toBe('forfeit')

    // Back to played: played with a published result, scheduled without one.
    token = (await setMatchStatus(db, admin, v.season.id, day.id, g2!.id, { baseUpdatedAt: token, status: 'played' }, at(12))).result
      .matchDay.updatedAt
    expect((await db.select().from(matches).where(eq(matches.id, g2!.id)).get())!.status).toBe('played')
    await setMatchStatus(db, admin, v.season.id, day.id, g1!.id, { baseUpdatedAt: token, status: 'played' }, at(13))
    expect((await db.select().from(matches).where(eq(matches.id, g1!.id)).get())!.status).toBe('scheduled')
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'match.status')).all()).toHaveLength(4)
  })

  it('publishes a night where every game was cancelled', async () => {
    const v = await publishedSeason(4)
    const day = v.competition.weeks!.find((w) => w.kind === 'regular')!
    let token = v.matchDays[day.id]!.updatedAt
    for (const [i, g] of day.games.entries())
      token = (await setMatchStatus(db, admin, v.season.id, day.id, g.id, { baseUpdatedAt: token, status: 'cancelled' }, at(5 + i))).result
        .matchDay.updatedAt
    const pub = await publishResults(db, admin, v.season.id, day.id, { baseUpdatedAt: token }, at(9))
    expect(pub.result.resultsPublishedAt).toBe(at(9).toISOString())
  })
})

describe('an imported, in-progress season', () => {
  // Shaped like the importer's output (scripts/wp/competition.ts): non-lib ids, real start times, a court override
  // that only shows in matches.court_id, placeholder finals, draft and published rows for played games.
  async function seedImported() {
    await db.insert(teams).values([
      { id: 'ta', name: 'ACES', slug: 'aces', wpId: 1 },
      { id: 'tb', name: 'BLOCKERS', slug: 'blockers', wpId: 2 },
      { id: 'tc', name: 'CHAOS', slug: 'chaos', wpId: 3 },
      { id: 'td', name: 'DIGGERS', slug: 'diggers', wpId: 4 },
    ])
    await db.insert(seasons).values({
      id: 'imp',
      leagueId: 'tnl',
      name: 'TNL Q4 2026',
      slug: 'tnl-q4-2026',
      year: 2026,
      quarter: 4,
      startDate: '2026-10-01',
      status: 'published',
      settings: {
        sessions: ['20:00', '21:00'],
        sessionMinutes: 60,
        meetings: 1,
        includeFinals: true,
        seed: 0,
        skipDates: [],
        defaultCourtIds: ['c1'],
      },
      generatedFrom: null,
      edited: true,
      publishedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      wpId: 99,
    })
    await db.insert(seasonTeams).values(['ta', 'tb', 'tc', 'td'].map((teamId, sort) => ({ seasonId: 'imp', teamId, sort })))
    await db.insert(matchDays).values([
      {
        id: 'i1',
        seasonId: 'imp',
        date: '2026-10-01',
        kind: 'regular',
        number: 1,
        courtOverrides: {},
        resultsPublishedAt: '2026-10-02T00:00:00.000Z',
      },
      { id: 'i2', seasonId: 'imp', date: '2026-10-08', kind: 'regular', number: 2, courtOverrides: {} },
      { id: 'i3', seasonId: 'imp', date: '2026-10-15', kind: 'final', number: 3, courtOverrides: {} },
    ])
    const m = (x: Partial<NewMatch> & Pick<NewMatch, 'id' | 'matchDayId'>): NewMatch => ({
      seasonId: 'imp',
      session: 0,
      position: 0,
      courtId: 'c1',
      ...x,
    })
    await db.insert(matches).values([
      m({
        id: 'e1',
        matchDayId: 'i1',
        startTime: '20:00',
        homeTeamId: 'ta',
        awayTeamId: 'tb',
        dutyTeamId: 'tc',
        status: 'played',
        wpId: 11,
        slug: 'aces-v-blockers',
      }),
      m({
        id: 'e2',
        matchDayId: 'i1',
        startTime: '21:00',
        session: 1,
        courtId: 'c3',
        homeTeamId: 'tc',
        awayTeamId: 'td',
        dutyTeamId: 'tb',
        status: 'played',
        wpId: 12,
      }),
      m({ id: 'e3', matchDayId: 'i2', startTime: '20:00', homeTeamId: 'ta', awayTeamId: 'tc', dutyTeamId: 'td', wpId: 13 }),
      m({ id: 'e4', matchDayId: 'i2', startTime: '21:00', session: 1, homeTeamId: 'tb', awayTeamId: 'td', dutyTeamId: 'ta', wpId: 14 }),
      m({
        id: 'e5',
        matchDayId: 'i3',
        startTime: '20:00',
        homeLabel: '1st',
        awayLabel: '2nd',
        dutyLabel: '3rd',
        stageTitle: 'Grand Final',
        wpId: 15,
      }),
    ])
    for (const kind of ['published', 'draft'] as const)
      await db.insert(matchResults).values([
        { matchId: 'e1', kind, homeSets: 2, awaySets: 0, homePoints: 50, awayPoints: 40 },
        {
          matchId: 'e2',
          kind,
          homeSets: 1,
          awaySets: 1,
          homePoints: 45,
          awayPoints: 47,
          setScores: [
            [25, 22],
            [20, 25],
          ],
        },
      ])
  }

  it('enters and publishes the next week, and the public ladder shows it', async () => {
    await seedImported()
    const v = await getSeason(db, 'imp')
    expect(v.competition.weeks![0]!.courtOverrides).toEqual({ '1:0': 'Court 3' })
    expect(v.competition.weeks![1]!.games.map((g) => g.result)).toEqual([undefined, undefined])
    const token = (
      await saveResults(
        db,
        admin,
        'imp',
        'i2',
        {
          baseUpdatedAt: v.matchDays.i2!.updatedAt,
          results: {
            e3: {
              sets: [
                [25, 10],
                [25, 12],
              ],
            },
            e4: { home: 0, away: 2, homePoints: 30, awayPoints: 50 },
          },
        },
        at(1),
      )
    ).updatedAt
    await publishResults(db, admin, 'imp', 'i2', { baseUpdatedAt: token }, at(2))
    const site = await loadSite(db)
    const tnl = site.current.find((c) => c.league.id === 'tnl')!
    expect(tnl.ladder.find((r) => r.name === 'ACES')).toMatchObject({ played: 2, won: 2 })
    expect(tnl.ladder.reduce((n, r) => n + r.played, 0)).toBe(8)
    // The first week's results are untouched.
    const first = await db.select().from(matchResults).where(eq(matchResults.matchId, 'e1')).all()
    expect(first).toHaveLength(2)
  })

  it('moves a court on the published draw without losing results, and keeps imported times', async () => {
    await seedImported()
    const v = await getSeason(db, 'imp')
    const weeks = setCourt(v.competition.weeks!, v.competition.settings, 'i2', 1, 0, 'Court 2')
    const saved = await saveDraw(db, admin, 'imp', { baseUpdatedAt: v.season.updatedAt, weeks }, at(1))
    // Only the day that changed is re-stamped, so results being entered for other days don't conflict.
    expect(saved.result.matchDays.i2!.updatedAt).toBe(at(1).toISOString())
    expect(saved.result.matchDays.i1!.updatedAt).toBe(v.matchDays.i1!.updatedAt)
    expect((await db.select().from(matches).where(eq(matches.id, 'e4')).get())!.courtId).toBe('c2')
    expect((await db.select().from(matches).where(eq(matches.id, 'e2')).get())!.courtId).toBe('c3')
    expect(await db.select().from(matchResults).all()).toHaveLength(4)
    const back = await getSeason(db, 'imp')
    expect(back.competition.weeks![1]!.courtOverrides).toEqual({ '1:0': 'Court 2' })
    expect(toCompetition(await loadSeason(db, 'imp')).weeks[0]!.courtOverrides).toEqual({ '1:0': 'Court 3' })
  })

  it('round-trips through the lib’s own edit helpers', async () => {
    await seedImported()
    const v = await getSeason(db, 'imp')
    // What the admin's results screen does locally before saving.
    const weeks = setResult(v.competition.weeks!, 'i2', 'e3', { home: 2, away: 0, homePoints: 50, awayPoints: 20 })
    const published = publishWeekResults(weeks, 'i2', at(3))
    expect(published.find((w) => w.id === 'i2')!.games[0]!.publishedResult).toMatchObject({ home: 2 })
    // The server agrees on what was typed.
    await saveResults(
      db,
      admin,
      'imp',
      'i2',
      { baseUpdatedAt: v.matchDays.i2!.updatedAt, results: { e3: weeks[1]!.games[0]!.result } },
      at(4),
    )
    const back = await getSeason(db, 'imp')
    expect(back.competition.weeks![1]!.games[0]!.result).toEqual({ home: 2, away: 0, homePoints: 50, awayPoints: 20 })
  })
})

describe('ladder adjustments', () => {
  it('adds, changes and removes them, audited', async () => {
    const v = await draftSeason(4)
    const team = v.competition.settings.teams[0]!.id
    await rejects(addAdjustment(db, admin, v.season.id, { teamId: 'nobody', points: -1, reason: 'x' }), 400)
    await rejects(addAdjustment(db, admin, v.season.id, { teamId: team, points: 0, reason: 'x' }), 400)
    await rejects(addAdjustment(db, admin, v.season.id, { teamId: team, points: -1, reason: ' ' }), 400)
    const added = await addAdjustment(db, admin, v.season.id, { teamId: team, points: -2, reason: 'Forfeit' }, at(1))
    expect(added.result).toEqual([expect.objectContaining({ teamId: team, points: -2, reason: 'Forfeit' })])
    expect(added.purge).toEqual({}) // drafts aren't public
    const adjId = added.result[0]!.id
    const changed = await updateAdjustment(db, admin, v.season.id, adjId, { points: -3 }, at(2))
    expect(changed.result[0]).toMatchObject({ points: -3, reason: 'Forfeit' })
    expect((await deleteAdjustment(db, admin, v.season.id, adjId, at(3))).result).toEqual([])
    await rejects(deleteAdjustment(db, admin, v.season.id, adjId), 404)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'ladder.adjust')).all()).toHaveLength(3)
  })
})

describe('teams', () => {
  it('creates and renames teams, refusing duplicate names and keeping slugs', async () => {
    const a = await createTeam(db, admin, { name: ' Ice  Cold ' }, NOW)
    expect(a).toMatchObject({ name: 'Ice Cold', slug: 'ice-cold', lastSeason: null })
    await rejects(createTeam(db, admin, { name: 'ice cold' }), 409, 'team_exists')
    await rejects(createTeam(db, admin, { name: '' }), 400)
    // A different name with the same slug gets a numbered slug.
    expect(await createTeam(db, admin, { name: 'Ice Cold!' }, NOW)).toMatchObject({ name: 'Ice Cold!', slug: 'ice-cold-2' })
  })

  it('renames a team and purges every page', async () => {
    const a = await createTeam(db, admin, { name: 'Ice Cold' }, NOW)
    const c = await createTeam(db, admin, { name: 'Ice Cold Two' }, NOW)
    await rejects(renameTeam(db, admin, c.id, { name: 'ICE COLD' }), 409, 'team_exists')
    // An old WordPress link to the team's page.
    await db.insert(redirects).values({ fromPath: '/team/ice-cold', toPath: '/teams/ice-cold', source: 'wp-import' })
    const renamed = await renameTeam(db, admin, a.id, { name: 'Ice Colder' }, at(1))
    // The slug follows the name; the old page 301s, and links to it are re-pointed (no chains).
    expect(renamed.result).toMatchObject({ name: 'Ice Colder', slug: 'ice-colder' })
    expect(renamed.purge).toEqual({ tags: [tags.site] })
    const paths = async () =>
      Object.fromEntries((await db.select({ from: redirects.fromPath, to: redirects.toPath }).from(redirects)).map((r) => [r.from, r.to]))
    expect(await paths()).toEqual({ '/team/ice-cold': '/teams/ice-colder', '/teams/ice-cold': '/teams/ice-colder' })
    // Changing only the case keeps the slug.
    const cased = await renameTeam(db, admin, a.id, { name: 'ICE COLDER' }, at(2))
    expect(cased.result).toMatchObject({ name: 'ICE COLDER', slug: 'ice-colder' })
    // A new team may take the freed slug: its page stops redirecting; the old WordPress link still finds Ice Colder.
    const fresh = await createTeam(db, admin, { name: 'Ice Cold' }, at(3))
    expect(fresh.slug).toBe('ice-cold')
    expect(await paths()).toEqual({ '/team/ice-cold': '/teams/ice-colder' })
    const v = await draftSeason(2)
    const list = await listTeams(db)
    expect(list.find((t) => t.name === 'Aces')).toMatchObject({ seasons: 1, lastSeason: { id: v.season.id, name: 'TNL Q1 2027' } })
    expect((await db.select().from(auditLog).where(eq(auditLog.action, 'team.rename')).all()).length).toBe(2)
  })
})

describe('court clashes across leagues', () => {
  it('returns other seasons at the same venue in the same dates, for courtClashes()', async () => {
    const tnl = await draftSeason(4)
    const { weeks } = await generateAndSave(tnl)
    // SNL on the same nights at Tempe, on the same courts.
    let snl = await createSeason(
      db,
      admin,
      { leagueId: 'snl', year: 2027, quarter: 1, copyFrom: null, startDate: tnl.season.startDate },
      NOW,
    )
    snl = await setSeasonTeams(
      db,
      admin,
      snl.season.id,
      { baseUpdatedAt: snl.season.updatedAt, teamIds: tnl.competition.settings.teams.map((t) => t.id) },
      at(1),
    )
    await generateAndSave(snl)
    // SAL at Five Dock: never a clash with Tempe.
    let sal = await createSeason(
      db,
      admin,
      { leagueId: 'sal', year: 2027, quarter: 1, copyFrom: null, startDate: tnl.season.startDate },
      NOW,
    )
    sal = await setSeasonTeams(
      db,
      admin,
      sal.season.id,
      { baseUpdatedAt: sal.season.updatedAt, teamIds: tnl.competition.settings.teams.map((t) => t.id) },
      at(1),
    )
    await generateAndSave(sal)

    stats.reset()
    const found = await clashDraws(db, tnl.season.id)
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(found.venue).toBe('tempe')
    expect(found.draws.map((d) => d.label)).toEqual(['SNL Q1 2027'])
    const mine = { seasonId: tnl.season.id, label: 'TNL Q1 2027', venue: found.venue!, settings: tnl.competition.settings, weeks }
    expect(courtClashes([mine, ...found.draws]).length).toBeGreaterThan(0)
    expect((await clashDraws(db, tnl.season.id, { from: '2030-01-01', to: '2030-02-01' })).draws).toEqual([])
    await rejects(clashDraws(db, tnl.season.id, { from: 'soon' }), 400)
  })
})
