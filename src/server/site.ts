import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { publicMenu, type MenuItem, type MenuRow } from '../lib/content/menu'
import { runBatch, type AppDb } from './db'
import {
  categories,
  menuItems,
  programmes,
  pages,
  posts,
  redirects,
  siteSettings,
  venues,
  type Category,
  type League,
  type Page,
  type Post,
  type Venue,
} from './db/schema'
import { readSettings, type SiteSettings } from '../lib/content/settings'
import { ladderRows, toCompetition, type LadderRow, type SeasonCompetition, type SeasonData } from './competition/adapter'
import {
  assembleSeasons,
  baseQueries,
  currentSeason,
  seasonListQuery,
  seasonQueries,
  type SeasonRows,
  type SeasonSummary,
} from './competition/load'
import { menuCategoryColumns, menuRowColumns } from './content/menu'

// What every public page shows around its content (menu, ladder widgets, venues) plus each league's current
// season, loaded in one db.batch() whatever the page.

export type LeagueSeason = {
  league: League
  summary: SeasonSummary
  data: SeasonData
  competition: SeasonCompetition
  ladder: LadderRow[]
}

/** What the menu and the page blocks need of a programme (every kind; drafts are never loaded). */
export type SiteProgramme = Pick<
  League,
  | 'id'
  | 'kind'
  | 'code'
  | 'name'
  | 'slug'
  | 'weekday'
  | 'defaultVenueId'
  | 'sort'
  | 'status'
  | 'categoryId'
  | 'startTime'
  | 'endTime'
  | 'scheduleLabel'
  | 'summaryLine'
  | 'moreInfoUrl'
  | 'menuVisible'
  | 'enrolmentOpen'
  | 'enrolmentOpensAt'
  | 'enrolmentClosesAt'
  | 'nextStartsOn'
  | 'nextStartsText'
  | 'priceCents'
>

export type SiteCategory = Pick<Category, 'id' | 'name' | 'slug' | 'sort' | 'status'>

export type Site = {
  menu: MenuItem[]
  /** Leagues (kind 'league'), drafts included: the competition data. */
  leagues: League[]
  /** Every programme that isn't a draft, any kind, in programme order (menus, blocks). */
  programmes: SiteProgramme[]
  categories: SiteCategory[]
  seasons: SeasonSummary[]
  venues: Venue[]
  /** Each active league's current season, in league order. */
  current: LeagueSeason[]
  /** Contact details, social links, the announcement banner … (site_settings, edited in the admin). */
  settings: SiteSettings
}

const menuQuery = (db: AppDb) =>
  db
    .select({ ...menuRowColumns, pagePath: sql<string | null>`case when ${pages.status} = 'published' then ${pages.path} end` })
    .from(menuItems)
    .leftJoin(pages, eq(pages.id, menuItems.pageId))

const programmeQuery = (db: AppDb) =>
  db
    .select({
      id: programmes.id,
      kind: programmes.kind,
      code: programmes.code,
      name: programmes.name,
      slug: programmes.slug,
      weekday: programmes.weekday,
      defaultVenueId: programmes.defaultVenueId,
      sort: programmes.sort,
      status: programmes.status,
      categoryId: programmes.categoryId,
      startTime: programmes.startTime,
      endTime: programmes.endTime,
      scheduleLabel: programmes.scheduleLabel,
      summaryLine: programmes.summaryLine,
      moreInfoUrl: programmes.moreInfoUrl,
      menuVisible: programmes.menuVisible,
      enrolmentOpen: programmes.enrolmentOpen,
      enrolmentOpensAt: programmes.enrolmentOpensAt,
      enrolmentClosesAt: programmes.enrolmentClosesAt,
      nextStartsOn: programmes.nextStartsOn,
      nextStartsText: programmes.nextStartsText,
      priceCents: programmes.priceCents,
    })
    .from(programmes)
    .where(ne(programmes.status, 'draft'))
    .orderBy(asc(programmes.sort), asc(programmes.name))

const categoryQuery = (db: AppDb) =>
  db
    .select({ ...menuCategoryColumns, sort: categories.sort })
    .from(categories)
    .where(ne(categories.status, 'draft'))
    .orderBy(asc(categories.sort), asc(categories.name))

export function seasonView(data: SeasonData, summary: SeasonSummary): LeagueSeason {
  const competition = toCompetition(data)
  return { league: data.league, summary, data, competition, ladder: ladderRows(competition, data.adjustments) }
}

