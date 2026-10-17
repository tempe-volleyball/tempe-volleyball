import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { createEvent, listEvents } from '../../../../../server/programmes/schedule'
import { getServices } from '../../../../../server/services'

/** An event programme's dates (occurrences). Editors and up. */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'editor', request, db)
    return json({ events: await listEvents(db, params.id!) })
  })

/** A new occurrence: { startDate, endDate?, name?, …, capacity?, capacityTeams? }. Admins. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await createEvent(db, actor, params.id!, await readJson(request))
    return json({ event: result, cache: await purge(cache, targets) }, 201)
  })
