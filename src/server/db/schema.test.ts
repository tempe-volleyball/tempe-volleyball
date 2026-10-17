import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import * as schema from './schema'
import { createMigratedSqlite, createTestDb, migrationFiles } from './testing'

const EXPECTED_TABLES = [
  // Better Auth
  'user',
  'session',
  'account',
  'verification',
  'two_factor',
  // Competition
  'venues',
  'courts',
  'leagues',
  'seasons',
  'teams',
  'season_teams',
  'match_days',
  'matches',
  'match_results',
  'ladder_adjustments',
  // Content
  'pages',
  'page_revisions',
  'posts',
  'menu_items',
  'media',
  'redirects',
  'site_settings',
  // Admin
  'admin_invites',
  'audit_log',
  // Registrations and payments
  'products',
  'players',
  'groups',
  'registrations',
  'payments',
  'stripe_events',
  'email_outbox',
  'email_daily_count',
]

/** Drizzle wraps driver errors ("Failed query: …"); the SQLite message is on `cause`. */
const failsWith = async (query: PromiseLike<unknown>, pattern: RegExp) => {
  const error = await Promise.resolve(query).then(
    () => null,
    (e: unknown) => e as Error & { cause?: Error },
  )
  expect(error, 'expected the query to fail').not.toBeNull()
  expect(error?.cause?.message ?? error?.message).toMatch(pattern)
}

const settings: schema.SeasonSettings = {
  sessions: ['18:30', '19:30'],
  sessionMinutes: 60,
  meetings: 1,
  includeFinals: true,
  seed: 1,
  skipDates: [],
  defaultCourtIds: [],
}

/** Seeds one venue, court, league, season, two teams and a match day; returns their ids. */
const seed = async (db: ReturnType<typeof createTestDb>['db']) => {
  const [venue] = await db.insert(schema.venues).values({ name: 'Robyn Webster Sports Centre', slug: 'tempe' }).returning()
  const [court] = await db.insert(schema.courts).values({ venueId: venue!.id, name: 'Court 1' }).returning()
  const [league] = await db
    .insert(schema.leagues)
    .values({ code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4, defaultVenueId: venue!.id })
    .returning()
  const [season] = await db
    .insert(schema.seasons)
    .values({ leagueId: league!.id, name: 'TNL Q4 2026', slug: 'tnl-q4-2026', year: 2026, quarter: 4, startDate: '2026-10-08', settings })
    .returning()
  const [home, away] = await db
    .insert(schema.teams)
    .values([
      { name: 'Spikers', slug: 'spikers' },
      { name: 'Diggers', slug: 'diggers' },
    ])
    .returning()
  const [day] = await db.insert(schema.matchDays).values({ seasonId: season!.id, date: '2026-10-08', number: 1 }).returning()
  return { venue: venue!, court: court!, league: league!, season: season!, home: home!, away: away!, day: day! }
}

