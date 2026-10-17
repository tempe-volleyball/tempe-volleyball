import type { APIRoute } from 'astro'
import { undoResults } from '../../../../../../../server/competition/results'
import { handle, json, readJson, requireRole } from '../../../../../../../server/http'
import { getServices } from '../../../../../../../server/services'

/** Throws away unpublished result edits for the match day: { baseUpdatedAt }. Editors and up. */
export const POST: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    return json({ matchDay: await undoResults(getServices().db, actor, params.id!, params.dayId!, await readJson(request)) })
  })
