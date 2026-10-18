import type { APIRoute } from 'astro'
import { purge } from '../../../../../../server/cache'
import { undoMerge } from '../../../../../../server/competition/teams'
import { handle, json, requireRole } from '../../../../../../server/http'
import { getServices } from '../../../../../../server/services'

/**
 * Undoes a team merge (the team.merge audit row's id): the merged team comes back with its seasons, games, duties,
 * adjustments, enrolment groups and feeds. 409 cannot_undo after 30 days, once undone, or when its name or web address
 * has been taken since. Admins. Audited as team.merge_undo; purges every public page.
 */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const { result, purge: targets } = await undoMerge(db, actor, params.auditId!)
    return json({ ...result, cache: await purge(cache, targets) })
  })
