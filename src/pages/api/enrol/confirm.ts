import type { APIRoute } from 'astro'
import { confirmEmail, viewConfirmation } from '../../../server/enrolment/confirm'
import { PUBLIC_BODY_LIMIT, handle, json, readJson } from '../../../server/http'
import { getEnrolmentDeps } from '../../../server/services'

/**
 * An email confirmation link (/enrol/confirm#<token>): { token, action: 'view' | 'confirm' }. POST so the token stays
 * out of URLs and logs. Confirming settles the entry against the caps (docs/api/enrolment.md).
 */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const { token, action } = await readJson<{ token: string; action: string }>(request, { maxBytes: PUBLIC_BODY_LIMIT })
    const deps = getEnrolmentDeps()
    if (action === 'confirm') return json(await confirmEmail(deps, token))
    return json(await viewConfirmation(deps, token))
  })
