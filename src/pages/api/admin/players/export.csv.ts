import type { APIRoute } from 'astro'
import { exportPlayers, parsePlayerQuery } from '../../../../server/players/admin'
import { handle, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** A pool's players matching the list's filters (same query string, every page) as CSV. Admin+, fresh role, audited. */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const { csv, filename, truncated } = await exportPlayers(db, actor, parsePlayerQuery(url.searchParams))
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        // More matched than the export writes (EXPORT_LIMIT); the filename says "first-5000" too.
        ...(truncated ? { 'X-Export-Truncated': '1' } : {}),
      },
    })
  })
