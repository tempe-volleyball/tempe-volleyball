import type { APIRoute } from 'astro'
import { purge } from '../../../../../../server/cache'
import { addAdjustment, listAdjustments } from '../../../../../../server/competition/adjustments'
import { handle, json, readJson, requireRole } from '../../../../../../server/http'
import { getServices } from '../../../../../../server/services'

/** The season's ladder adjustments. Editors and up. */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    return json({ adjustments: await listAdjustments(getServices().db, params.id!) })
  })

/** Adds one: { teamId, points, reason }. Admins. Audited as ladder.adjust; purges a public season's pages. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { result, purge: targets } = await addAdjustment(getServices().db, actor, params.id!, await readJson(request))
    return json({ adjustments: result, cache: await purge(cache, targets) }, 201)
  })
