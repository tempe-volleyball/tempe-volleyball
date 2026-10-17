import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { deleteForm, getForm, updateForm } from '../../../../../server/enrolment/forms'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db)
    return json({ form: await getForm(db, params.id!) })
  })

/** Saves a form: { baseUpdatedAt, name?, description?, fields?, confirmationText?, archived? }. Bumps the version. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await updateForm(db, actor, params.id!, await readJson(request))
    return json({ form: result, cache: await purge(cache, targets) })
  })

/** Deletes a form nobody has answered and nothing uses (otherwise 409: archive it). */
export const DELETE: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    await deleteForm(db, actor, params.id!)
    return json({ ok: true })
  })
