import type { APIRoute } from 'astro'
import { addGroup, parseTargetRef } from '../../../../../../../server/enrolment/admin'
import { handle, json, readJson, requireRole } from '../../../../../../../server/http'
import { getEnrolmentDeps } from '../../../../../../../server/services'

/** Adds a team entry with no captain (to place free agents into): { name }. Audited. */
export const POST: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const deps = getEnrolmentDeps()
    const actor = await requireRole(locals.user, 'admin', request, deps.db)
    return json({ group: await addGroup(deps, actor, parseTargetRef(params.kind, params.id), await readJson(request)) }, 201)
  })