export async function loadSite(db: AppDb): Promise<Site> {
  const [leagueQ, courtQ] = baseQueries(db)
  const sq = seasonQueries(db, { status: 'published' })
  const res = await runBatch(db, [
    menuQuery(db),
    leagueQ,
    courtQ,
    seasonListQuery(db),
    db.select().from(venues).orderBy(asc(venues.sort)),
    db.select({ key: siteSettings.key, value: siteSettings.value }).from(siteSettings),
    programmeQuery(db),
    categoryQuery(db),
    ...sq,
  ])
  const [menuRows, leagueRows, courtRows, seasonList, venueRows, settingRows, programmeRows, categoryRows, ...seasonRows] =
    res as unknown as [
      (MenuRow & { pagePath: string | null })[],
      League[],
      Awaited<typeof courtQ>,
      SeasonSummary[],
      Venue[],
      { key: string; value: unknown }[],
      SiteProgramme[],
      SiteCategory[],
      ...SeasonRows,
    ]
  const byId = assembleSeasons(seasonRows as unknown as SeasonRows, leagueRows, courtRows)
  const current: LeagueSeason[] = []
  for (const league of leagueRows) {
    if (!league.active) continue
    const summary = currentSeason(seasonList, league.id)
    const data = summary && byId.get(summary.id)
    if (summary && data) current.push(seasonView(data, summary))
  }
  const pagePaths = new Map(menuRows.map((r) => [r.pageId, r.pagePath]))
  return {
    menu: publicMenu(menuRows, {
      pagePath: (id) => pagePaths.get(id) ?? null,
      programmes: programmeRows,
      categories: categoryRows,
    }),
    leagues: leagueRows,
    programmes: programmeRows,
    categories: categoryRows,
    seasons: seasonList,
    venues: venueRows,
    current,
    settings: readSettings(settingRows),
  }
}

/** One (usually archived) season's full data. */
export async function loadSeason(db: AppDb, seasonId: string, site: Pick<Site, 'leagues'>): Promise<SeasonData | undefined> {
  const [, courtQ] = baseQueries(db)
  const res = await runBatch(db, [courtQ, ...seasonQueries(db, { ids: [seasonId] })])
  const [courtRows, ...rows] = res as unknown as [Awaited<typeof courtQ>, ...SeasonRows]
  return assembleSeasons(rows as unknown as SeasonRows, site.leagues, courtRows).get(seasonId)
}

export type PathLookup = {
  page: Page | undefined
  redirect: { toPath: string; status: number; id: string } | undefined
  /** Published page titles by path, for describing "here" links in the body. */
  titles: Map<string, string>
}

/** A published page at this path, the redirect for it (used only when there's no page) and page titles, in one round trip. */
export async function lookupPath(db: AppDb, path: string): Promise<PathLookup> {
  const [pageRows, redirectRows, titleRows] = (await runBatch(db, [
    db
      .select()
      .from(pages)
      .where(and(eq(pages.path, path), eq(pages.status, 'published')))
      .limit(1),
    db
      .select({ id: redirects.id, toPath: redirects.toPath, status: redirects.status })
      .from(redirects)
      .where(eq(redirects.fromPath, path))
      .limit(1),
    titlesQuery(db),
  ])) as unknown as [Page[], { id: string; toPath: string; status: number }[], { path: string; title: string }[]]
  return { page: pageRows[0], redirect: redirectRows[0], titles: new Map(titleRows.map((p) => [p.path, p.title])) }
}

/**
 * For a trailing-slash request: the redirect stored for its slashless `path`, unless a published page lives there
 * (pages win, as in lookupPath). One round trip; lets "/ladders/" go straight to its target in one 301.
 */
export async function slashRedirect(db: AppDb, path: string): Promise<{ toPath: string; status: number; id: string } | undefined> {
  const [pageRows, redirectRows] = (await runBatch(db, [
    db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.path, path), eq(pages.status, 'published')))
      .limit(1),
    db
      .select({ id: redirects.id, toPath: redirects.toPath, status: redirects.status })
      .from(redirects)
      .where(eq(redirects.fromPath, path))
      .limit(1),
  ])) as unknown as [{ id: string }[], { id: string; toPath: string; status: number }[]]
  return pageRows.length ? undefined : redirectRows[0]
}

export const findRedirect = async (db: AppDb, path: string) =>
  (
    await db
      .select({ id: redirects.id, toPath: redirects.toPath, status: redirects.status })
      .from(redirects)
      .where(eq(redirects.fromPath, path))
      .limit(1)
  )[0]

/** Counts a redirect hit (run it in waitUntil; it's a write, so skip it for bots if this ever gets busy). */
export const countRedirectHit = (db: AppDb, id: string, at = new Date()) =>
  db
    .update(redirects)
    .set({ hits: sql`${redirects.hits} + 1`, lastHitAt: at.toISOString() })
    .where(eq(redirects.id, id))

const titlesQuery = (db: AppDb) => db.select({ path: pages.path, title: pages.title }).from(pages).where(eq(pages.status, 'published'))

/** Published page titles by path, for describing "here" links. */
export const pageTitles = async (db: AppDb) => new Map((await titlesQuery(db)).map((p) => [p.path, p.title]))

export type PostSummary = Pick<Post, 'id' | 'slug' | 'title' | 'excerpt' | 'publishedAt' | 'category'>

export const listPosts = (db: AppDb) =>
  db
    .select({
      id: posts.id,
      slug: posts.slug,
      title: posts.title,
      excerpt: posts.excerpt,
      publishedAt: posts.publishedAt,
      category: posts.category,
    })
    .from(posts)
    .where(eq(posts.status, 'published'))
    .orderBy(desc(posts.publishedAt))

export const findPost = async (db: AppDb, slug: string): Promise<Post | undefined> =>
  (
    await db
      .select()
      .from(posts)
      .where(and(eq(posts.slug, slug), eq(posts.status, 'published')))
      .limit(1)
  )[0]
