import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { createTerm, listTerms } from '../../../../../server/programmes/schedule'
import { getServices } from '../../../../../server/services'

/** A development programme's terms. Editors and up. */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'editor', request, db)
    return json({ terms: await listTerms(db, params.id!) })
  })

/** A new term: { name, startDate, endDate?, …, capacity?, addSessions? }. Admins. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await createTerm(db, actor, params.id!, await readJson(request))
    return json({ term: result, cache: await purge(cache, targets) }, 201)
  })
