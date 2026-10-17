import type { APIRoute } from 'astro'
import { purge } from '../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { reorderCategories } from '../../../../server/programmes/categories'
import { getServices } from '../../../../server/services'

/** { ids }: every category id in the new order. Admins. */
export const PUT: APIRoute = ({ locals, request, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await reorderCategories(db, actor, await readJson(request))
    return json({ categories: result, cache: await purge(cache, targets) })
  })
