import type { APIRoute } from 'astro'
import { listLeagues } from '../../../server/competition/seasons'
import { handle, json, requireRole } from '../../../server/http'
import { getServices } from '../../../server/services'

/** Every league with its venue, the venue's courts and its seasons (newest first). Editors and up. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    return json({ leagues: await listLeagues(getServices().db) })
  })
