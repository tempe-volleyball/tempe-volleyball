import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import * as schema from './schema'
import { applyMigration, createMigratedSqlite, createTestDb, migrationFiles } from './testing'

// Migration 0003 (Phase 6): programmes, categories, sessions/terms/events, enrolment, fixtures parity, menu, page
// data refs and analytics. docs/data-model-phase6.md.

const PHASE6 = '0003_phase6_programmes.sql'

const failsWith = async (query: PromiseLike<unknown>, pattern: RegExp) => {
  const error = await Promise.resolve(query).then(
    () => null,
    (e: unknown) => e as Error & { cause?: Error },
  )
  expect(error, 'expected the query to fail').not.toBeNull()
  expect(error?.cause?.message ?? error?.message).toMatch(pattern)
}

const settings: schema.SeasonSettings = {
  sessions: ['18:30'],
  sessionMinutes: 60,
  meetings: 1,
  includeFinals: false,
  seed: 1,
  skipDates: [],
  defaultCourtIds: [],
}

const seedLeague = async (db: ReturnType<typeof createTestDb>['db']) => {
  const [venue] = await db.insert(schema.venues).values({ name: 'Robyn Webster Sports Centre', slug: 'tempe' }).returning()
  const [league] = await db
    .insert(schema.programmes)
    .values({
      code: 'TNL',
      name: 'Thursday Night League',
      slug: 'tnl',
      weekday: 4,
      defaultVenueId: venue!.id,
      categoryId: 'cat_mixed_leagues',
    })
    .returning()
  const [season] = await db
    .insert(schema.seasons)
    .values({ leagueId: league!.id, name: 'TNL Q4 2026', slug: 'tnl-q4-2026', year: 2026, quarter: 4, startDate: '2026-10-08', settings })
    .returning()
  return { venue: venue!, league: league!, season: season! }
}

