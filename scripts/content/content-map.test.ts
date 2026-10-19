import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { checkBlocks, type JsonNode } from '../../src/lib/content/render'
import { checkPagePath } from '../../src/lib/content/paths'
import { isReservedProgrammeSlug } from '../../src/lib/programmes'
import { createTestDb, type TestDb } from '../../src/server/db/testing'
import { auditActions, PROGRAMME_CODE_PATTERN } from '../../src/server/db/schema/enums'
import { auditLog, categories, leagues, pageRevisions, pages, redirects, user, venues } from '../../src/server/db/schema'
import { getPage, restoreRevision } from '../../src/server/content/pages'
import { listProgrammes } from '../../src/server/programmes/programmes'
import { lookupPath } from '../../src/server/site'
import { stableId } from '../wp/ids'
import {
  ARCHIVE,
  CAT,
  CATEGORY_INTROS,
  DRAFT_PROGRAMMES,
  ENROL_PAGE,
  CONTACT_LIVE,
  LATER_REDIRECTS,
  LEAGUE_UPDATES,
  LIVE_PAGES,
  PAGE_DRAFTS,
  PRIVACY_PAGE,
  REDIRECT_FIXES,
  TNL_DESCRIPTION,
  VENUE_DIRECTIONS,
  draftPath,
  programmeSlug,
} from './drafts'
import { contentId, contentMapSql, contentMapStatements } from './sql'

type Sqlite = ReturnType<typeof createTestDb>['sqlite']

let db: TestDb
let sqlite: Sqlite

const IMPORTED_HTML = '<p>Imported from WordPress.</p>'
const pageId = (wpId: number) => stableId('page', wpId)

/** Rows as the importer and migration 0003 leave them on staging. */
async function seed() {
  await db.insert(venues).values([
    { id: 'v-tempe', name: 'Robyn Webster Sports Centre', slug: 'robyn-webster-sports-centre', address: 'Holbeach Ave, Tempe NSW 2044' },
    { id: 'v-mlc', name: 'MLC School', slug: 'mlc-school', address: 'Rowley St, Burwood NSW 2134' },
    { id: 'v-fd', name: 'Five Dock Leisure Centre', slug: 'five-dock-leisure-centre', address: 'William St, Five Dock NSW 2046' },
  ])
  await db.insert(leagues).values(
    [
      ['TNL', 'Thursday Night League', 4, CAT.mixed],
      ['FNL', 'Friday Night League', 5, CAT.mixed],
      ['SNL', 'Saturday Night League', 6, CAT.mixed],
      ['SAL', 'Sunday Afternoon League', 0, CAT.mixed],
      ['TVSL', 'Tempe Volleyball Super League', 0, CAT.superLeague],
    ].map(([code, name, weekday, categoryId]) => ({
      id: `l-${code}`,
      code: code as string,
      name: name as string,
      slug: (code as string).toLowerCase(),
      weekday: weekday as number,
      categoryId: categoryId as string,
      defaultVenueId: 'v-tempe',
    })),
  )
  const imported = [
    ...PAGE_DRAFTS.map((d) => ({ path: d.path, wpId: d.wpId, title: d.importedTitle })),
    ...ARCHIVE.map((a) => ({ path: a.path, wpId: a.wpId, title: a.importedTitle })),
    ...LATER_REDIRECTS.map((r, i) => ({ path: r.from, wpId: 90_000 + i, title: `Later ${i}` })),
  ]
  await db.insert(pages).values(
    imported.map((p) => ({
      id: pageId(p.wpId),
      path: p.path,
      title: p.title,
      body: { blocks: [], html: IMPORTED_HTML },
      status: 'published' as const,
      publishedAt: '2022-01-01T00:00:00.000Z',
      wpId: p.wpId,
      updatedAt: '2026-10-17T13:41:00.000Z',
    })),
  )
  // The redirects the public-pages agent already wrote for the old enrolment pages.
  await db
    .insert(redirects)
    .values(['/2021-interest-in-playing', '/new-player'].map((from) => ({ fromPath: from, toPath: '/enrol', source: 'manual' as const })))
}

const run = () => {
  for (const s of contentMapStatements()) sqlite.exec(s)
}

/** Everything a run could change, to compare runs. */
const snapshot = () =>
  ['leagues', 'categories', 'venues', 'pages', 'page_revisions', 'redirects', 'audit_log'].map((t) =>
    sqlite
      .prepare(
        `SELECT count(*) AS n, group_concat(updated_at_or_id, '|') AS v FROM (SELECT ${t === 'audit_log' || t === 'page_revisions' ? 'id' : 'updated_at'} AS updated_at_or_id FROM "${t}" ORDER BY 1)`,
      )
      .get(),
  )

