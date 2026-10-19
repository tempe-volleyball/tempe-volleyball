import { eq, inArray } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, planOf, type QueryStats, type TestDb } from '../db/testing'
import {
  auditLog,
  groups,
  interestMembers,
  interestProgrammes,
  leagues,
  players,
  products,
  registrations,
  seasons,
  seasonTeamPlayers,
  teams,
  user,
} from '../db/schema'
import { isUniqueFailure } from '../content/common'
import { HttpError } from '../http'
import { groupOf, leagueWindow } from '../../lib/players/groups'
import { createInterest, emptyDetails } from './core'
import { competitionDirectory } from './directory'
import {
  createPlayer,
  deletePlayer,
  exportPlayers,
  getPlayer,
  listPlayers,
  MERGE_CANCEL_REASON,
  mergePlayers,
  parsePlayerQuery,
  playersCsv,
  setRetired,
  updatePlayer,
  type PlayerQuery,
} from './admin'

// Admin → Players against a migrated in-memory SQLite: the two pools, competition groups (from the directory),
// training filters, the player page, add and edit with validation, retire, merge with collisions and delete refusal.

const NOW = new Date('2026-10-20T03:00:00.000Z')
const admin = { id: 'adm', ip: '203.0.113.9' }
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
const q = (o: Partial<PlayerQuery> = {}): PlayerQuery => ({
  pool: 'competition',
  q: null,
  group: 'all',
  leagueId: null,
  programmeId: null,
  retired: 'hide',
  sort: 'name',
  page: 1,
  ...o,
})
const rejects = async (p: Promise<unknown>, status: number, message?: RegExp) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpError)
  expect((e as HttpError).status).toBe(status)
  if (message) expect((e as HttpError).message).toMatch(message)
  return e as HttpError
}
const comp = (id: string, firstName: string, lastName: string, extra: Record<string, unknown> = {}) => ({
  id,
  pool: 'competition' as const,
  firstName,
  lastName,
  email: `${firstName.toLowerCase()}@example.com`,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

let db: TestDb
let sqlite: ReturnType<typeof createTestDb>['sqlite']
let stats: QueryStats
beforeEach(async () => {
  ;({ db, sqlite, stats } = createTestDb())
  await db.insert(user).values({ id: 'adm', name: 'Michael', email: 'michael@example.com', emailVerified: true, role: 'admin' })
  await db.insert(leagues).values([
    { id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4 },
    { id: 'fnl', code: 'FNL', name: 'Friday Night League', slug: 'fnl', weekday: 5 },
    { id: 'train', code: 'SCRIM', name: 'Scrim and coached training', slug: 'scrim', weekday: 2, kind: 'training' },
  ])
  await db
    .insert(seasons)
    .values([season('tnl3', 'tnl', '2026-07-09', 3), season('tnl4', 'tnl', '2026-10-08', 4), season('fnl4', 'fnl', '2026-10-09', 4)])
  await db.insert(teams).values([
    { id: 'aces', name: 'ACES', slug: 'aces' },
    { id: 'kbu', name: 'KBU', slug: 'kbu' },
  ])
  await db
    .insert(players)
    .values([
      comp('ana', 'Ana', 'Cruz'),
      comp('ben', 'Ben', 'Diaz'),
      comp('cal', 'Cal', 'Ek', { retiredAt: '2026-05-01T00:00:00.000Z' }),
      comp('dee', 'Dee', 'Fox', { createdAt: '2026-09-01T00:00:00.000Z' }),
      { id: 'tom', pool: 'training', firstName: 'Tom', lastName: 'Gee', email: 'tom@example.com', createdAt: '2026-02-01T00:00:00.000Z' },
      { id: 'uma', pool: 'training', firstName: 'Uma', lastName: 'Ho', email: 'uma@example.com', createdAt: '2026-03-01T00:00:00.000Z' },
    ])
  // Ana: TNL last season (Q4); Ben: TNL Q3 (past); Dee: none, but a new EOI.
  await db.insert(seasonTeamPlayers).values([
    { seasonId: 'tnl4', teamId: 'aces', playerId: 'ana', role: 'captain' },
    { seasonId: 'tnl3', teamId: 'kbu', playerId: 'ben' },
  ])
  await createInterest(db, {
    kind: 'player',
    pool: 'competition',
    teamName: null,
    members: [{ ...emptyDetails('Dee', 'Fox', 'dee@example.com') }],
    programmeIds: ['tnl'],
    answers: { playing_level: 'beginner' },
    formId: null,
    formVersion: null,
    depositCents: null,
    source: 'public',
    now: new Date('2026-10-15T00:00:00Z'),
  })
  await db
    .insert(products)
    .values({ id: 'prod', kind: 'training_session', name: 'Tue session', slug: 'tue', priceCents: 1000, programmeId: 'train' })
  await db.insert(registrations).values({ id: 'r-tom', productId: 'prod', playerId: 'tom', reference: 'TVB-2345', status: 'confirmed' })
})

describe('the lists', () => {
  it('competition: groups for a league with counts, retired hidden from Everyone', async () => {
    const l = await listPlayers(db, q({ leagueId: 'tnl' }), NOW)
    expect(l.groupCounts).toMatchObject({ interest: 1, last: 1, past: 1, retired: 1, all: 3 })
    expect(l.rows.map((r) => r.id)).toEqual(['ana', 'ben', 'dee'])
    expect(l.rows.find((r) => r.id === 'ana')).toMatchObject({ group: 'last', lastSpot: { teamName: 'ACES', seasonName: 'TNL Q4 2026' } })
    expect(l.rows.find((r) => r.id === 'dee')?.interest).toMatchObject({ level: 'beginner' })
    expect(l.lastSeason?.id).toBe('tnl4')
    expect((await listPlayers(db, q({ leagueId: 'tnl', group: 'interest' }), NOW)).rows.map((r) => r.id)).toEqual(['dee'])
    expect((await listPlayers(db, q({ leagueId: 'tnl', group: 'retired' }), NOW)).rows.map((r) => r.id)).toEqual(['cal'])
    expect((await listPlayers(db, q({ retired: 'any' }), NOW)).total).toBe(4)
    expect((await listPlayers(db, q({ retired: 'only' }), NOW)).rows.map((r) => r.id)).toEqual(['cal'])
    // For FNL, Ana and Ben played elsewhere (past); Dee's EOI was for TNL.
    const fnl = await listPlayers(db, q({ leagueId: 'fnl' }), NOW)
    expect(fnl.groupCounts).toMatchObject({ interest: 0, last: 0, past: 2, other: 1 })
    // Search and sort.
    expect((await listPlayers(db, q({ q: 'ben d' }), NOW)).rows.map((r) => r.id)).toEqual(['ben'])
    expect((await listPlayers(db, q({ sort: 'newest' }), NOW)).rows[0]!.id).toBe('dee')
    expect(l.programmes.map((p) => p.code)).toEqual(['FNL', 'TNL'].filter((c) => l.programmes.some((p) => p.code === c)))
  })

  it('training: searchable, filtered by programme enrolled in, with the latest enrolment', async () => {
    const l = await listPlayers(db, q({ pool: 'training' }), NOW)
    expect(l.rows.map((r) => r.id)).toEqual(['tom', 'uma'])
    expect(l.rows[0]).toMatchObject({ enrolments: 1, lastEnrolment: { programmeName: 'Scrim and coached training' } })
    expect(l.groupCounts).toBeNull()
    expect((await listPlayers(db, q({ pool: 'training', programmeId: 'train' }), NOW)).rows.map((r) => r.id)).toEqual(['tom'])
    expect((await listPlayers(db, q({ pool: 'training', q: 'uma@' }), NOW)).rows.map((r) => r.id)).toEqual(['uma'])
    expect((await listPlayers(db, q({ pool: 'training', sort: 'newest' }), NOW)).rows.map((r) => r.id)).toEqual(['uma', 'tom'])
    expect(l.programmes.map((p) => p.code)).toEqual(['SCRIM'])
  })

  it('parses the query string', () => {
    expect(parsePlayerQuery(new URLSearchParams('pool=training&group=nope&page=-3&sort=x&retired=only'))).toMatchObject({
      pool: 'training',
      group: 'all',
      page: 1,
      sort: 'name',
      retired: 'only',
    })
  })
})

describe('one player', () => {
  it('shows every EOI, enrolment and roster spot', async () => {
    const dee = await getPlayer(db, 'dee')
    expect(dee.interests).toHaveLength(1)
    expect(dee.interests[0]!.programmes).toEqual([{ programmeId: 'tnl', code: 'TNL', status: 'new' }])
    const ana = await getPlayer(db, 'ana')
    expect(ana.rosters).toEqual([
      expect.objectContaining({ seasonName: 'TNL Q4 2026', teamName: 'ACES', role: 'captain', leagueName: 'Thursday Night League' }),
    ])
    const tom = await getPlayer(db, 'tom')
    expect(tom.enrolments).toEqual([expect.objectContaining({ reference: 'TVB-2345', status: 'confirmed', label: 'Tue session' })])
    await rejects(getPlayer(db, 'nobody'), 404)
  })

  it('adds by hand with validation and a duplicate check', async () => {
    await rejects(createPlayer(db, admin, { pool: 'both', firstName: 'A', lastName: 'B' }, NOW), 400, /Competition or training/)
    await rejects(createPlayer(db, admin, { pool: 'competition', firstName: '', lastName: 'B' }, NOW), 400, /First name/)
    await rejects(createPlayer(db, admin, { pool: 'competition', firstName: 'x'.repeat(81), lastName: 'B' }, NOW), 400, /too long/)
    await rejects(createPlayer(db, admin, { pool: 'training', firstName: 'A', lastName: 'B' }, NOW), 400, /need an email/)
    await rejects(createPlayer(db, admin, { pool: 'competition', firstName: 'A', lastName: 'B', email: 'nope' }, NOW), 400, /email/)
    await rejects(createPlayer(db, admin, { pool: 'competition', firstName: 'A', lastName: 'B', phone: 'call me' }, NOW), 400, /phone/)
    await rejects(createPlayer(db, admin, { pool: 'competition', firstName: 'A', lastName: 'B', gender: 'x' }, NOW), 400, /gender/)
    await rejects(
      createPlayer(db, admin, { pool: 'competition', firstName: 'A', lastName: 'B', birthYear: 1800 }, NOW),
      400,
      /Year of birth/,
    )
    // A team member without an email is fine for competition (stored as '').
    const p = await createPlayer(
      db,
      admin,
      { pool: 'competition', firstName: ' Zed ', lastName: 'Lo', gender: 'male', birthYear: '1990', vnswNumber: 'NSW 123' },
      NOW,
    )
    expect(p.player).toMatchObject({ firstName: 'Zed', email: '', gender: 'male', birthYear: 1990, source: 'admin', pool: 'competition' })
    const dupe = await rejects(
      createPlayer(db, admin, { pool: 'competition', firstName: 'ana', lastName: 'CRUZ', email: 'ana@example.com' }, NOW),
      409,
    )
    expect(dupe.code).toBe('duplicate')
    expect(dupe.details?.duplicates).toEqual([expect.objectContaining({ id: 'ana' })])
    // Same name in the other pool isn't a duplicate (kept apart on purpose); force adds anyway.
    await createPlayer(db, admin, { pool: 'training', firstName: 'Ana', lastName: 'Cruz', email: 'ana@example.com' }, NOW)
    await createPlayer(db, admin, { pool: 'competition', firstName: 'Ana', lastName: 'Cruz', force: true }, NOW)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'player.create'))).toHaveLength(3)
  })

  it('edits, refusing stale saves, auditing field names only; retires and un-retires', async () => {
    const before = (await getPlayer(db, 'ana')).player
    await rejects(updatePlayer(db, admin, 'ana', { baseUpdatedAt: 'old', phone: '0412 000 000' }, NOW), 409)
    const p = await updatePlayer(
      db,
      admin,
      'ana',
      { baseUpdatedAt: before.updatedAt, phone: '0412 000 000', suburb: 'Tempe', email: '' },
      NOW,
    )
    expect(p.player).toMatchObject({ phone: '0412 000 000', suburb: 'Tempe', email: '' })
    const a = await db.select().from(auditLog).where(eq(auditLog.action, 'player.update'))
    expect(a[0]!.after).toEqual({ fields: ['email', 'phone', 'suburb'] })
    await rejects(updatePlayer(db, admin, 'tom', { email: '' }, NOW), 400, /need an email/)
    expect((await setRetired(db, admin, 'ana', true, NOW)).player.retiredAt).toBe(NOW.toISOString())
    expect((await listPlayers(db, q({ leagueId: 'tnl', group: 'retired' }), NOW)).rows.map((r) => r.id).sort()).toEqual(['ana', 'cal'])
    expect((await setRetired(db, admin, 'ana', false, NOW)).player.retiredAt).toBeNull()
  })
})

