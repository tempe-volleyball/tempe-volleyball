import type { APIRoute } from 'astro'
import { purge } from '../../../../../server/cache'
import { handle, json, readJson, requireRole } from '../../../../../server/http'
import { addSessions, listSessions } from '../../../../../server/programmes/schedule'
import { getServices } from '../../../../../server/services'

/** A training programme's sessions, or a term's (?termId=), optionally ?from=&to= (YYYY-MM-DD). Editors and up. */
export const GET: APIRoute = ({ locals, request, params, url }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'editor', request, db)
    const termId = url.searchParams.get('termId')
    const sessions = await listSessions(db, params.id!, {
      ...(termId !== null ? { termId: termId || null } : {}),
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
    })
    return json({ sessions })
  })

/** Adds one session ({ date, … }) or a weekly run ({ from, to, weekday?, everyWeeks?, skip?, … }). Admins. */
export const POST: APIRoute = ({ locals, request, params, cache }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const { result, purge: targets } = await addSessions(db, actor, params.id!, await readJson(request))
    return json({ ...result, cache: await purge(cache, targets) }, 201)
  })
