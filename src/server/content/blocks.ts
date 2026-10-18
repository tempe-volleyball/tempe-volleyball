import { asc, eq } from 'drizzle-orm'
import {
  dataBlocksIn,
  programmeLines,
  renderFixtures,
  renderLadder,
  renderProgrammeList,
  renderVenues,
  parseDataBlock,
  type LeagueBlockData,
  type ParsedDataBlock,
  type ProgrammeLine,
  type ProgrammeListData,
  type VenuesBlockData,
} from '../../lib/content/data-blocks'
import { hasDataBlocks, renderBlocks, type JsonNode } from '../../lib/content/render'
import { isTeam, ladderTitle, ladderUpdatedLabel, ladderWeekLabel, makeResolver } from '../../lib/fixtures'
import { sydneyDate } from '../../lib/time'
import { tags } from '../cache'
import { fixtureRows } from '../competition/adapter'
import { assembleSeasons, baseQueries, currentSeason, seasonQueries, type SeasonRows } from '../competition/load'
import { runBatch, type AppDb } from '../db'
import { categories, pageDataRefs, programmes, type ContentBody } from '../db/schema'
import { nextInstanceMap, nextInstanceQueries } from '../programmes/programmes'
import { seasonView, type LeagueSeason, type Site } from '../site'
import { invalid } from './common'

// Data blocks at view time (docs/admin.md §3.4): a page whose body has Programme list, Ladder or Fixtures blocks is
// rendered from its blocks on every (uncached) view, with the data they need loaded in at most one extra db.batch():
//  - Ladder / Fixtures read each league's current season, which loadSite() already loaded (published seasons); a
//    league between seasons (its latest is archived) gets that season loaded in the same extra batch.
//  - Programme lists read Site.programmes / categories / venues (also from loadSite) plus the next start dates
//    (4 grouped queries, nextInstanceQueries).
//  - Venues blocks read Site.venues and Site.programmes (no queries at all).
// The page is cache-tagged with what it shows (tags.programmes and tags.venues for programme lists and venues,
// tags.league for ladders and fixtures), and page_data_refs (rewritten on save) lets data changes purge it by path.

type Batchable = Parameters<typeof runBatch>[1][number]

export type BlockContext = {
  programmes: ProgrammeListData | null
  leagues: Map<string, LeagueBlockData>
  venues: VenuesBlockData
  /** YYYY-MM-DD, Sydney. */
  today: string
}

/** A league's current season in the shape the Ladder and Fixtures blocks read. */
export function leagueBlockData(view: LeagueSeason): LeagueBlockData {
  const { competition, data, summary, league } = view
  const week = ladderWeekLabel(competition.weeks)
  const resolve = makeResolver(competition.settings, competition.weeks)
  const teamOf = (r: Parameters<typeof resolve>[0]) => {
    const t = resolve(r) ?? r
    return isTeam(t) ? [t.team] : []
  }
  const rowTeams = new Map<string, string[]>()
  for (const w of competition.weeks) for (const g of w.games) rowTeams.set(g.id, [...teamOf(g.home), ...teamOf(g.away), ...teamOf(g.duty)])
  const fixtures = fixtureRows(competition, data.matches)
  for (const r of fixtures) {
    if (r.kind === 'moved') rowTeams.set(r.key, rowTeams.get(r.key.split(':moved:')[1] ?? '') ?? [])
    if (r.kind !== 'bye') continue
    const team = r.key.split(':bye:')[1]
    if (team) rowTeams.set(r.key, [team])
  }
  return {
    league: { id: league.id, name: league.name, code: league.code, slug: league.slug },
    seasonName: summary.name,
    heading: `${ladderTitle(competition.weeks)}${week ? ` – ${week}` : ''}`,
    updated: ladderUpdatedLabel(competition.weeks) ?? '',
    ladder: view.ladder,
    fixtures,
    rowTeams,
    dutyEnabled: data.season.dutyEnabled,
  }
}

const leagueIdsOf = (parsed: ParsedDataBlock[]) => [
  ...new Set(parsed.flatMap((b) => ((b.type === 'ladder' || b.type === 'fixtures') && b.attrs.leagueId ? [b.attrs.leagueId] : []))),
]

/**
 * Loads what a body's data blocks need beyond loadSite(): one batch at most (next start dates for programme lists,
 * plus the current season of any referenced league that loadSite didn't load), or none at all.
 */
