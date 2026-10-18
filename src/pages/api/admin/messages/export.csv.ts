import type { APIRoute } from 'astro'
import { exportMessages, parseFilter } from '../../../../server/contact/messages'
import { handle, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** The inbox as CSV (?filter= as the list; default open). Admin+, role re-read from D1, audited as message.export. */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const { csv, filename } = await exportMessages(db, actor, parseFilter(url.searchParams.get('filter')))
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  })
