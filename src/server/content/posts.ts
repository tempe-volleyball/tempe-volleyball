import { and, desc, eq, ne, or, sql } from 'drizzle-orm'
import { tags } from '../cache'
import { runBatch, type AppDb } from '../db'
import { posts, type ContentBody, type Post } from '../db/schema'
import { checkSlug, planMove } from '../../lib/content/paths'
import { blocksText, checkBlocks, renderBlocks, type JsonNode } from '../../lib/content/render'
import { postRoute } from '../../lib/wp-import/routes'
import {
  assertMedia,
  audit,
  clearRedirectFrom,
  conflict,
  invalid,
  isUniqueFailure,
  likeEscaped,
  likePattern,
  moveRedirectStatements,
  notFound,
  optionalText,
  requiredText,
  type Changed,
  type Editor,
} from './common'

// News posts at /news/<slug>: list, create, edit, publish/unpublish, delete. Same editor and sanitiser as pages,
// no revisions. A published post's slug change leaves a 301 behind.

export const MAX_TITLE = 200
export const MAX_EXCERPT = 300
export const MAX_CATEGORY = 60
export const MAX_SEO_TITLE = 120
export const MAX_SEO_DESCRIPTION = 300

export type PostInput = {
  title?: unknown
  slug?: unknown
  excerpt?: unknown
  category?: unknown
  coverMediaId?: unknown
  /** The <title> text and meta description when they should differ from the title and excerpt ('' or null = those). */
  seoTitle?: unknown
  seoDescription?: unknown
  /** Keep the post out of search results and the sitemap. */
  noindex?: unknown
  blocks?: unknown
  /** UTC ISO; lets an editor back-date a post. Only used once the post is published. */
  publishedAt?: unknown
  baseUpdatedAt?: unknown
}

export type PostSummary = Pick<Post, 'id' | 'slug' | 'title' | 'status' | 'category' | 'updatedAt' | 'publishedAt'>

export async function listPosts(db: AppDb, opts: { q?: string } = {}): Promise<PostSummary[]> {
  const q = opts.q?.trim()
  const where = q ? or(likeEscaped(posts.title, likePattern(q)), likeEscaped(posts.slug, likePattern(q))) : undefined
  return db
    .select({
      id: posts.id,
      slug: posts.slug,
      title: posts.title,
      status: posts.status,
      category: posts.category,
      updatedAt: posts.updatedAt,
      publishedAt: posts.publishedAt,
    })
    .from(posts)
    .where(where)
    .orderBy(sql`${posts.publishedAt} is null desc`, desc(posts.publishedAt), desc(posts.updatedAt))
    .limit(500)
    .all()
}

export async function getPost(db: AppDb, id: string) {
  const post = await db.select().from(posts).where(eq(posts.id, id)).get()
  if (!post) throw notFound('post')
  return post
}

const body = (blocks: unknown): ContentBody => {
  const checked = checkBlocks(blocks)
  if (!checked.ok) throw invalid(checked.message)
  return { blocks: checked.blocks, html: renderBlocks(checked.blocks) }
}

const slug = (v: unknown) => {
  if (typeof v !== 'string') throw invalid('Enter a slug, like season-starts.')
  const checked = checkSlug(v)
  if (!checked.ok) throw invalid(checked.message)
  return checked.slug
}

const isoOrNull = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw invalid('The publish date is not a valid date.')
  return new Date(v).toISOString()
}

async function assertSlugFree(db: AppDb, s: string, exceptId?: string) {
  const taken = await db
    .select({ title: posts.title })
    .from(posts)
    .where(exceptId ? and(eq(posts.slug, s), ne(posts.id, exceptId)) : eq(posts.slug, s))
    .get()
  if (taken) throw conflict(`The slug ${s} is already used by “${taken.title}”.`)
}

const slugTaken = (s: string) => conflict(`The slug ${s} is already used by another post.`)

const postPurge = (slugs: string[]) => ({ tags: [tags.news, tags.page('/'), ...slugs.map(tags.post)] })

/** The excerpt to store: what the editor typed, else the start of the body. */
const excerptFor = (typed: string | null, b: ContentBody) => typed ?? (blocksText(b.blocks as JsonNode[], 200) || null)

export async function createPost(db: AppDb, actor: Editor, input: PostInput, now = new Date()): Promise<Post> {
  const title = requiredText(input.title, 'Title', MAX_TITLE)
  const b = body(input.blocks ?? [])
  const values = {
    id: crypto.randomUUID(),
    title,
    slug: slug(input.slug),
    excerpt: optionalText(input.excerpt, 'Excerpt', MAX_EXCERPT),
    category: optionalText(input.category, 'Category', MAX_CATEGORY),
    coverMediaId: typeof input.coverMediaId === 'string' && input.coverMediaId ? input.coverMediaId : null,
    seoTitle: optionalText(input.seoTitle, 'Search title', MAX_SEO_TITLE),
    seoDescription: optionalText(input.seoDescription, 'Search description', MAX_SEO_DESCRIPTION),
    noindex: input.noindex === true,
    body: b,
    status: 'draft' as const,
    updatedBy: actor.id,
  }
  await Promise.all([assertSlugFree(db, values.slug), assertMedia(db, values.coverMediaId, 'Cover image')])
  const at = now.toISOString()
  try {
    await db.insert(posts).values({ ...values, createdAt: at, updatedAt: at })
  } catch (e) {
    if (isUniqueFailure(e, 'posts.slug')) throw slugTaken(values.slug)
    throw e
  }
  return (await db.select().from(posts).where(eq(posts.id, values.id)).get())!
}

