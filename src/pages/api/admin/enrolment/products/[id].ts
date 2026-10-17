import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { updateProduct } from '../../../../../server/enrolment/admin'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getEnrolmentDeps } from '../../../../../server/services'

/** One target's enrolment settings (caps, price, form, window, waitlist); null = the programme's. Audited. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const deps = getEnrolmentDeps()
    const actor = await requireRole(locals.user, 'admin', request, deps.db)
    const { product, offered, purge: targets } = await updateProduct(deps, actor, params.id!, await readJson(request))
    return json({ product, offered, cache: await purge(cache, targets) })
  })
