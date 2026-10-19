import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type QueryStats, type TestDb } from '../db/testing'
import {
  auditLog,
  courts,
  interestProgrammes,
  leagues,
  players,
  seasons,
  seasonTeamPlayers,
  seasonTeams,
  user,
  venues,
  type RosterRole,
} from '../db/schema'
import { HttpError } from '../http'
import { createInterest, emptyDetails } from '../players/core'
import { changeRoster, exportRosters, getRosters, rosterSources, seasonPlayerDirectory } from './rosters'
import { createSeason, deleteSeason, setSeasonTeams, type SeasonView } from './seasons'
import { createTeam, mergeTeams, recentMerges, undoMerge } from './teams'

const NOW = new Date('2026-10-20T00:00:00.000Z')
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

/** A competition player row. */
async function player(id: string, firstName: string, lastName = 'Test', extra: Partial<typeof players.$inferInsert> = {}) {
  await db.insert(players).values({ id, pool: 'competition', firstName, lastName, email: `${id}@example.com`, ...extra })
  return id
}

async function roster(seasonId: string, teamId: string, ids: string[], roles: RosterRole[] = []) {
  await db
    .insert(seasonTeamPlayers)
    .values(ids.map((playerId, sort) => ({ seasonId, teamId, playerId, sort, role: roles[sort] ?? 'player' })))
}

const names = (v: { rosters: { teamName: string; players: { firstName: string; role: RosterRole }[] }[] }) =>
  Object.fromEntries(v.rosters.map((t) => [t.teamName, t.players.map((p) => (p.role === 'captain' ? `${p.firstName}*` : p.firstName))]))

/** Last season (TNL Q3, published) with Aces and Blockers and their rosters, and a new draft TNL Q4 with Aces in it. */
let last: string
let next: SeasonView
let aces: string
let blockers: string
let chaos: string

beforeEach(async () => {
  const t = createTestDb()
  db = t.db
  stats = t.stats
  await db.insert(user).values({ id: 'adm', name: 'adm', email: 'adm@example.com', emailVerified: true, role: 'admin' })
  await db.insert(venues).values({ id: 'tempe', name: 'Robyn Webster Sports Centre', slug: 'robyn-webster', sort: 0 })
  await db.insert(courts).values({ id: 'c1', venueId: 'tempe', name: 'Court 1', sort: 1 })
  await db.insert(leagues).values([
    { id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4, defaultVenueId: 'tempe', sort: 0 },
    { id: 'fnl', code: 'FNL', name: 'Friday Night League', slug: 'fnl', weekday: 5, defaultVenueId: 'tempe', sort: 1 },
  ])
  aces = (await createTeam(db, admin, { name: 'Aces' }, NOW)).id
  blockers = (await createTeam(db, admin, { name: 'Blockers' }, NOW)).id
  chaos = (await createTeam(db, admin, { name: 'Chaos' }, NOW)).id
  const q3 = await createSeason(db, admin, { leagueId: 'tnl', year: 2026, quarter: 3, copyFrom: null }, NOW)
  last = q3.season.id
  await setSeasonTeams(db, admin, last, { baseUpdatedAt: q3.season.updatedAt, teamIds: [aces, blockers] }, at(1))
  await db.update(seasons).set({ status: 'published' }).where(eq(seasons.id, last))
  for (const [id, first] of [
    ['p1', 'Ann'],
    ['p2', 'Ben'],
    ['p3', 'Cat'],
    ['p4', 'Dan'],
    ['p5', 'Eve'],
  ] as const)
    await player(id, first)
  await roster(last, aces, ['p1', 'p2', 'p3'], ['captain'])
  await roster(last, blockers, ['p4', 'p5'])
  const q4 = await createSeason(db, admin, { leagueId: 'tnl', year: 2026, quarter: 4, copyFrom: null }, at(2))
  next = await setSeasonTeams(db, admin, q4.season.id, { baseUpdatedAt: q4.season.updatedAt, teamIds: [aces, chaos] }, at(3))
})

