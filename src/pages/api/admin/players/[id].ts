import type { APIRoute } from 'astro'
import { deletePlayer, getPlayer, mergePlayers, setRetired, updatePlayer, PLAYER_BODY_LIMIT } from '../../../../server/players/admin'
import { HttpError, handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/**
 * One player (docs/api/players.md). Admins and owners, role re-read from D1. GET: details, EOIs, enrolments, rosters,
 * history. PATCH { baseUpdatedAt?, …fields }. POST { action: 'retire' | 'unretire' } or { action: 'merge', mergeId,
 * fillBlanks? } (merges mergeId into this one). DELETE: only with no history (409 in_use otherwise).
 */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await getPlayer(db, params.id ?? ''))
  })

export const PATCH: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await updatePlayer(db, actor, params.id ?? '', await readJson(request, { maxBytes: PLAYER_BODY_LIMIT })))
  })

export const POST: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const body = await readJson<Record<string, unknown>>(request, { maxBytes: PLAYER_BODY_LIMIT })
    const id = params.id ?? ''
    if (body.action === 'retire' || body.action === 'unretire') return json(await setRetired(db, actor, id, body.action === 'retire'))
    if (body.action === 'merge') return json(await mergePlayers(db, actor, id, body))
    throw new HttpError(400, 'invalid_input', 'Unknown action.')
  })

export const DELETE: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await deletePlayer(db, actor, params.id ?? ''))
  })
