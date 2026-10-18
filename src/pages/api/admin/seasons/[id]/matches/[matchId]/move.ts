import type { APIRoute } from 'astro'
import { purge } from '../../../../../../../server/cache'
import { moveMatch, parseMoveAction, undoMoveMatch } from '../../../../../../../server/competition/move'
import { handle, json, readJson, requireRole } from '../../../../../../../server/http'
import { getServices } from '../../../../../../../server/services'

/**
 * Moves one game to another night: { baseUpdatedAt (season), toWeekId | date, session, position }, or puts back its
 * last move: { baseUpdatedAt, action: 'undo' }. Admins. Audited as match.move / match.move_undo; purges. Returns
 * the season view (plus { warnings, created } for a move).
 */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const db = getServices().db
    const actor = await requireRole(locals.user, 'admin', request, db)
    const body = await readJson(request)
    const { result, purge: targets } =
      parseMoveAction(body.action) === 'undo'
        ? await undoMoveMatch(db, actor, params.id!, params.matchId!, body)
        : await moveMatch(db, actor, params.id!, params.matchId!, body)
    return json({ ...result, cache: await purge(cache, targets) })
  })