describe('roster changes', () => {
  it('adds existing and new players, skips someone already in the team, and stays within D1’s limits', async () => {
    const id = next.season.id
    stats.reset()
    const v = await changeRoster(
      db,
      admin,
      id,
      {
        action: 'add',
        teamId: aces,
        playerIds: ['p1', 'p2'],
        newPlayers: [
          { firstName: 'Zed', lastName: 'New', email: 'Zed@Example.com', phone: '0400 000 000', gender: 'male' },
          // Matches an existing player by email and name: no duplicate row.
          { firstName: 'ann', lastName: 'TEST', email: 'p1@example.com' },
        ],
      },
      at(5),
    )
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(v.done).toMatchObject({ added: 3, created: 1 })
    expect(names(v)).toEqual({ Aces: ['Ann', 'Ben', 'Zed'], Chaos: [] })
    const zed = await db.select().from(players).where(eq(players.firstName, 'Zed')).get()
    expect(zed).toMatchObject({ pool: 'competition', source: 'admin', email: 'zed@example.com', gender: 'male' })
    expect(v.placed).toBe(3)
    // Again: nothing new.
    const again = await changeRoster(db, admin, id, { action: 'add', teamId: aces, playerIds: ['p1'] }, at(6))
    expect(again.done.added).toBe(0)
    // Seasons' updatedAt (the working copy's token) is untouched.
    expect((await db.select().from(seasons).where(eq(seasons.id, id)).get())!.updatedAt).toBe(next.season.updatedAt)
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, 'roster.update')).all()
    expect(audit[0]).toMatchObject({
      targetType: 'season',
      targetId: id,
      after: { action: 'add', team: 'Aces', players: ['Ann Test', 'Ben Test', 'Zed New'] },
    })
  })

  it('keeps a player to one team per season unless asked to move them', async () => {
    const id = next.season.id
    await changeRoster(db, admin, id, { action: 'add', teamId: aces, playerIds: ['p1'] }, at(5))
    const e = await rejects(
      changeRoster(db, admin, id, { action: 'add', teamId: chaos, playerIds: ['p1', 'p2'] }, at(6)),
      409,
      'already_in_team',
    )
    expect(e.message).toMatch(/Ann Test is already in Aces/)
    expect(e.details).toMatchObject({ players: [{ playerId: 'p1', teamId: aces, teamName: 'Aces' }] })
    const v = await changeRoster(db, admin, id, { action: 'add', teamId: chaos, playerIds: ['p1', 'p2'], move: true }, at(7))
    expect(v.done).toMatchObject({ added: 2, moved: 1 })
    expect(names(v)).toEqual({ Aces: [], Chaos: ['Ann', 'Ben'] })
    // Training players and teams outside the season are refused.
    await player('tr', 'Tia', 'Train', { pool: 'training' })
    await rejects(changeRoster(db, admin, id, { action: 'add', teamId: chaos, playerIds: ['tr'] }), 400)
    await rejects(changeRoster(db, admin, id, { action: 'add', teamId: blockers, playerIds: ['p3'] }), 409, 'team_not_in_season')
  })

  it('moves, replaces, makes captain and reorders', async () => {
    const id = next.season.id
    await changeRoster(db, admin, id, { action: 'add', teamId: aces, playerIds: ['p1', 'p2', 'p3'] }, at(5))
    let v = await changeRoster(db, admin, id, { action: 'captain', teamId: aces, playerId: 'p2' }, at(6))
    expect(names(v).Aces).toEqual(['Ann', 'Ben*', 'Cat'])
    v = await changeRoster(db, admin, id, { action: 'captain', teamId: aces, playerId: 'p3' }, at(7))
    expect(names(v).Aces).toEqual(['Ann', 'Ben', 'Cat*'])
    // Replace keeps the role and the place.
    v = await changeRoster(db, admin, id, { action: 'replace', teamId: aces, playerId: 'p3', withPlayerId: 'p4' }, at(8))
    expect(names(v).Aces).toEqual(['Ann', 'Ben', 'Dan*'])
    v = await changeRoster(
      db,
      admin,
      id,
      { action: 'replace', teamId: aces, playerId: 'p1', newPlayer: { firstName: 'Yan', lastName: 'Fresh' } },
      at(9),
    )
    expect(names(v).Aces).toEqual(['Yan', 'Ben', 'Dan*'])
    await rejects(changeRoster(db, admin, id, { action: 'replace', teamId: aces, playerId: 'p2', withPlayerId: 'p4' }), 400)
    // A captain moving to a team without one stays captain.
    v = await changeRoster(db, admin, id, { action: 'move', teamId: aces, playerId: 'p4', toTeamId: chaos }, at(10))
    expect(names(v)).toEqual({ Aces: ['Yan', 'Ben'], Chaos: ['Dan*'] })
    const ids = v.rosters[0]!.players.map((p) => p.playerId)
    v = await changeRoster(db, admin, id, { action: 'order', teamId: aces, playerIds: ids.toReversed() }, at(11))
    expect(names(v).Aces).toEqual(['Ben', 'Yan'])
    await rejects(changeRoster(db, admin, id, { action: 'order', teamId: aces, playerIds: ['p2'] }), 409, 'roster_changed')
    v = await changeRoster(db, admin, id, { action: 'remove', teamId: aces, playerId: 'p2' }, at(12))
    expect(names(v).Aces).toEqual(['Yan'])
    await rejects(changeRoster(db, admin, id, { action: 'remove', teamId: aces, playerId: 'p2' }), 404)
  })

  it('adds a team EOI’s members to a team already in the season and places the EOI', async () => {
    const id = next.season.id
    const eoi = await createInterest(db, {
      kind: 'team',
      pool: 'competition',
      teamName: 'aces',
      members: [emptyDetails('Cap', 'Tain', 'cap@example.com'), emptyDetails('Mem', 'Ber', 'mem@example.com')],
      programmeIds: ['tnl'],
      answers: {},
      formId: null,
      formVersion: null,
      depositCents: null,
      source: 'public',
      now: at(4),
    })
    const v = await changeRoster(
      db,
      admin,
      id,
      { action: 'add', teamId: aces, playerIds: eoi.members.map((m) => m.playerId), interestId: eoi.id },
      at(5),
    )
    expect(names(v).Aces).toEqual(['Cap', 'Mem'])
    expect(await db.select().from(interestProgrammes).get()).toMatchObject({ status: 'placed', seasonId: id, teamId: aces })
  })

  it('works on a published season (rosters never touch the draw)', async () => {
    const v = await changeRoster(
      db,
      admin,
      last,
      { action: 'add', teamId: blockers, newPlayers: [{ firstName: 'Late', lastName: 'Comer' }] },
      at(5),
    )
    expect(names(v).Blockers).toEqual(['Dan', 'Eve', 'Late'])
  })

  it('places an individual EOI when its player is added, follows a move and reverts on removal', async () => {
    const id = next.season.id
    const eoi = await createInterest(db, {
      kind: 'player',
      pool: 'competition',
      teamName: null,
      members: [{ ...emptyDetails('Ivy', 'Eoi', 'ivy@example.com'), gender: 'female' }],
      programmeIds: ['tnl', 'fnl'],
      answers: { playing_level: 'intermediate', position: 'setter' },
      formId: null,
      formVersion: null,
      depositCents: null,
      source: 'public',
      now: at(4),
    })
    const ivy = eoi.members[0]!.playerId
    let v = await getRosters(db, id)
    expect(v.openInterest).toBe(1)
    v = await changeRoster(db, admin, id, { action: 'add', teamId: aces, playerIds: [ivy] }, at(5))
    expect(v.openInterest).toBe(0)
    expect(v.rosters[0]!.players[0]).toMatchObject({
      interest: { id: eoi.id, reference: eoi.reference },
      level: 'intermediate',
      position: 'setter',
    })
    const prog = () =>
      db
        .select({
          p: interestProgrammes.programmeId,
          status: interestProgrammes.status,
          s: interestProgrammes.seasonId,
          t: interestProgrammes.teamId,
        })
        .from(interestProgrammes)
        .orderBy(interestProgrammes.programmeId)
        .all()
    // FNL's row is its own business.
    expect(await prog()).toEqual([
      { p: 'fnl', status: 'new', s: null, t: null },
      { p: 'tnl', status: 'placed', s: id, t: aces },
    ])
    await changeRoster(db, admin, id, { action: 'move', teamId: aces, playerId: ivy, toTeamId: chaos }, at(6))
    expect((await prog())[1]).toEqual({ p: 'tnl', status: 'placed', s: id, t: chaos })
    await changeRoster(db, admin, id, { action: 'remove', teamId: chaos, playerId: ivy }, at(7))
    expect((await prog())[1]).toEqual({ p: 'tnl', status: 'contacted', s: null, t: null })
    expect((await getRosters(db, id)).openInterest).toBe(1)
  })
})

