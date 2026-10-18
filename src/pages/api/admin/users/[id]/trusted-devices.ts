import type { APIRoute } from 'astro'
import { revokeTrustedDevices } from '../../../../../server/auth/trusted-devices'
import { handle, json, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/** Forget a user's trusted devices (someone whose account you could remove; owners manage everyone). */
export const DELETE: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    return json(await revokeTrustedDevices(db, actor, params.id!))
  })
