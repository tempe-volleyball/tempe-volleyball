import type { APIRoute } from 'astro'
import {
  addInterestByHand,
  bulkInterestAction,
  deleteInterests,
  listInterests,
  parseInterestFilter,
  INTEREST_BODY_LIMIT,
} from '../../../../server/interest/admin'
import { HttpError, handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/**
 * The expressions-of-interest inbox (docs/api/interest-admin.md). Admins and owners, with the role re-read from D1:
 * EOIs are personal data. GET ?programme=&status=open|new|contacted|placed|declined|withdrawn|any&kind=player|team
 * &since=season|all&archived=active|archived|all&q=&before=<cursor>. POST { action: 'create', … } adds an EOI by
 * hand; { action: 'status' | 'archive' | 'unarchive', ids, status?, programmeId? } and { action: 'delete', ids,
 * keepPlayers? } act on several (at most 90).
 */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'admin', request, db, { fresh: true })
    return json(await listInterests(db, parseInterestFilter(url.searchParams), { before: url.searchParams.get('before') }))
  })

export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db, { fresh: true })
    const body = await readJson<Record<string, unknown>>(request, { maxBytes: INTEREST_BODY_LIMIT })
    if (body.action === 'create') return json(await addInterestByHand(db, actor, body), 201)
    if (body.action === 'delete') return json(await deleteInterests(db, actor, body.ids, { keepPlayers: body.keepPlayers === true }))
    if (body.action === 'status' || body.action === 'archive' || body.action === 'unarchive')
      return json(await bulkInterestAction(db, actor, body))
    throw new HttpError(400, 'invalid_input', 'Unknown action.')
  })
