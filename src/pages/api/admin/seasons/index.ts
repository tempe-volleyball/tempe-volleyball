import type { APIRoute } from 'astro'
import { createSeason } from '../../../../server/competition/seasons'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Creates a draft season: { leagueId, year, quarter, startDate?, name?, copyFrom? }. Admins. Audited. */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    return json(await createSeason(getServices().db, actor, await readJson(request)), 201)
  })
