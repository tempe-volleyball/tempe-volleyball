import type { APIRoute } from 'astro'
import { acceptInvite } from '../../../server/auth/roles'
import { HttpError, INVITE_BODY_LIMIT, clientIp, handle, json, readJson } from '../../../server/http'
import { getServices } from '../../../server/services'

/** Accept an invite: { token, name }. Creates the user; the app then signs them in with an email code. */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const { token, name } = await readJson<{ token: string; name: string }>(request, { maxBytes: INVITE_BODY_LIMIT })
    if (typeof token !== 'string') throw new HttpError(400, 'invalid_input', 'Missing token.')
    const user = await acceptInvite(getServices().db, { token, name: typeof name === 'string' ? name : undefined, ip: clientIp(request) })
    return json({ email: user.email, role: user.role }, 201)
  })
