import type { APIRoute } from 'astro'
import { countTrustedDevices, revokeTrustedDevices, trustDeviceDays } from '../../../../server/auth/trusted-devices'
import { handle, json, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Settings → Security's trust period (0 = off) and how many of your devices skip the authenticator code now. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'editor', request, db)
    const days = await trustDeviceDays(db)
    return json({ days, count: await countTrustedDevices(db, actor.id, days) })
  })

/** Forget all of your trusted devices: the next sign-in on each asks for the authenticator code. */
export const DELETE: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'editor', request, db)
    return json(await revokeTrustedDevices(db, actor, actor.id))
  })
