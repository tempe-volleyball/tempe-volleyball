import type { APIRoute } from 'astro'
import { deleteInterests, getInterest, interestAction, INTEREST_BODY_LIMIT } from '../../../../server/interest/admin'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/**
 * One expression of interest (docs/api/interest-admin.md). Admins and owners, role re-read from D1. GET: the EOI with
 * its people (and their player records), programmes, answers and history. POST { action, … }: note, mark_paid,
 * mark_unpaid, status, archive, unarchive, team_name, add_programme, remove_programme, apply_details. DELETE
 * (?keepPlayers=1 keeps the player rows it created): for good, audited without personal data.
 */
export const GET: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await getInterest(db, params.id ?? ''))
  })

export const POST: APIRoute = ({ locals, request, params }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const body = await readJson<Record<string, unknown>>(request, { maxBytes: INTEREST_BODY_LIMIT })
    return json(await interestAction(db, actor, params.id ?? '', body))
  })

export const DELETE: APIRoute = ({ locals, request, params, url }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await deleteInterests(db, actor, [params.id], { keepPlayers: url.searchParams.get('keepPlayers') === '1' }))
  })