describe('migration 0003', () => {
  it('seeds the four categories', () => {
    expect(migrationFiles()).toContain(PHASE6)
    const sqlite = createMigratedSqlite()
    const rows = sqlite.prepare('SELECT id, name, slug, sort, status, intro FROM categories ORDER BY sort').all()
    expect(rows).toEqual([
      {
        id: 'cat_mixed_leagues',
        name: 'Mixed Leagues',
        slug: 'mixed-leagues',
        sort: 1,
        status: 'active',
        intro: '{"blocks":[],"html":""}',
      },
      { id: 'cat_super_league', name: 'Super League', slug: 'super-league', sort: 2, status: 'active', intro: '{"blocks":[],"html":""}' },
      { id: 'cat_juniors', name: 'Juniors', slug: 'juniors', sort: 3, status: 'active', intro: '{"blocks":[],"html":""}' },
      {
        id: 'cat_adult_training',
        name: 'Adult Training',
        slug: 'adult-training',
        sort: 4,
        status: 'active',
        intro: '{"blocks":[],"html":""}',
      },
    ])
  })

  it('turns existing leagues into league programmes in their categories (as on staging)', () => {
    const sqlite = createMigratedSqlite({ before: PHASE6 })
    const insert = sqlite.prepare('INSERT INTO leagues (id, code, name, slug, weekday, format, active) VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run('l-tnl', 'TNL', 'Thursday Night League', 'tnl', 4, 'social', 1)
    insert.run('l-sal', 'SAL', 'Sunday Afternoon League', 'sal', 0, 'social', 1)
    insert.run('l-tvsl', 'TVSL', 'Tempe Volleyball Super League', 'tvsl', 0, 'super', 1)
    insert.run('l-mon', 'MNL', 'Monday Night League', 'mnl', 1, 'social', 0)
    sqlite.prepare("INSERT INTO menu_items (id, label, kind, url) VALUES ('m1', 'Home', 'url', '/')").run()
    applyMigration(sqlite, PHASE6)

    const leagues = sqlite
      .prepare('SELECT id, kind, category_id, status, retired_at IS NOT NULL AS retired, menu_visible FROM leagues ORDER BY id')
      .all()
    expect(leagues).toEqual([
      { id: 'l-mon', kind: 'league', category_id: null, status: 'retired', retired: 1, menu_visible: 1 },
      { id: 'l-sal', kind: 'league', category_id: 'cat_mixed_leagues', status: 'active', retired: 0, menu_visible: 1 },
      { id: 'l-tnl', kind: 'league', category_id: 'cat_mixed_leagues', status: 'active', retired: 0, menu_visible: 1 },
      { id: 'l-tvsl', kind: 'league', category_id: 'cat_super_league', status: 'active', retired: 0, menu_visible: 1 },
    ])
    expect(sqlite.prepare("SELECT hidden, category_id FROM menu_items WHERE id = 'm1'").get()).toEqual({ hidden: 0, category_id: null })
  })

  it('keeps ON DELETE on every foreign key it adds to an existing table', () => {
    const sqlite = createMigratedSqlite()
    const onDelete = (table: string, from: string) =>
      (sqlite.prepare(`PRAGMA foreign_key_list(\`${table}\`)`).all() as { from: string; on_delete: string }[]).find((f) => f.from === from)
        ?.on_delete
    expect(onDelete('leagues', 'category_id')).toBe('RESTRICT')
    expect(onDelete('leagues', 'image_id')).toBe('SET NULL')
    expect(onDelete('leagues', 'enrolment_form_id')).toBe('SET NULL')
    expect(onDelete('matches', 'original_match_day_id')).toBe('SET NULL')
    expect(onDelete('menu_items', 'category_id')).toBe('CASCADE')
    expect(onDelete('groups', 'team_id')).toBe('SET NULL')
    expect(onDelete('products', 'programme_id')).toBe('RESTRICT')
    expect(onDelete('products', 'session_id')).toBe('CASCADE')
    expect(onDelete('products', 'term_id')).toBe('CASCADE')
    expect(onDelete('products', 'event_id')).toBe('CASCADE')
    expect(onDelete('products', 'form_id')).toBe('SET NULL')
    expect(onDelete('registrations', 'paid_marked_by')).toBe('SET NULL')
    expect(onDelete('registrations', 'form_id')).toBe('SET NULL')
  })
})

describe('programmes and categories', () => {
  it('default new programmes to an active league with enrolment closed', async () => {
    const { db } = createTestDb()
    const { league } = await seedLeague(db)
    expect(league).toMatchObject({
      kind: 'league',
      status: 'active',
      menuVisible: true,
      enrolmentOpen: false,
      allowTeamEntries: true,
      allowFreeAgents: true,
      waitlistEnabled: true,
      waitlistOfferHours: 48,
      description: { blocks: [], html: '' },
      summaryLine: null,
    })
    const found = await db.query.programmes.findFirst({ where: eq(schema.programmes.id, league.id), with: { category: true } })
    expect(found?.category?.slug).toBe('mixed-leagues')
  })

  it('keeps codes and slugs unique across every kind', async () => {
    const { db } = createTestDb()
    await seedLeague(db)
    const base = { name: 'Training', weekday: 4, kind: 'training' as const, categoryId: 'cat_adult_training' }
    await failsWith(db.insert(schema.programmes).values({ ...base, code: 'TNL', slug: 'scrim' }), /UNIQUE/)
    await failsWith(db.insert(schema.programmes).values({ ...base, code: 'SCT', slug: 'tnl' }), /UNIQUE/)
    const [sct] = await db
      .insert(schema.programmes)
      .values({ ...base, code: 'SCT', slug: 'scrim' })
      .returning()
    expect(sct!.kind).toBe('training')
  })

  it("won't delete a category that still has programmes, and deletes its menu items with it", async () => {
    const { db, sqlite } = createTestDb()
    await seedLeague(db)
    await failsWith(db.delete(schema.categories).where(eq(schema.categories.id, 'cat_mixed_leagues')), /FOREIGN KEY/)
    await db.insert(schema.menuItems).values({ label: 'Juniors', kind: 'category', categoryId: 'cat_juniors' })
    await db.delete(schema.categories).where(eq(schema.categories.id, 'cat_juniors'))
    expect(sqlite.prepare('SELECT count(*) AS n FROM menu_items').get()).toEqual({ n: 0 })
  })
})

describe('sessions, terms and events', () => {
  it('belong to a programme, and a term takes its sessions with it', async () => {
    const { db, sqlite } = createTestDb()
    const [jdp] = await db
      .insert(schema.programmes)
      .values({ code: 'JDP', name: 'Junior Development Program', slug: 'jdp', weekday: 6, kind: 'development', categoryId: 'cat_juniors' })
      .returning()
    const [term] = await db
      .insert(schema.developmentTerms)
      .values({ programmeId: jdp!.id, name: 'Term 4 2026', slug: 'term-4-2026', startDate: '2026-10-17', ageGroup: 'Ages 8–11' })
      .returning()
    await db.insert(schema.programmeSessions).values([
      { programmeId: jdp!.id, termId: term!.id, date: '2026-10-17' },
      { programmeId: jdp!.id, termId: term!.id, date: '2026-10-24', status: 'postponed', originalDate: '2026-10-24' },
    ])
    await failsWith(
      db.insert(schema.developmentTerms).values({ programmeId: jdp!.id, name: 'Again', slug: 'term-4-2026', startDate: '2027-01-01' }),
      /UNIQUE/,
    )
    // A programme with instances can't be deleted, only retired.
    await failsWith(db.delete(schema.programmes).where(eq(schema.programmes.id, jdp!.id)), /FOREIGN KEY/)
    await db.delete(schema.developmentTerms).where(eq(schema.developmentTerms.id, term!.id))
    expect(sqlite.prepare('SELECT count(*) AS n FROM programme_sessions').get()).toEqual({ n: 0 })

    const [cup] = await db
      .insert(schema.programmes)
      .values({ code: 'CUP', name: 'Tempe Cup', slug: 'tempe-cup', weekday: 6, kind: 'event', categoryId: 'cat_mixed_leagues' })
      .returning()
    const [event] = await db
      .insert(schema.events)
      .values({ programmeId: cup!.id, name: 'Tempe Cup 2026', slug: '2026', startDate: '2026-12-05', endDate: '2026-12-06' })
      .returning()
    expect(event!.status).toBe('scheduled')
  })
})

const setupEnrolment = async () => {
  const t = createTestDb()
  const { league, season } = await seedLeague(t.db)
  const [form] = await t.db
    .insert(schema.enrolmentForms)
    .values({
      name: 'League entry',
      fields: [{ key: 'division', type: 'select', label: 'Division', options: [{ value: 'a', label: 'A' }] }],
    })
    .returning()
  const [product] = await t.db
    .insert(schema.products)
    .values({
      kind: 'season_entry',
      name: 'TNL Q4 2026',
      slug: 'tnl-q4-2026',
      priceCents: 9000,
      programmeId: league.id,
      seasonId: season.id,
      capacityTeams: 10,
      formId: form!.id,
    })
    .returning()
  const [player] = await t.db.insert(schema.players).values({ firstName: 'Sam', lastName: 'Lee', email: 'sam@example.com' }).returning()
  return { ...t, league, season, form: form!, product: product!, player: player! }
}

describe('enrolment', () => {
  it('allows one product per target', async () => {
    const { db, sqlite, league, season } = await setupEnrolment()
    expect(sqlite.prepare('SELECT count(*) AS n FROM products').get()).toEqual({ n: 1 })
    await failsWith(
      db
        .insert(schema.products)
        .values({ kind: 'season_entry', name: 'Dup', slug: 'dup', priceCents: 0, programmeId: league.id, seasonId: season.id }),
      /UNIQUE/,
    )
  })

  it('allows one live registration per player per product, and re-enrolling after a cancellation', async () => {
    const { db, product, player, form } = await setupEnrolment()
    const [first] = await db
      .insert(schema.registrations)
      .values({
        productId: product.id,
        playerId: player.id,
        reference: 'TVB-AAAA',
        status: 'confirmed',
        formId: form.id,
        formVersion: 1,
        amountCents: 9000,
      })
      .returning()
    expect(first).toMatchObject({ freeAgent: false, paidAt: null, source: 'public' })
    await failsWith(
      db.insert(schema.registrations).values({ productId: product.id, playerId: player.id, reference: 'TVB-BBBB', status: 'waitlist' }),
      /UNIQUE/,
    )
    await db.update(schema.registrations).set({ status: 'cancelled' }).where(eq(schema.registrations.id, first!.id))
    await db.insert(schema.registrations).values({
      productId: product.id,
      playerId: player.id,
      reference: 'TVB-CCCC',
      status: 'waitlist',
      waitlistPosition: 1,
      freeAgent: true,
    })
  })

  it('keeps team names unique per product among live entries', async () => {
    const { db, product, player } = await setupEnrolment()
    const [team] = await db
      .insert(schema.groups)
      .values({ kind: 'team', name: 'Spikers', productId: product.id, captainPlayerId: player.id })
      .returning()
    expect(team).toMatchObject({ status: 'confirmed', answers: {}, waitlistPosition: null })
    await failsWith(db.insert(schema.groups).values({ kind: 'team', name: 'Spikers', productId: product.id }), /UNIQUE/)
    await db.update(schema.groups).set({ status: 'cancelled' }).where(eq(schema.groups.id, team!.id))
    await db.insert(schema.groups).values({ kind: 'team', name: 'Spikers', productId: product.id, status: 'waitlist', waitlistPosition: 1 })
  })

  it('protects a session with enrolments from deletion but removes an unused product with it', async () => {
    const { db, sqlite, player } = await setupEnrolment()
    const [scrim] = await db
      .insert(schema.programmes)
      .values({
        code: 'SCT',
        name: 'Scrim & Coached Training',
        slug: 'scrim',
        weekday: 4,
        kind: 'training',
        categoryId: 'cat_adult_training',
        capPlayers: 40,
      })
      .returning()
    const sessions = await db
      .insert(schema.programmeSessions)
      .values([
        { programmeId: scrim!.id, date: '2026-10-22' },
        { programmeId: scrim!.id, date: '2026-10-29' },
      ])
      .returning()
    const [a, b] = sessions
    const products = await db
      .insert(schema.products)
      .values([
        {
          kind: 'training_session',
          name: 'Training 22 Oct',
          slug: 'sct-2026-10-22',
          priceCents: 1500,
          programmeId: scrim!.id,
          sessionId: a!.id,
          capacity: 32,
        },
        {
          kind: 'training_session',
          name: 'Training 29 Oct',
          slug: 'sct-2026-10-29',
          priceCents: 1500,
          programmeId: scrim!.id,
          sessionId: b!.id,
        },
      ])
      .returning()
    await db
      .insert(schema.registrations)
      .values({ productId: products[0]!.id, playerId: player.id, reference: 'TVB-DDDD', status: 'confirmed' })
    await failsWith(db.delete(schema.programmeSessions).where(eq(schema.programmeSessions.id, a!.id)), /FOREIGN KEY/)
    await db.delete(schema.programmeSessions).where(eq(schema.programmeSessions.id, b!.id))
    expect(sqlite.prepare("SELECT count(*) AS n FROM products WHERE kind = 'training_session'").get()).toEqual({ n: 1 })
  })
})

describe('fixtures parity', () => {
  it('stores withdrawals, moved nights, postponed games and outcome overrides', async () => {
    const { db } = createTestDb()
    const { season } = await seedLeague(db)
    const [home, away] = await db
      .insert(schema.teams)
      .values([
        { name: 'Spikers', slug: 'spikers' },
        { name: 'Diggers', slug: 'diggers' },
      ])
      .returning()
    await db.insert(schema.seasonTeams).values([
      { seasonId: season.id, teamId: home!.id, withdrawnAt: '2026-10-20T00:00:00.000Z', withdrawnReason: 'Not enough players' },
      { seasonId: season.id, teamId: away!.id },
    ])
    const [first, moved] = await db
      .insert(schema.matchDays)
      .values([
        { seasonId: season.id, date: '2026-10-08', number: 1, status: 'postponed', note: 'Venue unavailable' },
        { seasonId: season.id, date: '2026-10-22', number: 2, originalDate: '2026-10-15' },
      ])
      .returning()
    expect(first!.status).toBe('postponed')
    const [match] = await db
      .insert(schema.matches)
      .values({
        seasonId: season.id,
        matchDayId: moved!.id,
        originalMatchDayId: first!.id,
        session: 0,
        position: 0,
        homeTeamId: home!.id,
        awayTeamId: away!.id,
        status: 'tbd',
        statusNote: 'Time to be confirmed',
      })
      .returning()
    await db
      .insert(schema.matchResults)
      .values({ matchId: match!.id, kind: 'published', homeSets: 0, awaySets: 0, outcome: 'away', note: 'Forfeit' })
    const found = await db.query.matches.findFirst({
      where: eq(schema.matches.id, match!.id),
      with: { originalMatchDay: true, matchDay: true },
    })
    expect(found?.originalMatchDay?.date).toBe('2026-10-08')
    expect(found?.matchDay.date).toBe('2026-10-22')
    // Deleting the original night keeps the game.
    await db.delete(schema.matchDays).where(eq(schema.matchDays.id, first!.id))
    expect((await db.query.matches.findFirst({ where: eq(schema.matches.id, match!.id) }))?.originalMatchDayId).toBeNull()
  })
})

describe('page data refs and analytics', () => {
  it('records which data a page reads and drops the rows with the page', async () => {
    const { db, sqlite } = createTestDb()
    const { league } = await seedLeague(db)
    const [page] = await db
      .insert(schema.pages)
      .values({ path: '/enrol', title: 'Enrol', body: { blocks: [], html: '' } })
      .returning()
    await db.insert(schema.pageDataRefs).values([
      { pageId: page!.id, kind: 'programme_list' },
      { pageId: page!.id, kind: 'ladder', refId: league.id },
    ])
    await failsWith(db.insert(schema.pageDataRefs).values({ pageId: page!.id, kind: 'programme_list' }), /UNIQUE/)
    await db.delete(schema.pages).where(eq(schema.pages.id, page!.id))
    expect(sqlite.prepare('SELECT count(*) AS n FROM page_data_refs').get()).toEqual({ n: 0 })
  })

  it('upserts one value per source, day, metric and breakdown', async () => {
    const { db } = createTestDb()
    const row = {
      source: 'ga4' as const,
      date: '2026-10-17',
      metric: 'screenPageViews',
      dimension: 'pagePath',
      dimensionValue: '/leagues/tnl',
      value: 90,
    }
    await db.insert(schema.analyticsDaily).values([row, { ...row, dimension: '', dimensionValue: '', value: 400 }])
    await db
      .insert(schema.analyticsDaily)
      .values({ ...row, value: 96 })
      .onConflictDoUpdate({
        target: [
          schema.analyticsDaily.source,
          schema.analyticsDaily.date,
          schema.analyticsDaily.metric,
          schema.analyticsDaily.dimension,
          schema.analyticsDaily.dimensionValue,
        ],
        set: { value: 96 },
      })
    const rows = await db.select().from(schema.analyticsDaily)
    expect(rows.map((r) => [r.dimensionValue, r.value]).toSorted()).toEqual([
      ['', 400],
      ['/leagues/tnl', 96],
    ])
    await db.insert(schema.analyticsState).values({ source: 'ga4' })
    await db.insert(schema.analyticsFetches).values({ source: 'ga4', startedAt: '2026-10-18T16:00:00.000Z' })
    expect((await db.select().from(schema.analyticsState))[0]).toMatchObject({ enabled: true, cursor: {} })
  })
})