describe('the team list’s Save with rosters', () => {
  it('copies last season’s rosters and a team EOI’s members, skipping retired and already-placed players', async () => {
    const id = next.season.id
    await db.update(players).set({ retiredAt: NOW.toISOString() }).where(eq(players.id, 'p5'))
    // Ben is already in Chaos this season, so Aces' copy skips him.
    await changeRoster(db, admin, id, { action: 'add', teamId: chaos, playerIds: ['p2'] }, at(4))
    const team = await createInterest(db, {
      kind: 'team',
      pool: 'competition',
      teamName: 'Dig Deep',
      members: [
        emptyDetails('Cap', 'Tain', 'cap@example.com'),
        emptyDetails('Mem', 'Ber', 'mem@example.com'),
        emptyDetails('Dan', 'Test', 'p4@example.com'),
      ],
      programmeIds: ['tnl'],
      answers: {},
      formId: null,
      formVersion: null,
      depositCents: null,
      source: 'public',
      now: at(4),
    })
    const digDeep = (await createTeam(db, admin, { name: 'Dig Deep' }, at(4))).id
    // Aces leaves (its roster goes); Blockers and Dig Deep join with theirs.
    stats.reset()
    const v = await setSeasonTeams(
      db,
      admin,
      id,
      {
        baseUpdatedAt: next.season.updatedAt,
        teamIds: [chaos, blockers, digDeep],
        rosterFrom: { [blockers]: { seasonId: last }, [digDeep]: { interestId: team.id } },
      },
      at(5),
    )
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    // Blockers: Dan (Eve retired). Dig Deep: Cap (captain), Mem; Dan was placed in Blockers first.
    expect(v.rosterCopy).toEqual({
      copied: 3,
      skipped: [
        { name: 'Eve Test', team: 'Blockers', reason: 'retired' },
        { name: 'Dan Test', team: 'Dig Deep', reason: 'placed' },
      ],
    })
    const r = await getRosters(db, id)
    expect(names(r)).toEqual({ Chaos: ['Ben'], Blockers: ['Dan'], 'Dig Deep': ['Cap*', 'Mem'] })
    expect(r.rosters[1]!.players[0]!.fromSeason).toMatchObject({ id: last })
    expect(r.rosters[2]!.players[0]!.interest).toMatchObject({ id: team.id })
    const prog = await db.select().from(interestProgrammes).where(eq(interestProgrammes.interestId, team.id)).get()
    expect(prog).toMatchObject({ status: 'placed', seasonId: id, teamId: digDeep })
  })

  it('deletes the roster of a team that leaves and reverts EOIs placed into it', async () => {
    const id = next.season.id
    const eoi = await createInterest(db, {
      kind: 'player',
      pool: 'competition',
      teamName: null,
      members: [emptyDetails('Ivy', 'Eoi', 'ivy@example.com')],
      programmeIds: ['tnl'],
      answers: {},
      formId: null,
      formVersion: null,
      depositCents: null,
      source: 'public',
      now: at(4),
    })
    await changeRoster(db, admin, id, { action: 'add', teamId: aces, playerIds: ['p1', eoi.members[0]!.playerId] }, at(5))
    await changeRoster(db, admin, id, { action: 'add', teamId: chaos, playerIds: ['p2'] }, at(5))
    await setSeasonTeams(db, admin, id, { baseUpdatedAt: next.season.updatedAt, teamIds: [chaos] }, at(6))
    expect(names(await getRosters(db, id))).toEqual({ Chaos: ['Ben'] })
    expect(
      await db
        .select()
        .from(seasonTeamPlayers)
        .where(and(eq(seasonTeamPlayers.seasonId, id), eq(seasonTeamPlayers.teamId, aces))),
    ).toEqual([])
    expect(await db.select().from(interestProgrammes).get()).toMatchObject({ status: 'contacted', seasonId: null, teamId: null })
    // Last season's Aces roster is untouched.
    expect((await db.select().from(seasonTeamPlayers).where(eq(seasonTeamPlayers.seasonId, last))).length).toBe(5)
  })

  it('refuses rosterFrom for a team that isn’t in the list, and ignores it for a team already in', async () => {
    const id = next.season.id
    await rejects(
      setSeasonTeams(db, admin, id, {
        baseUpdatedAt: next.season.updatedAt,
        teamIds: [aces],
        rosterFrom: { [blockers]: { seasonId: last } },
      }),
      400,
    )
    await rejects(
      setSeasonTeams(db, admin, id, { baseUpdatedAt: next.season.updatedAt, teamIds: [aces], rosterFrom: { [aces]: { seasonId: id } } }),
      400,
    )
    await rejects(
      setSeasonTeams(db, admin, id, { baseUpdatedAt: next.season.updatedAt, teamIds: [aces], rosterFrom: { [aces]: { nope: 1 } } }),
      400,
    )
    const v = await setSeasonTeams(
      db,
      admin,
      id,
      { baseUpdatedAt: next.season.updatedAt, teamIds: [aces, chaos], rosterFrom: { [aces]: { seasonId: last } } },
      at(5),
    )
    expect(v.rosterCopy.copied).toBe(0)
  })

  it('copies a dozen full rosters in one Save within D1’s limits', async () => {
    const id = next.season.id
    const q2 = await createSeason(db, admin, { leagueId: 'tnl', year: 2026, quarter: 2, copyFrom: null }, at(4))
    const ids: string[] = []
    const people: (typeof players.$inferInsert)[] = []
    for (let t = 0; t < 12; t++) {
      ids.push((await createTeam(db, admin, { name: `Team ${t}` }, at(4))).id)
      for (let p = 0; p < 10; p++)
        people.push({ id: `x${t}-${p}`, pool: 'competition', firstName: `P${p}`, lastName: `T${t}`, email: `x${t}-${p}@example.com` })
    }
    for (let i = 0; i < people.length; i += 10) await db.insert(players).values(people.slice(i, i + 10))
    await setSeasonTeams(db, admin, q2.season.id, { baseUpdatedAt: q2.season.updatedAt, teamIds: ids }, at(5))
    for (let t = 0; t < 12; t++)
      await roster(
        q2.season.id,
        ids[t]!,
        Array.from({ length: 10 }, (_, p) => `x${t}-${p}`),
      )
    stats.reset()
    const v = await setSeasonTeams(
      db,
      admin,
      id,
      {
        baseUpdatedAt: next.season.updatedAt,
        teamIds: ids,
        rosterFrom: Object.fromEntries(ids.map((t) => [t, { seasonId: q2.season.id }])),
      },
      at(6),
    )
    expect(stats.queries + 1).toBeLessThanOrEqual(50)
    expect(stats.maxParams).toBeLessThanOrEqual(100)
    expect(v.rosterCopy.copied).toBe(120)
  })

  it('a new season copied from the latest brings its rosters, minus retired players', async () => {
    await db.update(players).set({ retiredAt: NOW.toISOString() }).where(eq(players.id, 'p3'))
    await db.delete(seasons).where(eq(seasons.id, next.season.id))
    const v = await createSeason(db, admin, { leagueId: 'tnl', year: 2026, quarter: 4 }, at(5))
    expect(names(await getRosters(db, v.season.id))).toEqual({ Aces: ['Ann*', 'Ben'], Blockers: ['Dan', 'Eve'] })
  })
})

