import type { APIRoute } from 'astro'
import { purge } from '../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { deleteCourt, updateCourt } from '../../../../server/programmes/venues'
import { getServices } from '../../../../server/services'

/** Renames a court: { name }. Admins. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await updateCourt(db, actor, params.id!, await readJson(request))
    return json({ venue: result, cache: await purge(cache, targets) })
  })

/** Deletes an unused court. Admins. */
export const DELETE: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await deleteCourt(db, actor, params.id!)
    return json({ venue: result, cache: await purge(cache, targets) })
  })
