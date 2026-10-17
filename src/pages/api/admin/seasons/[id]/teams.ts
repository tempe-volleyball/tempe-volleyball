import type { APIRoute } from 'astro'
import { setSeasonTeams } from '../../../../../server/competition/seasons'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/** Replaces a draft season's teams: { baseUpdatedAt, teamIds } (in order). Admins. Audited. */
export const PUT: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    return json(await setSeasonTeams(getServices().db, actor, params.id!, await readJson(request)))
  })
