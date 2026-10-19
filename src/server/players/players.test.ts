import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { checkFormFields } from '../../lib/enrolment/validate'
import { DEFAULT_INTEREST_FIELDS } from '../../lib/enrolment/defaults'
import { applyMigration, createMigratedSqlite, createTestDb, type TestDb } from '../db/testing'
import { interestMembers, interestProgrammes, interests, leagues, players, seasons, seasonTeamPlayers, teams, user } from '../db/schema'
import { createInterest, emptyDetails, INTEREST_REFERENCE_PATTERN, matchPeople } from './core'
import { competitionDirectory } from './directory'

const settings = { sessions: ['20:00'], sessionMinutes: 60, meetings: 1, includeFinals: false, seed: 0, skipDates: [], defaultCourtIds: [] }
const season = (id: string, leagueId: string, startDate: string, quarter: number) => ({
  id,
  leagueId,
  name: `${leagueId.toUpperCase()} Q${quarter} 2026`,
  slug: `${leagueId}-q${quarter}-2026`,
  year: 2026,
  quarter,
  startDate,
  settings,
})
const person = (firstName: string, lastName: string, email: string | null) => ({
  ...emptyDetails(firstName, lastName, email),
  phone: '0412 345 678',
})

let db: TestDb
beforeEach(async () => {
  db = createTestDb().db
  await db.insert(leagues).values([
    { id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4 },
    { id: 'fnl', code: 'FNL', name: 'Friday Night League', slug: 'fnl', weekday: 5 },
  ])
  await db
    .insert(seasons)
    .values([season('tnl3', 'tnl', '2026-07-09', 3), season('tnl4', 'tnl', '2026-10-08', 4), season('tnl1', 'tnl', '2027-01-14', 1)])
  await db.update(seasons).set({ year: 2027 }).where(eq(seasons.id, 'tnl1'))
  await db.insert(seasons).values(season('fnl4', 'fnl', '2026-10-09', 4))
  await db.insert(teams).values([
    { id: 'aces', name: 'ACES', slug: 'aces' },
    { id: 'chaos', name: 'Chaos', slug: 'chaos' },
  ])
})

