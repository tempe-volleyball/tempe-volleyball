import type { APIRoute } from 'astro'
import { purge } from '../../../../../../server/cache'
import { deleteAdjustment, updateAdjustment } from '../../../../../../server/competition/adjustments'
import { handle, json, readJson, requireRole } from '../../../../../../server/http'
import { getServices } from '../../../../../../server/services'

/** Changes one: { points?, reason? }. Admins. Audited as ladder.adjust; purges a public season's pages. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { result, purge: targets } = await updateAdjustment(
      getServices().db,
      actor,
      params.id!,
      params.adjustmentId!,
      await readJson(request),
    )
    return json({ adjustments: result, cache: await purge(cache, targets) })
  })

/** Removes one. Admins. Audited as ladder.adjust; purges a public season's pages. */
export const DELETE: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { result, purge: targets } = await deleteAdjustment(getServices().db, actor, params.id!, params.adjustmentId!)
    return json({ adjustments: result, cache: await purge(cache, targets) })
  })
