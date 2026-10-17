import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { setProgrammeStatus } from '../../../../../server/programmes/programmes'
import { getServices } from '../../../../../server/services'

/** { status: 'draft' | 'active' | 'retired', baseUpdatedAt? }: make live, retire, reactivate. Admins. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await setProgrammeStatus(db, actor, params.id!, await readJson(request))
    return json({ ...result, cache: await purge(cache, targets) })
  })
