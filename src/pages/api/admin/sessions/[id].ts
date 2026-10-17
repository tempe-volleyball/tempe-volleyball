import type { APIRoute } from 'astro'
import { purge } from '../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { deleteSession, updateSession } from '../../../../server/programmes/schedule'
import { getServices } from '../../../../server/services'

/** Edits a session (fields, status, caps). Admins. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await updateSession(db, actor, params.id!, await readJson(request))
    return json({ session: result, cache: await purge(cache, targets) })
  })

/** Deletes a session nobody enrolled in (else 409: cancel it). Admins. */
export const DELETE: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { purge: targets } = await deleteSession(db, actor, params.id!)
    return json({ ok: true, cache: await purge(cache, targets) })
  })
