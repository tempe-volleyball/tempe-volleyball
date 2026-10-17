import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { deletePost, getPost, updatePost } from '../../../../../server/content/posts'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    return json({ post: await getPost(getServices().db, params.id!) })
  })

/** Saves edits. A published post's slug change leaves a 301 behind. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    const { result, purge: targets } = await updatePost(getServices().db, actor, params.id!, await readJson(request))
    return json({ post: result, cache: await purge(cache, targets) })
  })

/** Deletes a post. Audited. */
export const DELETE: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    const { purge: targets } = await deletePost(getServices().db, actor, params.id!)
    return json({ ok: true, cache: await purge(cache, targets) })
  })
