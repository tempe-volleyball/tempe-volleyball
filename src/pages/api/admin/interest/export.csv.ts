import type { APIRoute } from 'astro'
import { exportInterests, parseInterestFilter } from '../../../../server/interest/admin'
import { handle, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** The EOIs matching the inbox's filter (same query string) as CSV, one row per person. Admin+, fresh role, audited. */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const { csv, filename } = await exportInterests(db, actor, parseInterestFilter(url.searchParams))
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  })
