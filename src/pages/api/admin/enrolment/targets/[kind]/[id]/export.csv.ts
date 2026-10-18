import type { APIRoute } from 'astro'
import { exportEnrolments, parseTargetRef } from '../../../../../../../server/enrolment/admin'
import { handle, requireRole } from '../../../../../../../server/http'
import { getServices } from '../../../../../../../server/services'

/**
 * CSV of a target's enrolments (?status=all includes cancelled and expired ones). Admin+, with the role re-read
 * from D1, and audited as enrolment.export (it's everyone's personal details). Never cached.
 */
export const GET: APIRoute = ({ locals, request, params, url }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const all = url.searchParams.get('status') === 'all'
    const { csv, filename } = await exportEnrolments(db, actor, parseTargetRef(params.kind, params.id), all)
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  })
