import type { APIRoute } from 'astro'
import { saveResults } from '../../../../../../../server/competition/results'
import { handle, json, readJson, requireRole } from '../../../../../../../server/http'
import { getServices } from '../../../../../../../server/services'

/** Saves draft results: { baseUpdatedAt, results: { [matchId]: Result | null } }. Editors and up. Not public until published. */
export const PUT: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    return json({ matchDay: await saveResults(getServices().db, actor, params.id!, params.dayId!, await readJson(request)) })
  })
