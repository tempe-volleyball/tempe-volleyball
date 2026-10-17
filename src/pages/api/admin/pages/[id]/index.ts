import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { deletePage, getPage, updatePage } from '../../../../../server/content/pages'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { getServices } from '../../../../../server/services'

/** One page with its last 20 revisions. */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    return json(await getPage(getServices().db, params.id!))
  })

/** Saves edits ({ title?, path?, metaDescription?, ogImageId?, template?, blocks?, baseUpdatedAt? }). Live pages are purged. */
export const PATCH: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    const { result, purge: targets } = await updatePage(getServices().db, actor, params.id!, await readJson(request))
    return json({ page: result, cache: await purge(cache, targets) })
  })

/** Deletes a page (refused while the menu links to it). Audited. */
export const DELETE: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    const { purge: targets } = await deletePage(getServices().db, actor, params.id!)
    return json({ ok: true, cache: await purge(cache, targets) })
  })
