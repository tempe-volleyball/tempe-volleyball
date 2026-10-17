import type { APIRoute } from 'astro'
import { PAYMENT_METHODS, getTargetDetail, parseTargetRef } from '../../../../../../../server/enrolment/admin'
import { handle, json, requireRole } from '../../../../../../../server/http'
import { getServices } from '../../../../../../../server/services'

/** One target (season, session, term or event) with every entry, its settings and its form. Admin+ (personal data). */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const detail = await getTargetDetail(db, parseTargetRef(params.kind, params.id), actor.id)
    return json({ ...detail, paymentMethods: PAYMENT_METHODS })
  })
