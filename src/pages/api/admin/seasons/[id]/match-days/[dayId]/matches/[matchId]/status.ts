import type { APIRoute } from 'astro'
import { purge } from '../../../../../../../../../server/cache'
import { setMatchStatus } from '../../../../../../../../../server/competition/results'
import { handle, json, readJson, requireRole } from '../../../../../../../../../server/http'
import { getServices } from '../../../../../../../../../server/services'

/** Marks a game played, forfeit or cancelled: { baseUpdatedAt, status }. Editors and up. Audited as match.status; purges. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    const { result, purge: targets } = await setMatchStatus(
      getServices().db,
      actor,
      params.id!,
      params.dayId!,
      params.matchId!,
      await readJson(request),
    )
    return json({ ...result, cache: await purge(cache, targets) })
  })
