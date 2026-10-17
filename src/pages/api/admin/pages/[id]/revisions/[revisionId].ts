import type { APIRoute } from 'astro'
import { purge } from '../../../../../../server/cache'
import { getRevision, restoreRevision } from '../../../../../../server/content/pages'
import { handle, json, requireRole } from '../../../../../../server/http'
import { getServices } from '../../../../../../server/services'

/** One revision (title and body), to preview before restoring. */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    requireRole(locals.user, 'editor', request)
    return json({ revision: await getRevision(getServices().db, params.id!, params.revisionId!) })
  })

/** Restores the revision's title and body (saved as a new revision, so it can be undone). */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const actor = requireRole(locals.user, 'editor', request)
    const { result, purge: targets } = await restoreRevision(getServices().db, actor, params.id!, params.revisionId!)
    return json({ page: result, cache: await purge(cache, targets) })
  })
