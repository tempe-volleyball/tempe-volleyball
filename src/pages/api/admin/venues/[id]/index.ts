import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { deleteVenue, updateVenue } from '../../../../../server/programmes/venues'
import { getServices } from '../../../../../server/services'

/** Edits a venue. Admins. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await updateVenue(db, actor, params.id!, await readJson(request))
    return json({ venue: result, cache: await purge(cache, targets) })
  })

/** Deletes an unused venue with no courts. Admins. */
export const DELETE: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { purge: targets } = await deleteVenue(db, actor, params.id!)
    return json({ ok: true, cache: await purge(cache, targets) })
  })