beforeEach(async () => {
  ;({ db, sqlite } = createTestDb())
  await seed()
})

describe('the drafted content', () => {
  it('is what the checked-in content-map.sql holds', () => {
    expect(readFileSync(join(import.meta.dirname, 'content-map.sql'), 'utf8')).toBe(contentMapSql())
  })

  it('passes the admin’s own checks', () => {
    const bodies = [
      ...DRAFT_PROGRAMMES.map((d) => d.description),
      ...LEAGUE_UPDATES.flatMap((u) => (u.description ? [u.description] : [])),
      ...Object.values(CATEGORY_INTROS),
      ...PAGE_DRAFTS.map((d) => d.body),
      ...LIVE_PAGES.map((d) => d.body),
      ENROL_PAGE.body,
      PRIVACY_PAGE.body,
    ]
    for (const b of bodies) {
      expect(checkBlocks(b.blocks).ok).toBe(true)
      expect(b.html.length).toBeGreaterThan(50)
      expect(b.html).not.toMatch(/\b20(2[0-9])\b/) // dateless: no years in the text
    }
    for (const d of DRAFT_PROGRAMMES) {
      expect(d.code).toMatch(PROGRAMME_CODE_PATTERN)
      expect(isReservedProgrammeSlug(programmeSlug(d))).toBe(false)
    }
    expect(new Set(DRAFT_PROGRAMMES.map((d) => d.code)).size).toBe(DRAFT_PROGRAMMES.length)
    expect(checkPagePath(ENROL_PAGE.path)).toEqual({ ok: true, path: '/enrol' })
    expect(checkPagePath(PRIVACY_PAGE.path)).toEqual({ ok: true, path: '/privacy' })
    for (const d of LIVE_PAGES) expect(d.metaDescription.length).toBeLessThanOrEqual(155)
    for (const a of contentMapSql().matchAll(/'(page\.\w+|programme\.\w+|category\.\w+|venue\.\w+)'/g)) expect(auditActions).toContain(a[1])
  })

  it('redirects nowhere that is itself archived, and keeps statements small', () => {
    const archived = new Set(ARCHIVE.map((a) => a.path))
    for (const a of ARCHIVE) expect(archived.has(a.to)).toBe(false)
    for (const r of LATER_REDIRECTS) expect(archived.has(r.to)).toBe(false)
    for (const s of contentMapStatements()) expect(new TextEncoder().encode(s).length).toBeLessThan(90_000)
  })
})

