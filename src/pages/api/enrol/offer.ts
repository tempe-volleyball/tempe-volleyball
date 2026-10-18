import type { APIRoute } from 'astro'
import { respondToOffer, viewOffer } from '../../../server/enrolment/offers'
import { PUBLIC_BODY_LIMIT, handle, json, readJson } from '../../../server/http'
import { getEnrolmentDeps } from '../../../server/services'

/**
 * A waitlist offer link (/enrol/offer#<token>): { token, action: 'view' | 'accept' | 'decline' }. POST so the token
 * stays out of URLs and logs.
 */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const { token, action } = await readJson<{ token: string; action: string }>(request, { maxBytes: PUBLIC_BODY_LIMIT })
    const deps = getEnrolmentDeps()
    if (action === 'view' || action === undefined) return json(await viewOffer(deps.db, deps.secret, token))
    return json(await respondToOffer(deps, token, action))
  })
