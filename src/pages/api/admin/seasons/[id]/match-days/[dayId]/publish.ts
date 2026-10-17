import type { APIRoute } from 'astro'
import { purge } from '../../../../../../../server/cache'
import { publishResults } from '../../../../../../../server/competition/results'
import { handle, json, readJson, requireRole } from '../../../../../../../server/http'
import { getServices } from '../../../../../../../server/services'

/** Publishes the match day's draft results: { baseUpdatedAt }. Editors and up. Audited as results.publish; purges. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    const { result, purge: targets } = await publishResults(getServices().db, actor, params.id!, params.dayId!, await readJson(request))
    return json({ matchDay: result, cache: await purge(cache, targets) })
  })
