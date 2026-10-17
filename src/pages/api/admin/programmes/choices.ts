import type { APIRoute } from 'astro'
import { handle, json, requireRole } from '../../../../server/http'
import { programmeChoices } from '../../../../server/programmes/programmes'
import { getServices } from '../../../../server/services'

/** Categories, venues and enrolment forms for the programme form's pickers. Editors and up. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'editor', request, db)
    return json(await programmeChoices(db))
  })
