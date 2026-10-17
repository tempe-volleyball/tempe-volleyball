import type { APIRoute } from 'astro'
import { listMatches, matchListQuery } from '../../../server/competition/match-list'
import { handle, json, requireRole } from '../../../server/http'
import { getServices } from '../../../server/services'

/**
 * Every game across leagues: ?from=&to= (default: the next 7 days) &league= &season= &team= &venue= &court= &status=
 * &drafts=1. Editors and up. At most 500 rows (`truncated` says when there were more).
 */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    return json(await listMatches(getServices().db, matchListQuery(url.searchParams)))
  })
