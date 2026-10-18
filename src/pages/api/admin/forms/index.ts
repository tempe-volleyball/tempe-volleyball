import type { APIRoute } from 'astro'
import { createForm, listForms } from '../../../../server/enrolment/forms'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Every enrolment form with where it's used, the default questions per kind, and the programmes. Admin+. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await listForms(db))
  })

/** Creates a form: { name, description?, fields? | template?: kind, confirmationText? }. Audited. */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    return json({ form: await createForm(db, actor, await readJson(request)) }, 201)
  })
