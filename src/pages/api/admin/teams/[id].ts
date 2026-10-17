import type { APIRoute } from 'astro'
import { purge } from '../../../../server/cache'
import { renameTeam } from '../../../../server/competition/teams'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Renames a team: { name }. Admins. Audited; purges every public page (ladders and fixtures show names). */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { result, purge: targets } = await renameTeam(getServices().db, actor, params.id!, await readJson(request))
    return json({ team: result, cache: await purge(cache, targets) })
  })
