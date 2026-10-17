import type { APIRoute } from 'astro'
import { clashDraws } from '../../../../../server/competition/clashes'
import { handle, json, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/** Other seasons' draws at the same venue overlapping ?from=&to= (default: this season's dates), for courtClashes(). */
export const GET: APIRoute = ({ locals, request, params, url }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    const range = { from: url.searchParams.get('from'), to: url.searchParams.get('to') }
    return json(await clashDraws(getServices().db, params.id!, range))
  })
