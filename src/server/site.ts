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
import { DEFAULT_SETTINGS, readSettings, type SiteSettings } from '../lib/content/settings'
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
import { LEAGUES_ROUTE } from '../lib/wp-import/routes'

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
  | 'signupMode'
  | 'interestOpen'
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
  /**
   * The privacy policy's path while a page is published there (Settings → Privacy policy, default /privacy), else
   * null: the footer and the forms link to it only when it's live, so they never point at a 404.
   */
  privacyHref: string | null
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
      signupMode: programmes.signupMode,
      interestOpen: programmes.interestOpen,
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

const siteStatements = (db: AppDb) => {
  const [leagueQ, courtQ] = baseQueries(db)
  return [
    menuQuery(db),
    leagueQ,
    courtQ,
    seasonListQuery(db),
    db.select().from(venues).orderBy(asc(venues.sort)),
    db.select({ key: siteSettings.key, value: siteSettings.value }).from(siteSettings),
    programmeQuery(db),
    categoryQuery(db),
    privacyQuery(db),
    ...seasonQueries(db, { status: 'published' }),
  ]
}

/** The privacy page's path if it's published (the path is read from the setting in the same statement). */
const privacyQuery = (db: AppDb) =>
  db
    .select({ path: pages.path })
    .from(pages)
    .where(
      and(
        eq(pages.status, 'published'),
        sql`${pages.path} = coalesce((select json_extract(s.value, '$.pagePath') from site_settings s where s.key = 'privacy'), ${DEFAULT_SETTINGS.privacy.pagePath})`,
      ),
    )
    .limit(1)

function assembleSite(res: unknown[]): Site {
  const [menuRows, leagueRows, courtRows, seasonList, venueRows, settingRows, programmeRows, categoryRows, privacyRows, ...seasonRows] =
    res as unknown as [
      (MenuRow & { pagePath: string | null })[],
      League[],
      Awaited<ReturnType<typeof baseQueries>[1]>,
      SeasonSummary[],
      Venue[],
      { key: string; value: unknown }[],
      SiteProgramme[],
      SiteCategory[],
      { path: string }[],
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
    privacyHref: privacyRows[0]?.path ?? null,
  }
}

/** Everything around a public page, straight from D1 (one batch). Admin routes use this; public routes use a memo. */
export async function loadSite(db: AppDb): Promise<Site> {
  return assembleSite(await runBatch(db, siteStatements(db)))
}

// ── The per-isolate memo (docs/admin.md §3.14) ─────────────────────────────────

/**
 * The site_settings row every admin write bumps (src/middleware.ts), so a memoised Site knows it's stale. Not a
 * setting: readSettings() and the Settings screen ignore keys they don't know.
 */
export const SITE_VERSION_KEY = 'site_version'

/** How long an isolate reuses a Site whose version still matches. Bounds staleness from writes that skip the bump. */
export const SITE_MEMO_MS = 60_000

const versionQuery = (db: AppDb) =>
  db.select({ value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, SITE_VERSION_KEY)).limit(1)

const versionOf = (rows: { value: unknown }[]) => {
  const v = rows[0]?.value
  return typeof v === 'string' ? v : ''
}

/** Upserts a new site version: run it after any write that could change what loadSite() returns. */
export const bumpSiteVersion = (db: AppDb, at = new Date()) =>
  db
    .insert(siteSettings)
    .values({ key: SITE_VERSION_KEY, value: crypto.randomUUID(), updatedAt: at.toISOString() })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value: sql`excluded.value`, updatedAt: at.toISOString() } })

export type SiteMemo = { load(db: AppDb): Promise<Site>; clear(): void }

/**
 * loadSite() memoised per isolate: while the copy is younger than `maxAgeMs`, a request costs one indexed one-row
 * query (the site version) instead of the whole batch; a changed version, or an older copy, reloads it (the version
 * rides in the same batch). Concurrent misses share one load. The Site is shared between requests, so callers must
 * treat it as read-only (they do: every route filters, maps and toSorted()s).
 */
export function createSiteMemo({ maxAgeMs = SITE_MEMO_MS, clock = Date.now }: { maxAgeMs?: number; clock?: () => number } = {}): SiteMemo {
  let entry: { version: string; at: number; site: Site } | null = null
  let inflight: Promise<Site> | null = null
  const reload = async (db: AppDb) => {
    const started = clock()
    const [version, ...rest] = await runBatch(db, [versionQuery(db), ...siteStatements(db)])
    const site = assembleSite(rest)
    entry = { version: versionOf(version as { value: unknown }[]), at: started, site }
    return site
  }
  return {
    async load(db) {
      const e = entry
      if (e && clock() - e.at < maxAgeMs && versionOf(await versionQuery(db)) === e.version) return e.site
      inflight ??= reload(db).finally(() => (inflight = null))
      return inflight
    },
    clear() {
      entry = null
    },
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

/**
 * A league's slug now, from an old one: the 301 the programmes admin left for `/leagues/<old>` (moveTreeStatements
 * keeps it pointing straight at the current URL, possibly with a #tab). Null when there's none or it leads elsewhere.
 * Lets the fixture list's ?league= follow a renamed league (their sub-paths aren't in the table).
 */
export async function renamedLeagueSlug(db: AppDb, oldSlug: string): Promise<string | null> {
  if (!/^[a-z0-9-]{1,100}$/.test(oldSlug)) return null
  const r = await findRedirect(db, `${LEAGUES_ROUTE}/${oldSlug}`)
  const m = r && new RegExp(`^${LEAGUES_ROUTE}/([a-z0-9-]+)(?:#.*)?$`).exec(r.toPath)
  return m && m[1] !== oldSlug ? m[1]! : null
}

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
