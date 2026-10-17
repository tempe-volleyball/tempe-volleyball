import type { APIRoute } from 'astro'
import { purge } from '../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { createCategory, listCategories } from '../../../../server/programmes/categories'
import { getServices } from '../../../../server/services'

/** Every category with programme counts. Editors and up. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'editor', request, db)
    return json({ categories: await listCategories(db) })
  })

/** A new category: { name, slug?, intro?, seoTitle?, seoDescription?, ogImageId?, status? }. Admins. */
export const POST: APIRoute = ({ locals, request, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await createCategory(db, actor, await readJson(request))
    return json({ category: result, cache: await purge(cache, targets) }, 201)
  })
