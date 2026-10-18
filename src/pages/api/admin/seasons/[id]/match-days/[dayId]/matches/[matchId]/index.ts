import type { APIRoute } from 'astro'
import { purge } from '../../../../../../../../../server/cache'
import { setMatchDetails } from '../../../../../../../../../server/competition/results'
import { handle, json, readJson, requireRole } from '../../../../../../../../../server/http'
import { getServices } from '../../../../../../../../../server/services'

/** Sets a game's referee: { baseUpdatedAt (match day), referee }. Editors and up. Audited as match.update; purges. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    const { result, purge: targets } = await setMatchDetails(
      getServices().db,
      actor,
      params.id!,
      params.dayId!,
      params.matchId!,
      await readJson(request),
    )
    return json({ ...result, cache: await purge(cache, targets) })
  })
