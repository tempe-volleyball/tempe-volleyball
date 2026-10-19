import { and, eq, ne, sql, type SQL } from 'drizzle-orm'
import { describeHtml, prettyTitle } from '../lib/content'
import { categoryPath, programmePath } from '../lib/programmes'
import { MAX_RESULTS, rankHits, searchTerms, type SearchHit } from '../lib/seo/search'
import { teamPath } from '../lib/teams'
import { postRoute } from '../lib/wp-import/routes'
import { likeEscaped, likePattern } from './content/common'
import { runBatch, type AppDb } from './db'
import { categories, pages, posts, programmes, teams, type ProgrammeKind } from './db/schema'

// Site search (/search?q=): published pages, programmes, categories and news posts whose title or text contains
// every word. Four queries in one batch; each reads only the first SNIPPET characters of a body for the snippet,
// so a big imported page costs the Worker almost nothing. The result page is edge-cached per query.

const SNIPPET = 2000
const PER_KIND = MAX_RESULTS

/** Every term somewhere in `text` (LIKE is case-insensitive for ASCII in SQLite). */
const allTerms = (text: SQL, terms: string[]) => and(...terms.map((t) => likeEscaped(text, likePattern(t))))

export async function searchSite(db: AppDb, q: string): Promise<{ terms: string[]; hits: SearchHit[] }> {
  const terms = searchTerms(q)
  if (terms.length === 0) return { terms, hits: [] }
  const pageText = sql`${pages.title} || ' ' || coalesce(${pages.metaDescription}, '') || ' ' || coalesce(json_extract(${pages.body}, '$.html'), '')`
  const programmeText = sql`${programmes.name} || ' ' || ${programmes.code} || ' ' || coalesce(${programmes.summaryLine}, '') || ' ' || coalesce(json_extract(${programmes.description}, '$.html'), '')`
  const categoryText = sql`${categories.name} || ' ' || coalesce(json_extract(${categories.intro}, '$.html'), '')`
  const postText = sql`${posts.title} || ' ' || coalesce(${posts.excerpt}, '') || ' ' || coalesce(json_extract(${posts.body}, '$.html'), '')`
  const res = await runBatch(db, [
    db
      .select({
        path: pages.path,
        title: pages.title,
        description: pages.metaDescription,
        html: sql<string>`substr(coalesce(json_extract(${pages.body}, '$.html'), ''), 1, ${SNIPPET})`,
      })
      .from(pages)
      .where(and(eq(pages.status, 'published'), eq(pages.noindex, false), allTerms(pageText, terms)))
      .limit(PER_KIND),
    db
      .select({
        kind: programmes.kind,
        slug: programmes.slug,
        name: programmes.name,
        summary: programmes.summaryLine,
        html: sql<string>`substr(coalesce(json_extract(${programmes.description}, '$.html'), ''), 1, ${SNIPPET})`,
      })
      .from(programmes)
      .where(and(ne(programmes.status, 'draft'), allTerms(programmeText, terms)))
      .limit(PER_KIND),
    db
      .select({
        slug: categories.slug,
        name: categories.name,
        description: categories.seoDescription,
        html: sql<string>`substr(coalesce(json_extract(${categories.intro}, '$.html'), ''), 1, ${SNIPPET})`,
      })
      .from(categories)
      .where(and(ne(categories.status, 'draft'), allTerms(categoryText, terms)))
      .limit(PER_KIND),
    db
      .select({
        slug: posts.slug,
        title: posts.title,
        excerpt: posts.excerpt,
        publishedAt: posts.publishedAt,
        html: sql<string>`substr(coalesce(json_extract(${posts.body}, '$.html'), ''), 1, ${SNIPPET})`,
      })
      .from(posts)
      .where(and(eq(posts.status, 'published'), eq(posts.noindex, false), allTerms(postText, terms)))
      .limit(PER_KIND),
    // Teams with a page (they played in a published or archived season).
    db
      .select({ slug: teams.slug, name: teams.name })
      .from(teams)
      .where(
        and(
          allTerms(sql`${teams.name}`, terms),
          sql`exists (select 1 from season_teams st join seasons s on s.id = st.season_id where st.team_id = ${teams.id} and s.status in ('published', 'archived'))`,
        ),
      )
      .limit(PER_KIND),
  ])
  type Row<T> = T[]
  const [pageRows, programmeRows, categoryRows, postRows, teamRows] = res as unknown as [
    Row<{ path: string; title: string; description: string | null; html: string }>,
    Row<{ kind: ProgrammeKind; slug: string; name: string; summary: string | null; html: string }>,
    Row<{ slug: string; name: string; description: string | null; html: string }>,
    Row<{ slug: string; title: string; excerpt: string | null; publishedAt: string | null; html: string }>,
    Row<{ slug: string; name: string }>,
  ]
  const text = (typed: string | null | undefined, html: string) => typed?.trim() || describeHtml(html) || ''
  const hits: SearchHit[] = [
    ...programmeRows.map((p) => ({
      kind: 'programme' as const,
      path: programmePath(p.kind, p.slug),
      title: p.name,
      text: text(p.summary, p.html),
    })),
    ...categoryRows.map((c) => ({
      kind: 'category' as const,
      path: categoryPath(c.slug),
      title: c.name,
      text: text(c.description, c.html),
    })),
    ...pageRows.map((p) => ({ kind: 'page' as const, path: p.path, title: prettyTitle(p.title), text: text(p.description, p.html) })),
    ...postRows.map((p) => ({
      kind: 'post' as const,
      path: postRoute(p.slug),
      title: prettyTitle(p.title),
      text: text(p.excerpt, p.html),
      date: p.publishedAt,
    })),
    ...teamRows.map((t) => ({ kind: 'team' as const, path: teamPath(t.slug), title: t.name, text: 'Fixtures, results and seasons' })),
  ]
  return { terms, hits: rankHits(hits, terms) }
}