describe('createInterest', () => {
  it('saves a team EOI with new players, members and one row per programme', async () => {
    const r = await createInterest(db, {
      kind: 'team',
      pool: 'competition',
      teamName: 'Spike Lee',
      members: [person('Sam', 'Lee', 'Sam@Example.com'), person('Jo', 'Park', null), person('Sam', 'Lee', 'sam@example.com')],
      programmeIds: ['tnl', 'fnl', 'tnl'],
      answers: { playing_level: 'intermediate' },
      formId: null,
      formVersion: null,
      depositCents: 5000,
      source: 'public',
      now: new Date('2026-10-20T01:00:00Z'),
    })
    expect(r.reference).toMatch(INTEREST_REFERENCE_PATTERN)
    // Sam typed twice is one player.
    expect(r.members.map((m) => m.created)).toEqual([true, true, false])
    expect(r.members[2]!.playerId).toBe(r.members[0]!.playerId)
    const rows = await db.select().from(players)
    expect(rows).toHaveLength(2)
    expect(rows.every((p) => p.pool === 'competition' && p.source === 'interest')).toBe(true)
    expect(rows.find((p) => p.firstName === 'Sam')!.email).toBe('sam@example.com')
    const members = await db.select().from(interestMembers).orderBy(interestMembers.sort)
    expect(members.map((m) => m.role)).toEqual(['captain', 'player', 'player'])
    expect(members[0]!.details.email).toBe('Sam@Example.com')
    const progs = await db.select().from(interestProgrammes)
    expect(progs.map((p) => p.programmeId).sort()).toEqual(['fnl', 'tnl'])
    expect(progs.every((p) => p.status === 'new' && p.createdAt === '2026-10-20T01:00:00.000Z')).toBe(true)
  })

  it("matches existing players in the same pool and doesn't touch them", async () => {
    await db.insert(players).values([
      { id: 'comp', pool: 'competition', firstName: 'Sam', lastName: 'Lee', email: 'sam@example.com', phone: '0400 000 000' },
      { id: 'train', pool: 'training', firstName: 'Alex', lastName: 'Kim', email: 'alex@example.com' },
    ])
    const r = await createInterest(db, {
      kind: 'player',
      pool: 'competition',
      teamName: null,
      members: [person('sam', 'LEE', 'sam@example.com')],
      programmeIds: ['tnl'],
      answers: {},
      formId: null,
      formVersion: null,
      depositCents: null,
      source: 'public',
      now: new Date(),
    })
    expect(r.members).toEqual([{ playerId: 'comp', created: false }])
    expect((await db.select().from(players).where(eq(players.id, 'comp')).get())!.phone).toBe('0400 000 000')
    // A training player isn't a competition player: the same person is a new competition row.
    const alex = await matchPeople(db, 'competition', [person('Alex', 'Kim', 'alex@example.com')])
    expect(alex).toEqual([null])
    expect(await matchPeople(db, 'training', [person('Alex', 'Kim', 'alex@example.com')])).toEqual(['train'])
  })

  it('matches members without an email by name on an earlier roster of the same team', async () => {
    await db.insert(players).values({ id: 'jo', pool: 'competition', firstName: 'Jo', lastName: 'Park', email: '' })
    await db.insert(seasonTeamPlayers).values({ seasonId: 'tnl3', teamId: 'aces', playerId: 'jo' })
    expect(await matchPeople(db, 'competition', [person('jo', 'park', null)], { teamName: ' aces ' })).toEqual(['jo'])
    expect(await matchPeople(db, 'competition', [person('jo', 'park', null)], { teamName: 'Chaos' })).toEqual([null])
  })

  it('audits admin-entered EOIs', async () => {
    await db
      .insert(user)
      .values({ id: 'u1', name: 'Michael', email: 'm@example.com', emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
    const r = await createInterest(db, {
      kind: 'player',
      pool: 'competition',
      teamName: null,
      members: [person('Pat', 'Ng', null)],
      programmeIds: ['tnl'],
      answers: {},
      formId: null,
      formVersion: null,
      depositCents: null,
      source: 'admin',
      actor: { id: 'u1' },
      now: new Date(),
    })
    const row = await db.select().from(interests).where(eq(interests.id, r.id)).get()
    expect(row!.source).toBe('admin')
    expect((await db.select().from(players)).map((p) => p.source)).toEqual(['admin'])
  })
})

describe('competitionDirectory', () => {
  it('groups players for the season being built', async () => {
    await db.insert(players).values([
      { id: 'last', pool: 'competition', firstName: 'Lou', lastName: 'Last', email: 'l@example.com' },
      { id: 'past', pool: 'competition', firstName: 'Pia', lastName: 'Past', email: 'p@example.com' },
      { id: 'fnl', pool: 'competition', firstName: 'Fay', lastName: 'Friday', email: 'f@example.com' },
      { id: 'old', pool: 'competition', firstName: 'Ola', lastName: 'Old', email: 'o@example.com', retiredAt: '2026-01-01T00:00:00Z' },
      { id: 'tr', pool: 'training', firstName: 'Tia', lastName: 'Training', email: 't@example.com' },
    ])
    await db.insert(seasonTeamPlayers).values([
      { seasonId: 'tnl4', teamId: 'aces', playerId: 'last', role: 'captain' },
      { seasonId: 'tnl3', teamId: 'chaos', playerId: 'past' },
      { seasonId: 'fnl4', teamId: 'chaos', playerId: 'fnl' },
      { seasonId: 'tnl4', teamId: 'chaos', playerId: 'old' },
      { seasonId: 'tnl1', teamId: 'aces', playerId: 'last' },
    ])
    const eoi = await createInterest(db, {
      kind: 'player',
      pool: 'competition',
      teamName: null,
      members: [person('Nia', 'New', 'n@example.com')],
      programmeIds: ['tnl'],
      answers: { playing_level: 'advanced', position: 'setter' },
      formId: null,
      formVersion: null,
      depositCents: null,
      source: 'public',
      now: new Date('2026-10-15T00:00:00Z'),
    })
    // An EOI from before last season started is old news.
    await createInterest(db, {
      kind: 'player',
      pool: 'competition',
      teamName: null,
      members: [person('Pia', 'Past', 'p@example.com')],
      programmeIds: ['tnl'],
      answers: {},
      formId: null,
      formVersion: null,
      depositCents: null,
      source: 'public',
      now: new Date('2026-09-01T00:00:00Z'),
    })
    const d = await competitionDirectory(db, { leagueId: 'tnl', seasonId: 'tnl1', today: '2026-10-20' })
    expect(d.lastSeason?.id).toBe('tnl4')
    expect(d.interestSince).toBe('2026-10-08')
    const by = Object.fromEntries(d.players.map((p) => [p.firstName, p]))
    expect(Object.keys(by).sort()).toEqual(['Fay', 'Lou', 'Nia', 'Ola', 'Pia'])
    expect(by.Lou!.group).toBe('last')
    expect(by.Lou!.inSeason).toEqual([{ teamId: 'aces', teamName: 'ACES', role: 'player' }])
    expect(by.Lou!.lastInLeague?.seasonId).toBe('tnl4')
    expect(by.Pia!.group).toBe('past')
    expect(by.Fay!.group).toBe('past')
    expect(by.Fay!.lastAnywhere?.leagueCode).toBe('FNL')
    expect(by.Ola!.group).toBe('retired')
    expect(by.Nia!.group).toBe('interest')
    expect(by.Nia!.interest).toMatchObject({ interestId: eoi.id, level: 'advanced', position: 'setter', status: 'new' })

    // Placing the EOI closes it: Nia drops out of New interest.
    await db.update(interestProgrammes).set({ status: 'placed' }).where(eq(interestProgrammes.interestId, eoi.id))
    const after = await competitionDirectory(db, { leagueId: 'tnl', seasonId: 'tnl1', today: '2026-10-20' })
    expect(after.players.find((p) => p.firstName === 'Nia')!.group).toBe('other')

    // Across all leagues (the Players screen): Lou played last season in TNL.
    const all = await competitionDirectory(db, { today: '2026-10-20' })
    expect(all.players.find((p) => p.firstName === 'Lou')!.group).toBe('last')
    expect(all.players.find((p) => p.firstName === 'Fay')!.group).toBe('last')
  })
})

describe('the default EOI form', () => {
  it('is a valid form', () => {
    expect(checkFormFields(DEFAULT_INTEREST_FIELDS)).toMatchObject({ ok: true })
  })
})

describe('migration 0010', () => {
  it('moves players with league entries into the competition pool', async () => {
    const sqlite = createMigratedSqlite({ before: '0010_interest_players_rosters.sql' })
    sqlite.exec(
      `INSERT INTO leagues (id, code, name, slug, weekday, kind) VALUES ('tnl', 'TNL', 'TNL', 'tnl', 4, 'league'), ('sct', 'SCT', 'Scrim', 'sct', 6, 'training')`,
    )
    sqlite.exec(`INSERT INTO players (id, first_name, last_name, email) VALUES ('a', 'A', 'A', 'a@x.com'), ('b', 'B', 'B', 'b@x.com')`)
    sqlite.exec(
      `INSERT INTO products (id, kind, name, slug, price_cents, programme_id) VALUES ('p1', 'season_entry', 'TNL', 'tnl-p', 0, 'tnl'), ('p2', 'training_session', 'S', 's-p', 0, 'sct')`,
    )
    sqlite.exec(
      `INSERT INTO registrations (id, product_id, player_id, reference, status) VALUES ('r1', 'p1', 'a', 'TVB-AAAA', 'confirmed'), ('r2', 'p2', 'b', 'TVB-BBBB', 'confirmed')`,
    )
    applyMigration(sqlite, '0010_interest_players_rosters.sql')
    const rows = sqlite.prepare('SELECT id, pool, source FROM players ORDER BY id').all()
    expect(rows).toEqual([
      { id: 'a', pool: 'competition', source: 'enrolment' },
      { id: 'b', pool: 'training', source: 'enrolment' },
    ])
  })

  it('splits a player with league and training entries into one row per pool', () => {
    const sqlite = createMigratedSqlite({ before: '0010_interest_players_rosters.sql' })
    sqlite.exec(
      `INSERT INTO leagues (id, code, name, slug, weekday, kind) VALUES ('tnl', 'TNL', 'TNL', 'tnl', 4, 'league'), ('sct', 'SCT', 'Scrim', 'sct', 6, 'training'), ('adp', 'ADP', 'ADP', 'adp', 6, 'development')`,
    )
    sqlite.exec(
      `INSERT INTO players (id, first_name, last_name, email, phone) VALUES ('a', 'A', 'A', 'a@x.com', '0400'), ('c', 'C', 'C', 'c@x.com', NULL), ('d', 'D', 'D', 'd@x.com', NULL)`,
    )
    sqlite.exec(
      `INSERT INTO products (id, kind, name, slug, price_cents, programme_id) VALUES ('p1', 'season_entry', 'TNL', 'tnl-p', 0, 'tnl'), ('p2', 'training_session', 'S', 's-p', 0, 'sct'), ('p3', 'development_term', 'ADP', 'adp-p', 0, 'adp')`,
    )
    sqlite.exec(
      `INSERT INTO groups (id, kind, name, captain_player_id, product_id) VALUES ('g1', 'team', 'Spikers', 'a', 'p1'), ('g2', 'team', 'Scrimmers', 'a', 'p2')`,
    )
    sqlite.exec(
      `INSERT INTO registrations (id, product_id, player_id, reference, status) VALUES ('r1', 'p1', 'a', 'TVB-AAAA', 'confirmed'), ('r2', 'p2', 'a', 'TVB-AAAB', 'confirmed'), ('r3', 'p3', 'a', 'TVB-AAAC', 'confirmed'), ('r4', 'p3', 'c', 'TVB-CCCC', 'confirmed')`,
    )
    applyMigration(sqlite, '0010_interest_players_rosters.sql')
    expect(sqlite.prepare('SELECT id, pool, email, phone, source FROM players ORDER BY id').all()).toEqual([
      { id: 'a', pool: 'competition', email: 'a@x.com', phone: '0400', source: 'enrolment' },
      { id: 'a-training', pool: 'training', email: 'a@x.com', phone: '0400', source: 'enrolment' },
      { id: 'c', pool: 'training', email: 'c@x.com', phone: null, source: 'enrolment' },
      { id: 'd', pool: 'training', email: 'd@x.com', phone: null, source: 'enrolment' },
    ])
    expect(sqlite.prepare('SELECT id, player_id FROM registrations ORDER BY id').all()).toEqual([
      { id: 'r1', player_id: 'a' },
      { id: 'r2', player_id: 'a-training' },
      { id: 'r3', player_id: 'a-training' },
      { id: 'r4', player_id: 'c' },
    ])
    expect(sqlite.prepare('SELECT id, captain_player_id FROM groups ORDER BY id').all()).toEqual([
      { id: 'g1', captain_player_id: 'a' },
      { id: 'g2', captain_player_id: 'a-training' },
    ])
  })
})
