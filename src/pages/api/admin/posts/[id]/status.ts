import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { setPostStatus } from '../../../../../server/content/posts'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/** Publish, unpublish or archive: { status }. Audited; purges the news pages. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    const { status } = await readJson<{ status: 'published' | 'draft' | 'archived' }>(request)
    const { result, purge: targets } = await setPostStatus(getServices().db, actor, params.id!, status!)
    return json({ post: result, cache: await purge(cache, targets) })
  })
