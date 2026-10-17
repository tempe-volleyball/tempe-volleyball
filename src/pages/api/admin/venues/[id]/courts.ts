import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { createCourt, reorderCourts } from '../../../../../server/programmes/venues'
import { getServices } from '../../../../../server/services'

/** Adds a court: { name }. Admins. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await createCourt(db, actor, params.id!, await readJson(request))
    return json({ venue: result, cache: await purge(cache, targets) }, 201)
  })

/** Reorders the venue's courts: { ids }. Admins. */
export const PUT: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await reorderCourts(db, actor, params.id!, await readJson(request))
    return json({ venue: result, cache: await purge(cache, targets) })
  })