describe('migrations', () => {
  it('apply cleanly, in order, to an empty SQLite database', () => {
    expect(migrationFiles()[0]).toBe('0000_init.sql')
    const sqlite = createMigratedSqlite()
    const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name)
    expect(tables).toEqual(expect.arrayContaining(EXPECTED_TABLES))
  })

  it('have no foreign keys pointing at missing tables or columns', () => {
    const sqlite = createMigratedSqlite()
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    for (const table of EXPECTED_TABLES) {
      const fks = sqlite.prepare(`PRAGMA foreign_key_list(\`${table}\`)`).all() as { table: string; to: string }[]
      for (const fk of fks) {
        const cols = (sqlite.prepare(`PRAGMA table_info(\`${fk.table}\`)`).all() as { name: string }[]).map((c) => c.name)
        expect(cols, `${table} -> ${fk.table}.${fk.to}`).toContain(fk.to)
      }
    }
  })

  it('index every foreign key column', () => {
    const sqlite = createMigratedSqlite()
    const missing: string[] = []
    for (const table of EXPECTED_TABLES) {
      const fks = sqlite.prepare(`PRAGMA foreign_key_list(\`${table}\`)`).all() as { from: string }[]
      const indexes = sqlite.prepare(`PRAGMA index_list(\`${table}\`)`).all() as { name: string }[]
      // A column is covered when it is the first column of some index (including the primary key's).
      const leading = new Set(
        indexes.map(
          (i) =>
            (sqlite.prepare(`PRAGMA index_info(\`${i.name}\`)`).all() as { seqno: number; name: string }[]).find((c) => c.seqno === 0)
              ?.name,
        ),
      )
      for (const fk of fks) {
        // updated_by is on almost every table and only read alongside the row, so it isn't indexed.
        if (fk.from === 'updated_by') continue
        if (!leading.has(fk.from)) missing.push(`${table}.${fk.from}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe('schema', () => {
  it('fills ids and ISO timestamps by default', async () => {
    const { db } = createTestDb()
    const { season } = await seed(db)
    expect(season.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(season.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(season.status).toBe('draft')
    expect([season.pointsWin, season.pointsDraw, season.pointsLoss]).toEqual([3, 2, 1])
    expect(season.settings).toEqual(settings)
    expect(season.dutyEnabled).toBe(true)
  })

  it('uses SQL defaults for rows inserted without Drizzle', () => {
    const sqlite = createMigratedSqlite()
    sqlite.exec("INSERT INTO teams (id, name, slug) VALUES ('t1', 'Raw', 'raw')")
    const row = sqlite.prepare("SELECT created_at, updated_at FROM teams WHERE id = 't1'").get() as {
      created_at: string
      updated_at: string
    }
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(row.updated_at).toBe(row.created_at)
  })

  it('stores matches with team or label sides and draft/published results', async () => {
    const { db } = createTestDb()
    const { season, day, court, home, away } = await seed(db)
    const [match] = await db
      .insert(schema.matches)
      .values({
        seasonId: season.id,
        matchDayId: day.id,
        session: 0,
        position: 0,
        startTime: '18:30',
        courtId: court.id,
        homeTeamId: home.id,
        awayTeamId: away.id,
        dutyLabel: 'Loser SF1',
      })
      .returning()
    await db.insert(schema.matchResults).values([
      {
        matchId: match!.id,
        kind: 'draft',
        homeSets: 2,
        awaySets: 0,
        setScores: [
          [25, 20],
          [25, 18],
        ],
      },
      {
        matchId: match!.id,
        kind: 'published',
        homeSets: 1,
        awaySets: 1,
        setScores: [
          [25, 20],
          [18, 25],
        ],
      },
    ])

    const found = await db.query.matches.findFirst({
      where: eq(schema.matches.id, match!.id),
      with: { homeTeam: true, awayTeam: true, court: true, results: true, matchDay: true },
    })
    expect(found?.homeTeam?.name).toBe('Spikers')
    expect(found?.awayTeam?.name).toBe('Diggers')
    expect(found?.court?.name).toBe('Court 1')
    expect(found?.dutyLabel).toBe('Loser SF1')
    expect(found?.results.find((r) => r.kind === 'published')?.setScores).toEqual([
      [25, 20],
      [18, 25],
    ])

    // One result row per (match, kind).
    await failsWith(db.insert(schema.matchResults).values({ matchId: match!.id, kind: 'draft' }), /UNIQUE/)
  })

  it('enforces unique paths, slugs, references and (league, year, quarter)', async () => {
    const { db } = createTestDb()
    const { league } = await seed(db)
    const body = { blocks: [], html: '' }
    await db.insert(schema.pages).values({ path: '/about', title: 'About', body })
    await failsWith(db.insert(schema.pages).values({ path: '/about', title: 'Again', body }), /UNIQUE/)
    await db.insert(schema.redirects).values({ fromPath: '/old', toPath: '/new' })
    await failsWith(db.insert(schema.redirects).values({ fromPath: '/old', toPath: '/x' }), /UNIQUE/)
    await failsWith(db.insert(schema.teams).values({ name: 'Spikers 2', slug: 'spikers' }), /UNIQUE/)
    await failsWith(
      db
        .insert(schema.seasons)
        .values({ leagueId: league.id, name: 'Dup', slug: 'dup', year: 2026, quarter: 4, startDate: '2026-10-08', settings }),
      /UNIQUE/,
    )

    const [product] = await db
      .insert(schema.products)
      .values({ kind: 'training_session', name: 'Training', slug: 'training', priceCents: 1500, capacity: 40 })
      .returning()
    expect(product!.paymentMethods).toEqual(['stripe', 'payid'])
    const [player] = await db.insert(schema.players).values({ firstName: 'Sam', lastName: 'Lee', email: 'sam@example.com' }).returning()
    await db.insert(schema.registrations).values({ productId: product!.id, playerId: player!.id, reference: 'TVB-7K3Q' })
    await failsWith(
      db.insert(schema.registrations).values({ productId: product!.id, playerId: player!.id, reference: 'TVB-7K3Q' }),
      /UNIQUE/,
    )
  })

  it('enforces foreign keys and cascades a season delete to its draw', async () => {
    const { db, sqlite } = createTestDb()
    const { season, day, home, away } = await seed(db)
    await failsWith(db.insert(schema.courts).values({ venueId: 'nope', name: 'Court 9' }), /FOREIGN KEY/)
    await db.insert(schema.seasonTeams).values([
      { seasonId: season.id, teamId: home.id, sort: 0 },
      { seasonId: season.id, teamId: away.id, sort: 1 },
    ])
    await db
      .insert(schema.matches)
      .values({ seasonId: season.id, matchDayId: day.id, session: 0, position: 0, homeTeamId: home.id, awayTeamId: away.id })
    await db.delete(schema.seasons).where(eq(schema.seasons.id, season.id))
    const count = (t: string) => (sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
    expect([count('season_teams'), count('match_days'), count('matches'), count('teams')]).toEqual([0, 0, 0, 2])
  })

  it('gives Better Auth users the editor role by default', async () => {
    const { db } = createTestDb()
    const [u] = await db
      .insert(schema.user)
      .values({ id: 'u1', name: 'Michael', email: 'm@example.com', updatedAt: new Date() })
      .returning()
    expect(u!.role).toBe('editor')
    expect(u!.twoFactorEnabled).toBe(false)
    // Deleting a user nulls updated_by on content rather than blocking.
    const [team] = await db.insert(schema.teams).values({ name: 'A', slug: 'a', updatedBy: 'u1' }).returning()
    await db.delete(schema.user).where(eq(schema.user.id, 'u1'))
    const after = await db.query.teams.findFirst({ where: eq(schema.teams.id, team!.id) })
    expect(after?.updatedBy).toBeNull()
  })
})
