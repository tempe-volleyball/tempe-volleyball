import { eq, ne, sql } from 'drizzle-orm'
import type { SitemapRows } from '../lib/seo/sitemap'
import { runBatch, type AppDb } from './db'
import { categories, pages, posts, programmes, seasons, teams } from './db/schema'

// The rows behind /sitemap.xml (src/lib/seo/sitemap.ts decides what's listed): six queries in one batch, whatever
// the size of the site. Columns only, never bodies.

export async function loadSitemapRows(db: AppDb): Promise<SitemapRows> {
  const res = await runBatch(db, [
    db
      .select({ path: pages.path, template: pages.template, updatedAt: pages.updatedAt, noindex: pages.noindex })
      .from(pages)
      .where(eq(pages.status, 'published')),
    db
      .select({ slug: categories.slug, status: categories.status, updatedAt: categories.updatedAt })
      .from(categories)
      .where(ne(categories.status, 'draft')),
    db
      .select({
        id: programmes.id,
        kind: programmes.kind,
        slug: programmes.slug,
        status: programmes.status,
        updatedAt: programmes.updatedAt,
        signupMode: programmes.signupMode,
        interestOpen: programmes.interestOpen,
        // Correlated subqueries, one indexed lookup each per programme (a few dozen rows at most). Written out with
        // aliases: drizzle leaves single-table column names unqualified, which a subquery would resolve to itself.
        hasHistory: sql<number>`case ${programmes.kind}
          when 'league' then exists(select 1 from seasons s where s.league_id = leagues.id and s.status <> 'draft')
          when 'training' then exists(select 1 from programme_sessions ps where ps.programme_id = leagues.id)
          when 'development' then exists(select 1 from development_terms dt where dt.programme_id = leagues.id)
          else exists(select 1 from events e where e.programme_id = leagues.id) end`,
      })
      .from(programmes)
      .where(ne(programmes.status, 'draft')),
    db
      .select({
        id: seasons.id,
        leagueId: seasons.leagueId,
        slug: seasons.slug,
        status: seasons.status,
        year: seasons.year,
        quarter: seasons.quarter,
        updatedAt: seasons.updatedAt,
        resultsPublishedAt: sql<string | null>`(select max(md.results_published_at) from match_days md where md.season_id = seasons.id)`,
      })
      .from(seasons)
      .where(ne(seasons.status, 'draft')),
    db
      .select({ slug: posts.slug, updatedAt: posts.updatedAt, publishedAt: posts.publishedAt, noindex: posts.noindex })
      .from(posts)
      .where(eq(posts.status, 'published')),
    db
      .select({ slug: teams.slug, updatedAt: teams.updatedAt })
      .from(teams)
      .where(
        sql`exists (select 1 from season_teams st join seasons s on s.id = st.season_id where st.team_id = ${teams.id} and s.status in ('published', 'archived'))`,
      ),
  ])
  const [pageRows, categoryRows, programmeRows, seasonRows, postRows, teamRows] = res as unknown as [
    SitemapRows['pages'],
    SitemapRows['categories'],
    (Omit<SitemapRows['programmes'][number], 'hasHistory'> & { hasHistory: number | boolean })[],
    SitemapRows['seasons'],
    SitemapRows['posts'],
    NonNullable<SitemapRows['teams']>,
  ]
  return {
    pages: pageRows.map((p) => ({ ...p, noindex: !!p.noindex })),
    categories: categoryRows,
    programmes: programmeRows.map((p) => ({ ...p, hasHistory: !!p.hasHistory })),
    seasons: seasonRows,
    posts: postRows.map((p) => ({ ...p, noindex: !!p.noindex })),
    teams: teamRows,
  }
}
