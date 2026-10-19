import type { APIRoute } from 'astro'
import { interestOptions } from '../../../../server/interest/admin'
import { handle, json, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** What the "Add EOI" dialog needs: programmes (with deposits), the EOI form's questions, the member limit. Admin+. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await interestOptions(db))
  })
