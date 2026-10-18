import type { APIRoute } from 'astro'
import { unreadCount } from '../../../../server/contact/messages'
import { handle, json, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** { unread } for the admin nav's badge. Admin+ (editors can't open the inbox). One indexed count, nothing personal. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db)
    return json({ unread: await unreadCount(db) })
  })
