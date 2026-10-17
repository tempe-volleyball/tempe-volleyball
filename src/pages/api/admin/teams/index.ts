import type { APIRoute } from 'astro'
import { createTeam, listTeams } from '../../../../server/competition/teams'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Every team, with its newest season. Editors and up. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    return json({ teams: await listTeams(getServices().db) })
  })

/** Creates a team: { name }. Admins. Audited. */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    return json({ team: await createTeam(getServices().db, actor, await readJson(request)) }, 201)
  })
