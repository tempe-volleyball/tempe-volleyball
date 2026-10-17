import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { setSeasonStatus } from '../../../../../server/competition/seasons'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/** Publish, unpublish or archive: { baseUpdatedAt, status: 'published' | 'draft' | 'archived' }. Admins. Audited; purges. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { result, purge: targets } = await setSeasonStatus(getServices().db, actor, params.id!, await readJson(request))
    return json({ ...result, cache: await purge(cache, targets) })
  })
