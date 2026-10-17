import type { APIRoute } from 'astro'
import { purge } from '../../../server/cache'
import { getMenu, saveMenu } from '../../../server/content/menu'
import { handle, json, readJson, requireRole } from '../../../server/http'
import { getServices } from '../../../server/services'

/** The menu tree plus the pages and leagues items can link to. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    requireRole(locals.user, 'editor', request)
    return json(await getMenu(getServices().db))
  })

/** Replaces the whole menu: { items: MenuInput[] }. Audited; purges every public page. */
export const PUT: APIRoute = ({ locals, request, cache }) =>
  handle(async () => {
    const actor = requireRole(locals.user, 'editor', request)
    const { items } = await readJson<{ items: unknown }>(request)
    const db = getServices().db
    const { purge: targets } = await saveMenu(db, actor, items)
    return json({ ...(await getMenu(db)), cache: await purge(cache, targets) })
  })
