import type { APIRoute } from 'astro'
import { deleteMessages, listMessages, parseFilter, setStatuses } from '../../../../server/contact/messages'
import { HttpError, handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/**
 * The contact-form inbox (docs/api/contact.md). Admin+, with the role re-read from D1: messages are personal data.
 * GET ?filter=open|new|read|handled|all&q=&topic=&before=<cursor>. POST { action: 'status', ids, status } or
 * { action: 'delete', ids } for bulk actions (at most 90 ids).
 */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const p = url.searchParams
    return json(
      await listMessages(db, { filter: parseFilter(p.get('filter')), q: p.get('q'), topic: p.get('topic'), before: p.get('before') }),
    )
  })

export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const body = await readJson<{ action: string; ids: unknown; status: unknown }>(request)
    if (body.action === 'delete') return json(await deleteMessages(db, body.ids, actor))
    if (body.action === 'status') return json(await setStatuses(db, body.ids, body.status, actor))
    throw new HttpError(400, 'invalid_input', 'Unknown action.')
  })
