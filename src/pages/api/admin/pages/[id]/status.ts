import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { setPageStatus, type PageStatusChange } from '../../../../../server/content/pages'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/** Publish, unpublish or archive: { status: 'published' | 'draft' | 'archived' }. Audited; purges the page. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = requireRole(locals.user, 'editor', request)
    const { status } = await readJson<{ status: PageStatusChange }>(request)
    const { result, purge: targets } = await setPageStatus(getServices().db, actor, params.id!, status as PageStatusChange)
    return json({ page: result, cache: await purge(cache, targets) })
  })