export async function loadBlockContext(db: AppDb, site: Site, blocks: readonly JsonNode[], now = new Date()): Promise<BlockContext> {
  const parsed = dataBlocksIn(blocks)
  const today = sydneyDate(now)
  const wantsProgrammes = parsed.some((b) => b.type === 'programmeList')
  const current = new Map(site.current.map((v) => [v.league.id, v]))
  const known = new Set(site.leagues.map((l) => l.id))
  // Referenced leagues without a published season: their latest (archived) season, if any.
  const missing = leagueIdsOf(parsed)
    .filter((id) => !current.has(id) && known.has(id))
    .map((id) => currentSeason(site.seasons, id))
    .filter((s): s is NonNullable<typeof s> => !!s)

  const statements: Batchable[] = []
  const nextQs = wantsProgrammes ? nextInstanceQueries(db, today) : []
  statements.push(...nextQs)
  const [, courtQ] = baseQueries(db)
  const seasonQs = missing.length ? [courtQ, ...seasonQueries(db, { ids: missing.map((s) => s.id) })] : []
  statements.push(...seasonQs)
  const results = statements.length ? ((await runBatch(db, statements as [Batchable, ...Batchable[]])) as unknown[][]) : []

  if (missing.length) {
    const [courtRows, ...rows] = results.slice(nextQs.length) as unknown as [Awaited<typeof courtQ>, ...SeasonRows]
    const byId = assembleSeasons(rows as unknown as SeasonRows, site.leagues, courtRows)
    for (const s of missing) {
      const data = byId.get(s.id)
      if (data) current.set(s.leagueId, seasonView(data, s))
    }
  }
  const leagues = new Map<string, LeagueBlockData>()
  for (const id of leagueIdsOf(parsed)) {
    const v = current.get(id)
    if (v) leagues.set(id, leagueBlockData(v))
  }
  return {
    today,
    leagues,
    venues: { venues: site.venues, programmes: site.programmes },
    programmes: wantsProgrammes
      ? {
          programmes: site.programmes,
          categories: site.categories,
          venues: site.venues,
          nextInstance: nextInstanceMap(results.slice(0, nextQs.length) as { programmeId: string; date: string | null }[][]),
          nowIso: now.toISOString(),
        }
      : null,
  }
}

/** One data block's HTML ('' when it has nothing to show, e.g. a league with no season yet). */
export function renderDataBlock(node: JsonNode, ctx: BlockContext): string {
  const b = parseDataBlock(node)
  if (!b) return ''
  switch (b.type) {
    case 'programmeList':
      return ctx.programmes ? renderProgrammeList(b.attrs, ctx.programmes) : ''
    case 'ladder':
      return renderLadder(b.attrs, ctx.leagues.get(b.attrs.leagueId))
    case 'fixtures':
      return renderFixtures(b.attrs, ctx.leagues.get(b.attrs.leagueId), ctx.today)
    case 'venues':
      return renderVenues(b.attrs, ctx.venues)
  }
}

/** Lines for the editor (hidden ones included, with change flags). */
export const previewLines = (node: JsonNode, ctx: BlockContext): ProgrammeLine[] => {
  const b = parseDataBlock(node)
  return b?.type === 'programmeList' && ctx.programmes ? programmeLines(b.attrs, ctx.programmes, { includeHidden: true }) : []
}

/** Cache tags for what a body's blocks show. */
export function blockTags(blocks: readonly JsonNode[], site: Pick<Site, 'leagues'>): string[] {
  const parsed = dataBlocksIn(blocks)
  const slugs = new Map(site.leagues.map((l) => [l.id, l.slug]))
  const out = new Set<string>()
  for (const b of parsed) {
    if (b.type === 'programmeList' || b.type === 'venues') {
      out.add(tags.programmes)
      out.add(tags.venues)
    } else {
      const slug = slugs.get(b.attrs.leagueId)
      if (slug) out.add(tags.league(slug))
    }
  }
  return [...out]
}

export type RenderedBody = { html: string; tags: string[] }

/**
 * A page or post body for the public site: the stored HTML when it has no data blocks (no work at all), else the body
 * rendered again from its blocks with live data, plus the cache tags for that data.
 */
