import type { APIRoute } from 'astro'
import { listAdminUsers, listPendingInvites } from '../../../../server/auth/roles'
import { handle, json, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Admin users and pending invites. Admins and owners only. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    // Fresh: the list has emails, so a demoted admin stops reading it at once (not after the 5-minute cookie cache).
    await requireRole(locals.user, 'admin', request, getServices().db, { fresh: true })
    const { db } = getServices()
    const [users, invites] = await Promise.all([listAdminUsers(db), listPendingInvites(db)])
    return json({ users, invites })
  })