describe('applying it to an imported site', () => {
  it('adds draft programmes, intros, times and directions', async () => {
    run()
    const all = await listProgrammes(db, {})
    const drafts = all.filter((p) => p.status === 'draft')
    expect(drafts.map((p) => p.code).toSorted()).toEqual(DRAFT_PROGRAMMES.map((d) => d.code).toSorted())
    for (const p of drafts) expect(p).toMatchObject({ active: false, enrolmentOpen: false })
    const adp = await db.select().from(leagues).where(eq(leagues.code, 'ADP')).get()
    expect(adp).toMatchObject({
      kind: 'development',
      categoryId: CAT.adultTraining,
      slug: 'adult-development-program-adp',
      ageMin: 18,
      defaultVenueId: null,
    })
    expect(adp!.description.html).toContain('Saturdays, 8–10pm')
    const casual = await db.select().from(leagues).where(eq(leagues.code, 'TCT')).get()
    expect(casual).toMatchObject({ kind: 'training', defaultVenueId: 'v-tempe', capPlayers: 40, priceCents: 1500, weekday: 4 })
    expect((await db.select().from(leagues).where(eq(leagues.code, 'CUP')).get())?.allowFreeAgents).toBe(false)

    const tvsl = await db.select().from(leagues).where(eq(leagues.code, 'TVSL')).get()
    expect(tvsl).toMatchObject({ status: 'active', startTime: '19:00', endTime: '22:00' })
    expect(tvsl!.description.html).toContain('Best of five sets')
    expect((await db.select().from(leagues).where(eq(leagues.code, 'TNL')).get())?.description.html).toBe(TNL_DESCRIPTION.html)

    for (const c of await db.select().from(categories).all()) expect(c.intro.html).toBe(CATEGORY_INTROS[c.id]!.html)
    const tempe = await db.select().from(venues).where(eq(venues.id, 'v-tempe')).get()
    expect(tempe?.directions).toBe(VENUE_DIRECTIONS['robyn-webster-sports-centre'])
    expect((await db.select().from(venues).where(eq(venues.id, 'v-fd')).get())?.directions).toBeNull()

    const audits = await db.select({ action: auditLog.action }).from(auditLog).all()
    expect(audits.filter((a) => a.action === 'programme.create')).toHaveLength(DRAFT_PROGRAMMES.length)
  })

  it('offers each kept page’s proposal as the revision to restore, leaving the live page alone', async () => {
    run()
    const ed = { id: 'ed', ip: '203.0.113.9' }
    await db.insert(user).values({ id: 'ed', name: 'ed', email: 'ed@example.com', emailVerified: true, role: 'editor' })
    for (const d of PAGE_DRAFTS.filter((x) => !LIVE_PAGES.some((l) => l.path === x.path))) {
      const { page, revisions } = await getPage(db, pageId(d.wpId))
      expect(page).toMatchObject({ status: 'published', title: d.importedTitle, body: { html: IMPORTED_HTML }, updatedBy: null })
      // Newest first: the live version ("current" in the admin), then the proposal.
      expect(revisions.map((r) => r.id)).toEqual([contentId('revision-current', d.path), contentId('revision-proposed', d.path)])
      expect(revisions[1]!.title).toBe(d.title)
      const restored = await restoreRevision(db, ed, page.id, revisions[1]!.id, new Date('2026-10-20T00:00:00.000Z'))
      expect(restored.result).toMatchObject({ title: d.title, status: 'published', body: { html: d.body.html } })
    }
    // The home page's Programme list blocks are recorded for cache purges once restored.
    const home = (await getPage(db, pageId(3465))).page
    expect((home.body.blocks as JsonNode[]).filter((b) => b.type === 'programmeList')).toHaveLength(2)
  })

  it('makes /contact live with a Contact form block, keeping the old version and the proposal in Revisions', async () => {
    run()
    const { page, revisions } = await getPage(db, pageId(CONTACT_LIVE.wpId))
    expect(page).toMatchObject({ status: 'published', title: 'Contact', updatedBy: null, metaDescription: CONTACT_LIVE.metaDescription })
    expect((page.body.blocks as JsonNode[]).map((b) => b.type)).toContain('contactForm')
    // The new version on top, then the old live one (restorable), then the content map's proposal.
    expect(revisions.map((r) => r.id)).toEqual([
      contentId('revision-live', '/contact'),
      contentId('revision-current', '/contact'),
      contentId('revision-proposed', '/contact'),
    ])
    expect(revisions[1]).toMatchObject({ title: 'CONTACT' })
    expect(Date.parse(revisions[0]!.createdAt)).toBe(Date.parse(page.updatedAt))
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, 'page.publish')).all()
    expect(audit).toMatchObject({ actorUserId: null, before: { title: 'CONTACT' }, after: { title: 'Contact', path: '/contact' } })
  })

  it('adds /privacy as a draft and the missed redirects, without overwriting a redirect Michael edited', async () => {
    await db.insert(redirects).values({ fromPath: '/calendar/this-weeks-fixtures', toPath: '/leagues', source: 'wp-import' })
    run()
    const privacy = await db.select().from(pages).where(eq(pages.path, '/privacy')).get()
    expect(privacy).toMatchObject({ status: 'draft', title: 'Privacy policy', updatedBy: null })
    expect(privacy!.body.html).toContain('365 days')
    expect(privacy!.body.html).toContain('Expressions of interest')
    for (const r of REDIRECT_FIXES) expect((await lookupPath(db, r.from)).redirect).toMatchObject({ toPath: r.to, status: 301 })

    ;({ db, sqlite } = createTestDb())
    await seed()
    await db.insert(redirects).values({ fromPath: '/calendar/this-weeks-fixtures', toPath: '/somewhere', source: 'manual' })
    await db.insert(redirects).values({ fromPath: '/category/uncategorized', toPath: '/elsewhere', source: 'wp-import' })
    run()
    expect((await lookupPath(db, '/calendar/this-weeks-fixtures')).redirect?.toPath).toBe('/somewhere')
    expect((await lookupPath(db, '/category/uncategorized')).redirect?.toPath).toBe('/elsewhere')
  })

  it('adds /enrol as a draft page, archives stale pages and wires their redirects', async () => {
    run()
    const enrol = await db.select().from(pages).where(eq(pages.path, '/enrol')).get()
    expect(enrol).toMatchObject({ status: 'draft', title: 'Enrol', updatedBy: null })
    expect(await db.select().from(pageRevisions).where(eq(pageRevisions.pageId, enrol!.id)).all()).toHaveLength(1)
    expect((await lookupPath(db, '/enrol')).page).toBeUndefined()

    for (const a of ARCHIVE) {
      const found = await lookupPath(db, a.path)
      expect(found.page).toBeUndefined()
      expect(found.redirect).toMatchObject({ toPath: a.to, status: 301 })
      expect((await db.select().from(pages).where(eq(pages.path, a.path)).get())?.status).toBe('archived')
    }
    const unpublished = await db.select().from(auditLog).where(eq(auditLog.action, 'page.unpublish')).all()
    expect(unpublished).toHaveLength(ARCHIVE.length)

    // Pages that move later stay up; their redirect waits behind them.
    for (const r of LATER_REDIRECTS) {
      const found = await lookupPath(db, r.from)
      expect(found.page?.status).toBe('published')
      expect(found.redirect?.toPath).toBe(r.to)
    }
    expect(LATER_REDIRECTS.map((r) => r.to)).toContain(draftPath(DRAFT_PROGRAMMES[0]!))
  })

  it('repoints the old sign-up redirects from /enrol to /interest, unless Michael saved one', async () => {
    await db.insert(user).values({ id: 'u-edit', name: 'Michael', email: 'm@example.com', emailVerified: true, role: 'owner' })
    await db.insert(redirects).values([
      { fromPath: '/new-player-2023', toPath: '/enrol', source: 'manual' },
      { fromPath: '/2023-enrolment', toPath: '/enrol', source: 'manual', updatedBy: 'u-edit' },
    ])
    run()
    for (const from of ['/2021-interest-in-playing', '/new-player', '/new-player-2023'])
      expect((await db.select().from(redirects).where(eq(redirects.fromPath, from)).get())?.toPath).toBe('/interest')
    expect((await db.select().from(redirects).where(eq(redirects.fromPath, '/2023-enrolment')).get())?.toPath).toBe('/enrol')
  })

  it('changes nothing the second time', () => {
    run()
    const once = snapshot()
    run()
    expect(snapshot()).toEqual(once)
  })

  it('never touches what an admin has edited', async () => {
    await db.insert(user).values({ id: 'mm', name: 'Michael', email: 'm@example.com', emailVerified: true, role: 'owner' })
    const edited = ARCHIVE[0]!
    const about = PAGE_DRAFTS.find((d) => d.path === '/about-tempe-vb')!
    const faq = PAGE_DRAFTS.find((d) => d.path === '/faq')!
    await db.update(pages).set({ updatedBy: 'mm' }).where(eq(pages.path, edited.path))
    await db.update(pages).set({ title: 'About us' }).where(eq(pages.path, about.path))
    await db
      .insert(pageRevisions)
      .values({ pageId: pageId(faq.wpId), title: 'FAQ', body: { blocks: [], html: '<p>Mine</p>' }, createdBy: 'mm' })
    await db
      .update(categories)
      .set({ intro: { blocks: [], html: '<p>Michael’s intro</p>' } })
      .where(eq(categories.id, CAT.juniors))
    await db.update(leagues).set({ startTime: '19:30' }).where(eq(leagues.code, 'TNL'))
    await db.update(leagues).set({ updatedBy: 'mm' }).where(eq(leagues.code, 'TVSL'))
    await db.insert(leagues).values({
      id: 'l-adp',
      code: 'ADP',
      name: 'ADP by hand',
      slug: 'adp',
      weekday: 6,
      kind: 'development',
      categoryId: CAT.adultTraining,
    })
    await db.insert(pages).values({ path: '/enrol', title: 'Join us', body: { blocks: [], html: '<p>Hi</p>' }, status: 'published' })
    await db.insert(redirects).values({ fromPath: ARCHIVE[1]!.path, toPath: '/somewhere', source: 'manual' })

    run()
    expect((await db.select().from(pages).where(eq(pages.path, edited.path)).get())?.status).toBe('published')
    expect(
      await db
        .select()
        .from(pageRevisions)
        .where(eq(pageRevisions.pageId, pageId(about.wpId)))
        .all(),
    ).toHaveLength(0)
    expect(
      await db
        .select()
        .from(pageRevisions)
        .where(eq(pageRevisions.pageId, pageId(faq.wpId)))
        .all(),
    ).toHaveLength(1)
    expect((await db.select().from(categories).where(eq(categories.id, CAT.juniors)).get())?.intro.html).toBe('<p>Michael’s intro</p>')
    expect(await db.select().from(leagues).where(eq(leagues.code, 'TNL')).get()).toMatchObject({ startTime: '19:30', endTime: null })
    expect((await db.select().from(leagues).where(eq(leagues.code, 'TVSL')).get())?.description.html).toBe('')
    expect(await db.select().from(leagues).where(eq(leagues.code, 'ADP')).all()).toMatchObject([{ id: 'l-adp', name: 'ADP by hand' }])
    expect((await db.select().from(pages).where(eq(pages.path, '/enrol')).get())?.title).toBe('Join us')
    expect((await lookupPath(db, ARCHIVE[1]!.path)).redirect?.toPath).toBe('/somewhere')
    // Everything else still went in.
    expect((await db.select().from(leagues).where(eq(leagues.code, 'JDP')).get())?.status).toBe('draft')
  })
})
