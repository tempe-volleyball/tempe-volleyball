import type { APIRoute } from 'astro'
import { purge } from '../../../../../../../server/cache'
import { reinstateTeam } from '../../../../../../../server/competition/withdraw'
import { handle, json, readJson, requireRole } from '../../../../../../../server/http'
import { getServices } from '../../../../../../../server/services'

/** Undoes a withdrawal: { baseUpdatedAt (season) }. Admins. Audited as team.reinstate; purges. Returns the view plus { restored }. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { result, purge: targets } = await reinstateTeam(getServices().db, actor, params.id!, params.teamId!, await readJson(request))
    return json({ ...result, cache: await purge(cache, targets) })
  })
