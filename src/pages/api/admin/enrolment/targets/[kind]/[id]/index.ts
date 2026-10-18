import type { APIRoute } from 'astro'
import { purge } from '../../../../../../../server/cache'
import { PAYMENT_METHODS, getTargetDetail, parseTargetRef, updateTargetSettings } from '../../../../../../../server/enrolment/admin'
import { handle, json, readJson, requireRole } from '../../../../../../../server/http'
import { getEnrolmentDeps, getServices } from '../../../../../../../server/services'

/**
 * One target (season, session, term or event) with every entry, its settings and its form. Admin+ (personal data),
 * with the role re-read from D1 even though it's a GET. Read-only: it never creates the product row.
 */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const detail = await getTargetDetail(db, parseTargetRef(params.kind, params.id))
    return json({ ...detail, paymentMethods: PAYMENT_METHODS })
  })

/** Saves the target's enrolment settings (as PATCH /api/admin/enrolment/products/:id), creating its product row first if needed. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const deps = getEnrolmentDeps()
    const actor = await requireRole(locals.user, 'admin', request, deps.db)
    const ref = parseTargetRef(params.kind, params.id)
    const { product, offered, purge: targets } = await updateTargetSettings(deps, actor, ref, await readJson(request))
    return json({ product, offered, cache: await purge(cache, targets) })
  })
