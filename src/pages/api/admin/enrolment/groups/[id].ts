import type { APIRoute } from 'astro'
import { groupAction } from '../../../../../server/enrolment/admin'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getEnrolmentDeps } from '../../../../../server/services'

/**
 * One action on a team entry: { action: 'cancel' | 'reinstate' | 'offer' | 'confirm' | 'resend_offer' | 'rename' |
 * 'notes' | 'link_team' | 'delete', … }. Audited.
 */
export const POST: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const deps = getEnrolmentDeps()
    const actor = await requireRole(locals.user, 'admin', request, deps.db)
    return json(await groupAction(deps, actor, params.id!, await readJson(request)))
  })
