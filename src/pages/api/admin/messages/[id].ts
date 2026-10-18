import type { APIRoute } from 'astro'
import { deleteMessages, openMessage, updateMessage } from '../../../../server/contact/messages'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/**
 * One contact message (docs/api/contact.md). Admin+, role re-read from D1. GET opens it (a new one becomes read);
 * PATCH { status?, note? }; DELETE removes it for good (audited, without its content).
 */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await openMessage(db, params.id ?? ''))
  })

export const PATCH: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const body = await readJson<{ status: unknown; note: unknown }>(request)
    return json(await updateMessage(db, params.id ?? '', body, actor))
  })

export const DELETE: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await deleteMessages(db, [params.id], actor))
  })
