import type { APIRoute } from 'astro'
import { listAudit } from '../../../server/auth/roles'
import { handle, json, requireRole } from '../../../server/http'
import { getServices } from '../../../server/services'

/** The audit log, newest first: ?limit=50&before=<at of the last entry>. Admins and owners only. */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    requireRole(locals.user, 'admin', request)
    const limit = Number(url.searchParams.get('limit') ?? 50) || 50
    const before = url.searchParams.get('before') ?? undefined
    const entries = await listAudit(getServices().db, { limit, before })
    return json({ entries, next: entries.length === limit ? entries.at(-1)!.at : null })
  })
