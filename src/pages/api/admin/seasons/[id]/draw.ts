import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { saveDraw } from '../../../../../server/competition/seasons'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/**
 * Saves the draw: { baseUpdatedAt, weeks, generatedFrom?, edited?, settings? }. Draft seasons: replaced whole.
 * Published: court changes only. Admins. Audited; purges a public season's pages.
 */
export const PUT: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { result, purge: targets } = await saveDraw(getServices().db, actor, params.id!, await readJson(request))
    return json({ ...result, cache: await purge(cache, targets) })
  })