export async function updatePost(db: AppDb, actor: Editor, id: string, input: PostInput, now = new Date()): Promise<Changed<Post>> {
  const post = await db.select().from(posts).where(eq(posts.id, id)).get()
  if (!post) throw notFound('post')
  if (typeof input.baseUpdatedAt === 'string' && input.baseUpdatedAt !== post.updatedAt)
    throw conflict('Someone else saved this post while you were editing. Reload it to see their changes (copy yours first).')
  const b = input.blocks === undefined ? post.body : body(input.blocks)
  const next = {
    title: input.title === undefined ? post.title : requiredText(input.title, 'Title', MAX_TITLE),
    slug: input.slug === undefined || input.slug === post.slug ? post.slug : slug(input.slug),
    excerpt: input.excerpt === undefined ? post.excerpt : optionalText(input.excerpt, 'Excerpt', MAX_EXCERPT),
    category: input.category === undefined ? post.category : optionalText(input.category, 'Category', MAX_CATEGORY),
    coverMediaId:
      input.coverMediaId === undefined
        ? post.coverMediaId
        : typeof input.coverMediaId === 'string' && input.coverMediaId
          ? input.coverMediaId
          : null,
    seoTitle: input.seoTitle === undefined ? post.seoTitle : optionalText(input.seoTitle, 'Search title', MAX_SEO_TITLE),
    seoDescription:
      input.seoDescription === undefined
        ? post.seoDescription
        : optionalText(input.seoDescription, 'Search description', MAX_SEO_DESCRIPTION),
    noindex: input.noindex === undefined ? post.noindex : input.noindex === true,
    body: b,
    publishedAt:
      input.publishedAt === undefined || !post.publishedAt ? post.publishedAt : (isoOrNull(input.publishedAt) ?? post.publishedAt),
  }
  const moved = next.slug !== post.slug
  await Promise.all([
    moved ? assertSlugFree(db, next.slug, id) : null,
    next.coverMediaId !== post.coverMediaId ? assertMedia(db, next.coverMediaId, 'Cover image') : null,
  ])
  const at = now.toISOString()
  const move = moved && post.publishedAt ? planMove(postRoute(post.slug), postRoute(next.slug)) : null
  try {
    await runBatch(db, [
      db
        .update(posts)
        .set({ ...next, updatedAt: at, updatedBy: actor.id })
        .where(eq(posts.id, id)),
      ...(move ? moveRedirectStatements(db, move, actor, at) : []),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'posts.slug')) throw slugTaken(next.slug)
    throw e
  }
  const saved = (await db.select().from(posts).where(eq(posts.id, id)).get())!
  return { result: saved, purge: post.status === 'published' ? postPurge(moved ? [post.slug, next.slug] : [next.slug]) : {} }
}

export async function setPostStatus(
  db: AppDb,
  actor: Editor,
  id: string,
  status: 'published' | 'draft' | 'archived',
  now = new Date(),
): Promise<Changed<Post>> {
  if (!['published', 'draft', 'archived'].includes(status)) throw invalid('Unknown status.')
  const post = await db.select().from(posts).where(eq(posts.id, id)).get()
  if (!post) throw notFound('post')
  if (post.status === status) return { result: post, purge: {} }
  const at = now.toISOString()
  const publishing = status === 'published'
  const excerpt = publishing ? excerptFor(post.excerpt, post.body) : post.excerpt
  await runBatch(db, [
    db
      .update(posts)
      .set({ status, excerpt, publishedAt: publishing ? (post.publishedAt ?? at) : post.publishedAt, updatedAt: at, updatedBy: actor.id })
      .where(eq(posts.id, id)),
    audit(
      db,
      actor,
      publishing ? 'post.publish' : 'post.unpublish',
      { type: 'post', id },
      { status: post.status, slug: post.slug, title: post.title },
      { status, slug: post.slug, title: post.title },
      at,
    ),
    ...(publishing ? [clearRedirectFrom(db, postRoute(post.slug))] : []),
  ])
  const saved = (await db.select().from(posts).where(eq(posts.id, id)).get())!
  return { result: saved, purge: postPurge([post.slug]) }
}

export async function deletePost(db: AppDb, actor: Editor, id: string, now = new Date()): Promise<Changed<{ id: string }>> {
  const post = await db.select().from(posts).where(eq(posts.id, id)).get()
  if (!post) throw notFound('post')
  await runBatch(db, [
    db.delete(posts).where(eq(posts.id, id)),
    audit(
      db,
      actor,
      'post.delete',
      { type: 'post', id },
      { slug: post.slug, title: post.title, status: post.status },
      null,
      now.toISOString(),
    ),
  ])
  return { result: { id }, purge: post.status === 'published' ? postPurge([post.slug]) : {} }
}