describe('team sources and the picker', () => {
  it('groups returning teams, previews their rosters and lists team EOIs matched by name', async () => {
    // FNL's Floaters played only in FNL.
    const floaters = (await createTeam(db, admin, { name: 'Floaters' }, NOW)).id
    const f = await createSeason(db, admin, { leagueId: 'fnl', year: 2026, quarter: 3, copyFrom: null }, NOW)
    await setSeasonTeams(db, admin, f.season.id, { baseUpdatedAt: f.season.updatedAt, teamIds: [floaters] }, at(1))
    await db
      .update(seasonTeams)
      .set({ withdrawnAt: NOW.toISOString() })
      .where(and(eq(seasonTeams.seasonId, last), eq(seasonTeams.teamId, blockers)))
    const eoi = await createInterest(db, {
      kind: 'team',
      pool: 'competition',
      teamName: '  chaos ',
      members: [emptyDetails('Cap', 'Tain', 'cap@example.com')],
      programmeIds: ['tnl'],
      answers: { playing_level: 'advanced' },
      formId: null,
      formVersion: null,
      depositCents: null,
      source: 'public',
      now: at(2),
    })
    const s = await rosterSources(db, next.season.id)
    expect(s.lastSeason).toMatchObject({ id: last, name: 'TNL Q3 2026' })
    expect(s.teams.map((t) => [t.teamName, t.group, t.from.seasonName, t.from.withdrawn, t.players.map((p) => p.name)])).toEqual([
      ['Aces', 'last', 'TNL Q3 2026', false, ['Ann Test', 'Ben Test', 'Cat Test']],
      ['Blockers', 'last', 'TNL Q3 2026', true, ['Dan Test', 'Eve Test']],
      ['Floaters', 'other', 'FNL Q3 2026', false, []],
    ])
    expect(s.interests).toEqual([
      expect.objectContaining({
        interestId: eoi.id,
        teamName: 'chaos',
        matchedTeam: { id: chaos, name: 'Chaos' },
        captain: expect.objectContaining({ name: 'Cap Tain', email: 'cap@example.com' }),
        level: 'advanced',
      }),
    ])
    const dir = await seasonPlayerDirectory(db, next.season.id, '2026-10-20')
    expect(dir.lastSeason?.id).toBe(last)
    expect(dir.players.find((p) => p.id === 'p1')?.group).toBe('last')
  })
})

