import type { APIRoute } from 'astro'
import { lookupInvite } from '../../../server/auth/roles'
import { HttpError, INVITE_BODY_LIMIT, handle, json, readJson } from '../../../server/http'
import { getServices } from '../../../server/services'

/** What an invite is for, before accepting: { token }. POST so the token stays out of URLs and logs. */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const { token } = await readJson<{ token: string }>(request, { maxBytes: INVITE_BODY_LIMIT })
    if (typeof token !== 'string') throw new HttpError(400, 'invalid_input', 'Missing token.')
    return json(await lookupInvite(getServices().db, token))
  })
