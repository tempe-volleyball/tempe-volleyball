import type { APIRoute } from 'astro'
import { changeRole, isRole, removeUser } from '../../../../server/auth/roles'
import { HttpError, handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Change a user's role: { role }. roles.ts enforces who may do what. */
export const PATCH: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { role } = await readJson<{ role: string }>(request)
    if (!isRole(role)) throw new HttpError(400, 'invalid_input', 'Unknown role.')
    return json(await changeRole(getServices().db, actor, params.id!, role))
  })

/** Remove an admin user. */
export const DELETE: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    await removeUser(getServices().db, actor, params.id!)
    return json({ ok: true })
  })