describe('CSV export', () => {
  it('lists every player team by team, guarded against formulas, and is audited', async () => {
    await db.update(players).set({ phone: '+61 400 000 000', gender: 'female', firstName: '=HYPERLINK("x")' }).where(eq(players.id, 'p1'))
    const { csv, filename } = await exportRosters(db, admin, last, at(5))
    expect(filename).toBe('tnl-q3-2026-rosters.csv')
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe('"Team","Role","First name","Last name","Email","Phone","Gender"')
    expect(lines[1]).toBe(`"Aces","Captain","'=HYPERLINK(""x"")","Test","p1@example.com","'+61 400 000 000","Female"`)
    expect(lines).toHaveLength(6)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'roster.export')).get()).toMatchObject({
      targetId: last,
      after: { players: 5 },
    })
  })
})

describe('review fixes', () => {
  const playerEoi = (first: string, email: string, last = 'Eoi') =>
    createInterest(db, {
      kind: 'player',
      pool: 'competition',
      teamName: null,
      members: [emptyDetails(first, last, email)],
      programmeIds: ['tnl'],
      answers: {},
      formId: null,
      formVersion: null,
      depositCents: null,
      source: 'public',
      now: at(4),
    })
  const progOf = (interestId: string) =>
    db
      .select({ status: interestProgrammes.status, seasonId: interestProgrammes.seasonId, teamId: interestProgrammes.teamId })
      .from(interestProgrammes)
      .where(and(eq(interestProgrammes.interestId, interestId), eq(interestProgrammes.programmeId, 'tnl')))
      .get()

  it('an add that races another team’s add gets the usual 409 already_in_team (one team per season, by index)', async () => {
    const id = next.season.id
    // Between our read and our write, someone puts Cat in Chaos.
    const batch = db.batch.bind(db)
    let n = 0
    db.batch = (async (items: Parameters<typeof batch>[0]) => {
      if (++n === 2) await db.insert(seasonTeamPlayers).values({ seasonId: id, teamId: chaos, playerId: 'p3' })
      return batch(items)
    }) as unknown as typeof db.batch
    const e = await rejects(changeRoster(db, admin, id, { action: 'add', teamId: aces, playerIds: ['p3'] }, at(5)), 409, 'already_in_team')
    db.batch = batch
    expect(e.details?.players).toEqual([{ playerId: 'p3', name: 'Cat Test', teamId: chaos, teamName: 'Chaos' }])
    expect(names(await getRosters(db, id))).toEqual({ Aces: [], Chaos: ['Cat'] })
  })

  it('rosterFrom { interestId } needs an open team EOI for this league with competition players', async () => {
    const id = next.season.id
    const digDeep = (await createTeam(db, admin, { name: 'Dig Deep' }, at(4))).id
    const team = await createInterest(db, {
      kind: 'team',
      pool: 'competition',
      teamName: 'Dig Deep',
      members: [emptyDetails('Cap', 'Tain', 'cap@example.com')],
      programmeIds: ['tnl', 'fnl'],
      answers: {},
      formId: null,
      formVersion: null,
      depositCents: null,
      source: 'public',
      now: at(4),
    })
    const save = () =>
      setSeasonTeams(
        db,
        admin,
        id,
        { baseUpdatedAt: next.season.updatedAt, teamIds: [aces, chaos, digDeep], rosterFrom: { [digDeep]: { interestId: team.id } } },
        at(5),
      )
    await db.update(interestProgrammes).set({ status: 'declined' }).where(eq(interestProgrammes.programmeId, 'tnl'))
    await rejects(save(), 409, 'interest_not_open')
    await db.update(interestProgrammes).set({ status: 'contacted' }).where(eq(interestProgrammes.programmeId, 'tnl'))
    await db.update(players).set({ pool: 'training' }).where(eq(players.firstName, 'Cap'))
    await rejects(save(), 409, 'wrong_pool')
    await db.update(players).set({ pool: 'competition' }).where(eq(players.firstName, 'Cap'))
    expect((await save()).rosterCopy.copied).toBe(1)
  })

  it('"New season" copying the latest places the copied players’ open EOIs', async () => {
    const ann = await playerEoi('Ann', 'p1@example.com', 'Test')
    expect(ann.members[0]!.playerId).toBe('p1')
    await db.delete(seasons).where(eq(seasons.id, next.season.id))
    const v = await createSeason(db, admin, { leagueId: 'tnl', year: 2026, quarter: 4 }, at(5))
    expect(await progOf(ann.id)).toEqual({ status: 'placed', seasonId: v.season.id, teamId: aces })
  })

  it('deleting a draft season puts the EOIs placed in it back to contacted', async () => {
    const id = next.season.id
    const ivy = await playerEoi('Ivy', 'ivy@example.com')
    await changeRoster(db, admin, id, { action: 'add', teamId: aces, playerIds: [ivy.members[0]!.playerId] }, at(5))
    expect((await progOf(ivy.id))?.status).toBe('placed')
    await deleteSeason(db, admin, id, { baseUpdatedAt: next.season.updatedAt }, at(6))
    expect(await progOf(ivy.id)).toEqual({ status: 'contacted', seasonId: null, teamId: null })
  })

  it('undoing a team merge carries rosters and EOI placements made into the kept team since, by season', async () => {
    const id = next.season.id
    // Chaos (this season only) merges into Blockers (last season only).
    await mergeTeams(db, admin, blockers, { mergeId: chaos }, at(5))
    // Since the merge: Ivy is added to "Blockers" this season, which places her EOI there.
    const ivy = await playerEoi('Ivy', 'ivy@example.com')
    await changeRoster(db, admin, id, { action: 'add', teamId: blockers, playerIds: [ivy.members[0]!.playerId] }, at(6))
    expect((await progOf(ivy.id))?.teamId).toBe(blockers)
    const [m] = await recentMerges(db, at(7))
    await undoMerge(db, admin, m!.auditId, at(7))
    expect(names(await getRosters(db, id))).toEqual({ Aces: [], Chaos: ['Ivy'] })
    expect(await progOf(ivy.id)).toEqual({ status: 'placed', seasonId: id, teamId: chaos })
    // Last season's Blockers roster stays Blockers'.
    expect(names(await getRosters(db, last))).toEqual({ Aces: ['Ann*', 'Ben', 'Cat'], Blockers: ['Dan', 'Eve'] })
  })
})
