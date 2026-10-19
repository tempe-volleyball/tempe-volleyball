import type { APIRoute } from 'astro'
import { changeRoster, getRosters, rosterSources } from '../../../../../server/competition/rosters'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/**
 * The season's rosters (team by team, with each player's contact details) and, unless ?sources=0, where teams can
 * come from (returning teams with the roster that would be copied, and team EOIs). Admins only, with the role
 * re-read from D1: rosters are personal data, so editors (who can open seasons) can't read them.
 */
export const GET: APIRoute = ({ locals, request, params, url }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const withSources = url.searchParams.get('sources') !== '0'
    const [rosters, sources] = await Promise.all([getRosters(db, params.id!), withSources ? rosterSources(db, params.id!) : null])
    return json({ ...rosters, ...(sources ? { sources } : {}) })
  })

/** One roster change, saved straight away: { action: add | remove | move | replace | captain | order, … }. Admins. Audited. */
export const POST: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    return json(await changeRoster(db, actor, params.id!, await readJson(request)))
  })
