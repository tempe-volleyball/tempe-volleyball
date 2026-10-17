import type { APIRoute } from 'astro'
import { addEntry, parseTargetRef } from '../../../../../../../server/enrolment/admin'
import { handle, json, readJson, requireRole } from '../../../../../../../server/http'
import { getEnrolmentDeps } from '../../../../../../../server/services'

/** Adds an enrolment by hand: { entryType, person, answers, status?: 'confirmed' | 'waitlist', notify? }. Audited. */
export const POST: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const deps = getEnrolmentDeps()
    const actor = await requireRole(locals.user, 'admin', request, deps.db)
    const result = await addEntry(deps, actor, parseTargetRef(params.kind, params.id), await readJson(request))
    return json(result, 201)
  })
