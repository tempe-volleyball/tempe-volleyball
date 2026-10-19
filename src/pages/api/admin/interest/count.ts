import type { APIRoute } from 'astro'
import { newInterestCount } from '../../../../server/interest/admin'
import { handle, json, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** { new } for the admin nav's badge: EOIs with a programme still new. Admin+, fresh role. One indexed count. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json({ new: await newInterestCount(db) })
  })
