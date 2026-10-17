import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { setFormProgrammes } from '../../../../../server/enrolment/forms'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/** Makes this form the default for exactly these programmes: { programmeIds }. Audited. */
export const PUT: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { purge: targets } = await setFormProgrammes(db, actor, params.id!, await readJson(request))
    return json({ ok: true, cache: await purge(cache, targets) })
  })
