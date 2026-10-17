import type { APIRoute } from 'astro'
import { revokeInvite } from '../../../../server/auth/roles'
import { handle, json, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Revoke a pending invite. */
export const DELETE: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const actor = requireRole(locals.user, 'admin', request)
    await revokeInvite(getServices().db, actor, params.id!)
    return json({ ok: true })
  })