describe('merge', () => {
  it('moves everything to the kept player, resolving enrolment and roster collisions, fills blanks, audited', async () => {
    // Two rows for Ana: the duplicate has a phone, an enrolment for a product Ana already has, another enrolment,
    // the same roster spot (as captain of another season), an EOI and a team captaincy.
    await db
      .insert(players)
      .values(comp('ana2', 'Ana', 'Cruz', { email: 'ana.cruz@example.com', phone: '0400 111 222', notes: 'Prefers Thursdays' }))
    await db.insert(products).values([
      { id: 'p-tnl', kind: 'season_entry', name: 'TNL Q4', slug: 'tnl-q4', priceCents: 0, programmeId: 'tnl', seasonId: 'tnl4' },
      { id: 'p-fnl', kind: 'season_entry', name: 'FNL Q4', slug: 'fnl-q4', priceCents: 0, programmeId: 'fnl', seasonId: 'fnl4' },
    ])
    await db.insert(registrations).values([
      { id: 'r-keep', productId: 'p-tnl', playerId: 'ana', reference: 'TVB-AAAA', status: 'confirmed' },
      { id: 'r-dupe', productId: 'p-tnl', playerId: 'ana2', reference: 'TVB-BBBB', status: 'waitlist' },
      { id: 'r-other', productId: 'p-fnl', playerId: 'ana2', reference: 'TVB-CCCC', status: 'confirmed' },
    ])
    await db.insert(groups).values({ id: 'g1', kind: 'team', name: 'ACES', captainPlayerId: 'ana2', productId: 'p-fnl' })
    await db.insert(seasonTeamPlayers).values([
      { seasonId: 'tnl4', teamId: 'aces', playerId: 'ana2', role: 'player' },
      { seasonId: 'fnl4', teamId: 'kbu', playerId: 'ana2', role: 'captain' },
    ])
    await db.insert(interestMembers).values({
      interestId: (await db.select().from(interestMembers).get())!.interestId,
      playerId: 'ana2',
      sort: 1,
      details: emptyDetails('Ana', 'Cruz'),
    })

    await rejects(mergePlayers(db, admin, 'ana', { mergeId: 'ana' }, NOW), 400, /same one/)
    await rejects(mergePlayers(db, admin, 'ana', { mergeId: 'tom' }, NOW), 400, /kept apart/)
    await rejects(mergePlayers(db, admin, 'ana', { mergeId: 'gone' }, NOW), 404)

    const r = await mergePlayers(db, admin, 'ana', { mergeId: 'ana2' }, NOW)
    expect(r.merge).toMatchObject({
      registrationsMoved: 2,
      registrationsCancelled: 1,
      interestsMoved: 1,
      captaincies: 1,
      rostersMoved: 1,
      rosterDuplicatesDropped: 1,
      filled: ['phone', 'notes'],
    })
    expect(await db.select().from(players).where(eq(players.id, 'ana2'))).toHaveLength(0)
    const regs = await db.select().from(registrations).where(eq(registrations.playerId, 'ana'))
    expect(regs.map((x) => [x.id, x.status]).sort()).toEqual([
      ['r-dupe', 'cancelled'],
      ['r-keep', 'confirmed'],
      ['r-other', 'confirmed'],
    ])
    expect(regs.find((x) => x.id === 'r-dupe')!.cancelReason).toBe(MERGE_CANCEL_REASON)
    const spots = await db.select().from(seasonTeamPlayers).where(eq(seasonTeamPlayers.playerId, 'ana'))
    expect(spots.map((s) => [s.seasonId, s.role]).sort()).toEqual([
      ['fnl4', 'captain'],
      ['tnl4', 'captain'],
    ])
    expect((await db.select().from(groups).get())!.captainPlayerId).toBe('ana')
    expect(r.player).toMatchObject({ phone: '0400 111 222', email: 'ana@example.com', notes: 'Prefers Thursdays' })
    const a = (await db.select().from(auditLog).where(eq(auditLog.action, 'player.merge')))[0]!
    expect(a.targetId).toBe('ana')
    // The audit row is written in the merge's batch: ids, initials and counts, never the duplicate's name.
    expect(a.before).toEqual({ merged: { id: 'ana2', initials: 'A. C.', source: null, createdAt: '2026-01-01T00:00:00.000Z' } })
    expect(a.after).toEqual({ ...r.merge })
    expect(JSON.stringify(a)).not.toContain('Cruz')
  })

  it('refuses to put the kept player in two teams of one season (409 two_teams); the index backs it up', async () => {
    await db.insert(players).values(comp('ana2', 'Ana', 'Cruz'))
    // Ana is in ACES in TNL Q4; her duplicate is in KBU that season.
    await db.insert(seasonTeamPlayers).values({ seasonId: 'tnl4', teamId: 'kbu', playerId: 'ana2' })
    const e = await rejects(mergePlayers(db, admin, 'ana', { mergeId: 'ana2' }, NOW), 409, /TNL Q4 2026 \(ACES and KBU\)/)
    expect(e.code).toBe('two_teams')
    expect(e.details?.seasons).toEqual([{ seasonId: 'tnl4', seasonName: 'TNL Q4 2026', keepTeam: 'ACES', mergeTeam: 'KBU' }])
    expect(await db.select().from(players).where(eq(players.id, 'ana2'))).toHaveLength(1)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'player.merge'))).toHaveLength(0)
    // One player, two teams, one season: the database refuses it too.
    const err = await db
      .insert(seasonTeamPlayers)
      .values({ seasonId: 'tnl4', teamId: 'kbu', playerId: 'ana' })
      .then(
        () => null,
        (x: unknown) => x,
      )
    expect(isUniqueFailure(err, 'season_team_players')).toBe(true)
  })

  it('keeps the kept player’s details with fillBlanks off; the duplicate captain row makes the kept one captain', async () => {
    await db.insert(players).values(comp('ana2', 'Ana', 'Cruz', { phone: '0400 111 222' }))
    await db.insert(seasonTeamPlayers).values({ seasonId: 'tnl3', teamId: 'kbu', playerId: 'ana2', role: 'captain' })
    await db.insert(seasonTeamPlayers).values({ seasonId: 'tnl3', teamId: 'kbu', playerId: 'ana', role: 'player' })
    const r = await mergePlayers(db, admin, 'ana', { mergeId: 'ana2', fillBlanks: false }, NOW)
    expect(r.player.phone).toBeNull()
    const spot = await db.select().from(seasonTeamPlayers).where(eq(seasonTeamPlayers.seasonId, 'tnl3'))
    expect(spot.map((s) => [s.playerId, s.role]).sort()).toEqual([
      ['ana', 'captain'],
      ['ben', 'player'],
    ])
  })
})

