import type { APIRoute } from 'astro'
import { purge } from '../../../../../../../server/cache'
import { setNightStatus } from '../../../../../../../server/competition/nights'
import { handle, json, readJson, requireRole } from '../../../../../../../server/http'
import { getServices } from '../../../../../../../server/services'

/**
 * A whole night: { baseUpdatedAt (season), action: 'postpone' | 'cancel' | 'restore', note?, pushBack? }. Admins.
 * Audited (match_day.postpone / cancel / restore, season.push_back); purges. Returns the season view.
 */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { result, purge: targets } = await setNightStatus(getServices().db, actor, params.id!, params.dayId!, await readJson(request))
    return json({ ...result, cache: await purge(cache, targets) })
  })
