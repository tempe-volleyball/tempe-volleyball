import type { APIRoute } from 'astro'
import { registrationAction } from '../../../../../server/enrolment/admin'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getEnrolmentDeps } from '../../../../../server/services'

/**
 * One action on an enrolment: { action: 'mark_paid' | 'mark_unpaid' | 'cancel' | 'reinstate' | 'offer' | 'confirm' |
 * 'resend_offer' | 'move' | 'place' | 'edit' | 'delete', … }. Audited. See docs/api/enrolment.md.
 */
export const POST: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const deps = getEnrolmentDeps()
    const actor = await requireRole(locals.user, 'admin', request, deps.db)
    return json(await registrationAction(deps, actor, params.id!, await readJson(request)))
  })