describe('delete', () => {
  it('only with no history; otherwise 409 in_use with what references them', async () => {
    const e = await rejects(deletePlayer(db, admin, 'ana', NOW), 409, /season roster/)
    expect(e.code).toBe('in_use')
    expect(e.details?.references).toEqual({ registrations: 0, interests: 0, rosters: 1, captainOf: 0 })
    await rejects(deletePlayer(db, admin, 'dee', NOW), 409, /expression/)
    await rejects(deletePlayer(db, admin, 'tom', NOW), 409, /enrolment/)
    expect(await deletePlayer(db, admin, 'uma', NOW)).toEqual({ deleted: true })
    expect(await db.select().from(players).where(eq(players.id, 'uma'))).toHaveLength(0)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'player.delete'))).toHaveLength(1)
    await rejects(deletePlayer(db, admin, 'uma', NOW), 404)
  })
})

describe('CSV', () => {
  it('exports a pool with the filters, audited and spreadsheet-safe', async () => {
    await db.update(players).set({ notes: '=cmd()' }).where(eq(players.id, 'ana'))
    const { csv, filename } = await exportPlayers(db, admin, q({ leagueId: 'tnl' }), NOW)
    expect(filename).toBe('players-competition-2026-10-20.csv')
    const lines = csv.trim().split('\r\n')
    expect(lines).toHaveLength(4) // header + Ana, Ben, Dee (Cal is retired)
    expect(lines[0]).toContain('"Group","Last team","Last season"')
    expect(lines[1]).toContain('"Last season","ACES","TNL Q4 2026"')
    expect(lines[1]).toContain(`"'=cmd()"`)
    const t = await exportPlayers(db, admin, q({ pool: 'training' }), NOW)
    expect(t.csv.trim().split('\r\n')).toHaveLength(3)
    expect(t.csv).not.toContain('Last team')
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'player.export'))).toHaveLength(2)
    expect(playersCsv('training', [])).toContain('"First name"')
  })
})

