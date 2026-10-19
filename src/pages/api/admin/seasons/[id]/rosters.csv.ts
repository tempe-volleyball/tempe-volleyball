import type { APIRoute } from 'astro'
import { exportRosters } from '../../../../../server/competition/rosters'
import { handle, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/** The season's rosters as CSV (team, role, name, email, phone, gender). Admins, role re-read; audited as roster.export. */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const { csv, filename } = await exportRosters(db, actor, params.id!)
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  })
