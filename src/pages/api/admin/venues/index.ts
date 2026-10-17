import type { APIRoute } from 'astro'
import { purge } from '../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { createVenue, listVenues } from '../../../../server/programmes/venues'
import { getServices } from '../../../../server/services'

/** Every venue with its courts and what uses them. Editors and up. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'editor', request, db)
    return json({ venues: await listVenues(db) })
  })

/** A new venue: { name, slug?, address?, mapUrl?, directions? }. Admins. */
export const POST: APIRoute = ({ locals, request, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await createVenue(db, actor, await readJson(request))
    return json({ venue: result, cache: await purge(cache, targets) }, 201)
  })