describe('at scale (D1 limits)', () => {
  // Three years (2023 to 2025) of three leagues: 36 seasons of 10 teams of 10 (3,600 roster rows), 1,500 competition players and
  // 300 open EOIs. The Players screen must page in SQL without reading the roster history (D1 bills rows read),
  // stay within 50 queries and 100 parameters, and give exactly groupOf()'s groups.
  const seed = () => {
    const insert = (table: string, cols: string[], rows: unknown[][]) => {
      const stmt = sqlite.prepare(`insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`)
      sqlite.exec('BEGIN')
      for (const r of rows) stmt.run(...(r as never[]))
      sqlite.exec('COMMIT')
    }
    const leaguesOf = ['tnl', 'fnl', 'snl']
    insert('leagues', ['id', 'code', 'name', 'slug', 'weekday'], [['snl', 'SNL', 'Saturday Night League', 'snl', 6]])
    const ss: { id: string; leagueId: string; year: number; quarter: number; startDate: string }[] = []
    for (const l of leaguesOf)
      for (let i = 0; i < 12; i++) {
        const y = 2023 + Math.floor(i / 4)
        const qn = (i % 4) + 1
        ss.push({
          id: `${l}-${y}-${qn}`,
          leagueId: l,
          year: y,
          quarter: qn,
          startDate: `${y}-${String(qn * 3 - 2).padStart(2, '0')}-1${leaguesOf.indexOf(l)}`,
        })
      }
    insert(
      'seasons',
      ['id', 'league_id', 'name', 'slug', 'year', 'quarter', 'start_date', 'settings'],
      ss.map((x) => [x.id, x.leagueId, x.id.toUpperCase(), `s-${x.id}`, x.year, x.quarter, x.startDate, JSON.stringify(settings)]),
    )
    insert(
      'teams',
      ['id', 'name', 'slug'],
      Array.from({ length: 30 }, (_, i) => [`t${i}`, `Team ${i}`, `team-${i}`]),
    )
    insert(
      'players',
      ['id', 'pool', 'first_name', 'last_name', 'email', 'created_at', 'retired_at'],
      Array.from({ length: 1500 }, (_, i) => [
        `p${i}`,
        'competition',
        `First${i}`,
        `Last${String(i).padStart(4, '0')}`,
        `p${i}@example.com`,
        `2025-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        i % 97 === 0 ? '2026-01-01T00:00:00.000Z' : null,
      ]),
    )
    const rosters: unknown[][] = []
    ss.forEach((x, si) => {
      for (let t = 0; t < 10; t++)
        for (let k = 0; k < 10; k++) rosters.push([x.id, `t${(si % 3) * 10 + t}`, `p${(si * 37 + t * 10 + k) % 1500}`])
    })
    insert('season_team_players', ['season_id', 'team_id', 'player_id'], rosters)
    const eois: unknown[][] = []
    const members: unknown[][] = []
    const progs: unknown[][] = []
    for (let i = 0; i < 300; i++) {
      const at = `2026-${String((i % 10) + 1).padStart(2, '0')}-15T00:00:00.000Z`
      eois.push([`e${i}`, 'player', `EOI-${String(i).padStart(4, '0')}`, at])
      members.push([`m${i}`, `e${i}`, `p${(i * 7) % 1500}`, JSON.stringify(emptyDetails('X', 'Y'))])
      progs.push([`e${i}`, leaguesOf[i % 3], i % 5 === 0 ? 'placed' : 'new', at])
    }
    insert('interests', ['id', 'kind', 'reference', 'created_at'], eois)
    insert('interest_members', ['id', 'interest_id', 'player_id', 'details'], members)
    insert('interest_programmes', ['interest_id', 'programme_id', 'status', 'created_at'], progs)
  }

  it('pages, counts and groups competition players in SQL, never scanning the rosters', async () => {
    seed()
    for (const leagueId of ['tnl', null]) {
      stats.reset()
      const l = await listPlayers(db, q({ leagueId, retired: 'any' }), NOW)
      expect(stats.queries).toBeLessThanOrEqual(10)
      expect(stats.maxParams).toBeLessThan(100)
      for (const s of stats.log) expect(planOf(sqlite, s).filter((d) => /^SCAN (season_team_players|r|h|l)\b/.test(d))).toEqual([])
      expect(l.rows).toHaveLength(50)
      expect(l.total).toBe(1504)
      // The same groups groupOf() gives, for everyone.
      const all = await db.select({ id: players.id, retiredAt: players.retiredAt }).from(players).where(eq(players.pool, 'competition'))
      const seasonsAll = await db.select({ id: seasons.id, leagueId: seasons.leagueId, startDate: seasons.startDate }).from(seasons)
      const spots = await db.select().from(seasonTeamPlayers)
      const open = await db
        .select({
          playerId: interestMembers.playerId,
          programmeId: interestProgrammes.programmeId,
          createdAt: interestProgrammes.createdAt,
        })
        .from(interestProgrammes)
        .innerJoin(interestMembers, eq(interestMembers.interestId, interestProgrammes.interestId))
        .where(inArray(interestProgrammes.status, ['new', 'contacted']))
      const leagueOf = new Map(seasonsAll.map((x) => [x.id, x.leagueId]))
      const expected: Record<string, number> = { interest: 0, last: 0, past: 0, retired: 0, other: 0 }
      const rank = ['interest', 'last', 'past', 'other']
      for (const p of all) {
        const mine = spots.filter((x) => x.playerId === p.id)
        const forLeague = (lid: string) =>
          groupOf(
            {
              retiredAt: p.retiredAt,
              leagueSeasonIds: mine.filter((x) => leagueOf.get(x.seasonId) === lid).map((x) => x.seasonId),
              playedElsewhere: mine.some((x) => leagueOf.get(x.seasonId) !== lid),
              openInterestDates: open.filter((o) => o.playerId === p.id && o.programmeId === lid).map((o) => o.createdAt.slice(0, 10)),
            },
            leagueWindow(
              seasonsAll.filter((x) => x.leagueId === lid),
              { today: '2026-10-20' },
            ),
          )
        const g = leagueId
          ? forLeague(leagueId)
          : p.retiredAt
            ? 'retired'
            : (['tnl', 'fnl', 'snl'].map(forLeague).toSorted((a, b) => rank.indexOf(a) - rank.indexOf(b))[0] ?? 'other')
        expected[g]!++
      }
      expect(l.groupCounts).toMatchObject(expected)
      expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(1504)
    }
    // A later page and a group page, still within the limits.
    stats.reset()
    const page3 = await listPlayers(db, q({ leagueId: 'fnl', group: 'past', page: 3 }), NOW)
    expect(page3.page).toBe(3)
    expect(page3.rows.every((r) => r.group === 'past')).toBe(true)
    expect(stats.queries).toBeLessThanOrEqual(10)
  })

  it("the season builder's picker reads this league's rosters plus one latest spot per player", async () => {
    seed()
    stats.reset()
    const d = await competitionDirectory(db, { leagueId: 'tnl', seasonId: 'tnl-2025-4', today: '2026-10-20' })
    expect(stats.queries).toBeLessThanOrEqual(8)
    expect(stats.maxParams).toBeLessThan(100)
    expect(d.players).toHaveLength(1504)
    expect(d.lastSeason?.id).toBe('tnl-2025-3')
    const inSeason = d.players.filter((p) => p.inSeason.length > 0)
    expect(inSeason).toHaveLength(100)
    // The season being built isn't anyone's "last" spot.
    expect(d.players.some((p) => p.lastInLeague?.seasonId === 'tnl-2025-4' || p.lastAnywhere?.seasonId === 'tnl-2025-4')).toBe(false)
  })

  it('exports up to EXPORT_LIMIT and says when it stopped', async () => {
    seed()
    const r = await exportPlayers(db, admin, q({ retired: 'any' }), NOW)
    expect(r.truncated).toBe(false)
    expect(r.csv.trim().split('\r\n')).toHaveLength(1505)
  })
})