export async function renderBody(db: AppDb, site: Site, body: ContentBody, now = new Date()): Promise<RenderedBody> {
  const blocks = Array.isArray(body.blocks) ? (body.blocks as JsonNode[]) : []
  if (!hasDataBlocks(blocks)) return { html: body.html, tags: [] }
  const ctx = await loadBlockContext(db, site, blocks, now)
  return { html: renderBlocks(blocks, { dataBlock: (n) => renderDataBlock(n, ctx) }), tags: blockTags(blocks, site) }
}

/** The batch statements that rewrite a page's page_data_refs (delete, then insert), for the page-save batch. */
export function pageRefStatements(
  db: AppDb,
  pageId: string,
  refs: { kind: (typeof pageDataRefs.$inferInsert)['kind']; refId: string }[],
  at: string,
) {
  return [
    db.delete(pageDataRefs).where(eq(pageDataRefs.pageId, pageId)),
    // 4 parameters a row: 20 rows per statement stays under 100.
    ...Array.from({ length: Math.ceil(refs.length / 20) }, (_, i) =>
      db.insert(pageDataRefs).values(refs.slice(i * 20, i * 20 + 20).map((r) => ({ pageId, kind: r.kind, refId: r.refId, createdAt: at }))),
    ),
  ]
}

// ── Admin: the block editor ───────────────────────────────────────────────────

export type BlockChoices = {
  categories: { id: string; name: string; status: string }[]
  /** Every programme, drafts included (a block can be set up before launch; drafts never show). */
  programmes: { id: string; kind: string; code: string; name: string; status: string; categoryId: string | null }[]
  /** Leagues with their current season and its teams (for the Fixtures block's team filter). */
  leagues: { id: string; code: string; name: string; status: string; season: string | null; teams: { id: string; name: string }[] }[]
  /** Every venue, in venue order (for the Venues block). */
  venues: { id: string; name: string }[]
}

/** What the block editor's pickers offer: one batch on top of loadSite(). */
export async function blockChoices(db: AppDb, site: Site): Promise<BlockChoices> {
  const [cats, progs] = (await runBatch(db, [
    db.select({ id: categories.id, name: categories.name, status: categories.status }).from(categories).orderBy(asc(categories.sort)),
    db
      .select({
        id: programmes.id,
        kind: programmes.kind,
        code: programmes.code,
        name: programmes.name,
        status: programmes.status,
        categoryId: programmes.categoryId,
      })
      .from(programmes)
      .orderBy(asc(programmes.sort), asc(programmes.name)),
  ])) as unknown as [BlockChoices['categories'], BlockChoices['programmes']]
  const current = new Map(site.current.map((v) => [v.league.id, v]))
  return {
    categories: cats,
    programmes: progs,
    leagues: site.leagues.map((l) => {
      const v = current.get(l.id)
      return {
        id: l.id,
        code: l.code,
        name: l.name,
        status: l.status,
        season: v?.summary.name ?? currentSeason(site.seasons, l.id)?.name ?? null,
        teams: v ? v.data.teams.map((t) => ({ id: t.id, name: t.name })) : [],
      }
    }),
    venues: site.venues.map((v) => ({ id: v.id, name: v.name })),
  }
}

export type BlockPreview = {
  html: string
  /** Programme list only: every matching line, hidden ones included, with change flags. */
  lines: ProgrammeLine[]
  /** Why the block shows nothing on the site, if it doesn't. */
  note: string | null
}

/** Renders one block exactly as the public page would, for the editor. */
export async function previewBlock(db: AppDb, site: Site, block: unknown, now = new Date()): Promise<BlockPreview> {
  const node = block && typeof block === 'object' && !Array.isArray(block) ? (block as JsonNode) : null
  const parsed = node ? parseDataBlock(node) : null
  if (!node || !parsed) throw invalid('That isn’t a data block.')
  const ctx = await loadBlockContext(db, site, [node], now)
  const html = renderDataBlock(node, ctx)
  let note: string | null = null
  if (!html) {
    if (parsed.type === 'programmeList') note = 'No programmes match, so nothing shows (fill in “Text when empty” to show a message).'
    else if (parsed.type === 'venues') note = 'No venues to show: add them in Admin → Venues, or pick others in Settings.'
    else if (!parsed.attrs.leagueId) note = 'Choose a league.'
    else if (!site.leagues.some((l) => l.id === parsed.attrs.leagueId)) note = 'That league no longer exists.'
    else note = 'This league has no published season yet, so nothing shows until one is published.'
  }
  return { html, lines: previewLines(node, ctx), note }
}
