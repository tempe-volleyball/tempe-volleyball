import type { APIRoute } from 'astro'
import { pageViews } from '../../../../server/analytics/stats'
import { handle, json, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Views per page path over the last 30 days, for Admin → Pages: { source, days, views: { [path]: n } }. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'editor', request, db)
    return json(await pageViews(db, new Date()))
  })
