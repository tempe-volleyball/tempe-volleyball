import type { APIRoute } from 'astro'
import { enrolmentsCsv } from '../../../../../../../lib/enrolment/csv'
import { getTargetDetail, parseTargetRef } from '../../../../../../../server/enrolment/admin'
import { handle, requireRole } from '../../../../../../../server/http'
import { getServices } from '../../../../../../../server/services'

/** CSV of a target's enrolments (?status=all includes cancelled and expired ones). Admin+. Never cached. */
export const GET: APIRoute = ({ locals, request, params, url }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const detail = await getTargetDetail(db, parseTargetRef(params.kind, params.id), actor.id)
    const all = url.searchParams.get('status') === 'all'
    const rows = detail.registrations.filter((r) => all || !['cancelled', 'expired', 'refunded'].includes(r.status))
    const name = `${detail.summary.programme.code}-${detail.summary.label}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    return new Response(enrolmentsCsv(detail.form.fields, rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name || 'enrolments'}-enrolments.csv"`,
        'Cache-Control': 'no-store',
      },
    })
  })
