import type { APIRoute } from 'astro'
import { purge } from '../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { deleteCategory, updateCategory } from '../../../../server/programmes/categories'
import { getServices } from '../../../../server/services'

/** Edits a category, status included: { baseUpdatedAt?, …fields }. A URL change leaves a 301. Admins. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await updateCategory(db, actor, params.id!, await readJson(request))
    return json({ category: result, cache: await purge(cache, targets) })
  })

/** Deletes an empty category the menu doesn't link to. Admins. */
export const DELETE: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { purge: targets } = await deleteCategory(db, actor, params.id!)
    return json({ ok: true, cache: await purge(cache, targets) })
  })
