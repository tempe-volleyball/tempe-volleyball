import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { mergeTeams } from '../../../../../server/competition/teams'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/**
 * Merges a duplicate into this team: { mergeId }. Its seasons, games, adjustments and groups move here and it's
 * deleted; 409 same_season if both played in one season. Admins. Audited as team.merge; purges every public page.
 */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { result, purge: targets } = await mergeTeams(getServices().db, actor, params.id!, await readJson(request))
    return json({ ...result, cache: await purge(cache, targets) })
  })
