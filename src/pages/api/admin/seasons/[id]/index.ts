import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { deleteSeason, getSeason, updateSeason } from '../../../../../server/competition/seasons'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/** The season as a lib Competition, with its league, venue, courts, match day tokens and ladder adjustments. Editors and up. */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    return json(await getSeason(getServices().db, params.id!))
  })

/** Saves settings: { baseUpdatedAt, settings }. Admins. Audited; purges a public season's pages. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { result, purge: targets } = await updateSeason(getServices().db, actor, params.id!, await readJson(request))
    return json({ ...result, cache: await purge(cache, targets) })
  })

/** Deletes a draft season: ?baseUpdatedAt= (or a { baseUpdatedAt } body). Admins. Audited. */
export const DELETE: APIRoute = ({ locals, request, params, url }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const fromQuery = url.searchParams.get('baseUpdatedAt')
    const body = fromQuery ? { baseUpdatedAt: fromQuery } : await readJson(request)
    return json(await deleteSeason(getServices().db, actor, params.id!, body))
  })
