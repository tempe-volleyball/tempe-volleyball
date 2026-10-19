import type { APIRoute } from 'astro'
import { createPlayer, listPlayers, parsePlayerQuery, PLAYER_BODY_LIMIT } from '../../../../server/players/admin'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/**
 * Admin → Players (docs/api/players.md). Admins and owners, role re-read from D1 (personal data). GET ?pool=
 * competition|training&q=&group=interest|last|past|retired|other|all&league=&programme=&retired=hide|only|any
 * &sort=name|newest|updated&page=. POST { pool, firstName, lastName, … , force? } adds a player by hand.
 */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await listPlayers(db, parsePlayerQuery(url.searchParams)))
  })

export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await createPlayer(db, actor, await readJson(request, { maxBytes: PLAYER_BODY_LIMIT })), 201)
  })
