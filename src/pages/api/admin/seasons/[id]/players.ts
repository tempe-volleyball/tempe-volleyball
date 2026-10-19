import type { APIRoute } from 'astro'
import { sydneyDate } from '../../../../../lib/time'
import { seasonPlayerDirectory } from '../../../../../server/competition/rosters'
import { handle, json, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/**
 * The season builder's player picker: every competition player with their group for this season's league (New
 * interest, Last season, Past players, Retired), last team, open EOI and team this season. Admins, role re-read.
 */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await seasonPlayerDirectory(db, params.id!, sydneyDate(new Date())))
  })
