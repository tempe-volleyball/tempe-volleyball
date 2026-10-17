import type { APIRoute } from 'astro'
import { purge } from '../../../../../../../server/cache'
import { withdrawTeam } from '../../../../../../../server/competition/withdraw'
import { handle, json, readJson, requireRole } from '../../../../../../../server/http'
import { getServices } from '../../../../../../../server/services'

/**
 * Marks a team withdrawn: { baseUpdatedAt (season), reason, cancelFixtures? (default true), from? }. Admins.
 * Audited as team.withdraw; purges. Returns the season view plus { cancelled, dutyGames }.
 */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { result, purge: targets } = await withdrawTeam(getServices().db, actor, params.id!, params.teamId!, await readJson(request))
    return json({ ...result, cache: await purge(cache, targets) })
  })
