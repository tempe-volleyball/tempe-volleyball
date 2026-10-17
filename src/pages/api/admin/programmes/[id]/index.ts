import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { deleteProgramme, getProgramme, updateProgramme } from '../../../../../server/programmes/programmes'
import { getServices } from '../../../../../server/services'

/** One programme: the row, generated text, history (what blocks delete) and the form's pickers. Editors and up. */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'editor', request, db)
    return json(await getProgramme(db, params.id!))
  })

/** Saves edits: { baseUpdatedAt, …fields }. A URL change on a public programme leaves 301s. Admins. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await updateProgramme(db, actor, params.id!, await readJson(request))
    return json({ ...result, cache: await purge(cache, targets) })
  })

/** Deletes a programme with no history (else 409: retire it). Admins. */
export const DELETE: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { purge: targets } = await deleteProgramme(db, actor, params.id!)
    return json({ ok: true, cache: await purge(cache, targets) })
  })
