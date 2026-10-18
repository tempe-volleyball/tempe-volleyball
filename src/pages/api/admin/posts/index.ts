import type { APIRoute } from 'astro'
import { createPost, listPosts } from '../../../../server/content/posts'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Every news post, unpublished first, then newest (?q= searches title and slug). */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    return json({ posts: await listPosts(getServices().db, { q: url.searchParams.get('q') ?? undefined }) })
  })

/** Creates a draft post: { title, slug, excerpt?, category?, coverMediaId?, seoTitle?, seoDescription?, noindex?, blocks? }. */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    return json({ post: await createPost(getServices().db, actor, await readJson(request)) }, 201)
  })
