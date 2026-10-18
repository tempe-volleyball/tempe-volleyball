import type { APIRoute } from 'astro'
import { submitPublicEnrolment } from '../../../server/enrolment/submit'
import { PUBLIC_BODY_LIMIT, clientIp, handle, json, readJson } from '../../../server/http'
import { getEnrolmentDeps, getTurnstileHostname, getTurnstileKeys } from '../../../server/services'

/**
 * The public enrolment form posts here (docs/api/enrolment.md): { target: { kind, id }, entryType, person, answers,
 * turnstileToken }. Body capped at 64 KB (413), rate-limited per IP and email, Turnstile-checked, never cached
 * (json() sends no-store). getEnrolmentDeps() throws without BETTER_AUTH_SECRET, which salts the rate-limit keys.
 */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const { db, mailer, secret, siteUrl } = getEnrolmentDeps()
    const input = await readJson(request, { maxBytes: PUBLIC_BODY_LIMIT })
    const result = await submitPublicEnrolment(
      {
        db,
        mailer,
        turnstileSecret: getTurnstileKeys()?.secretKey ?? null,
        turnstileHostname: getTurnstileHostname(request),
        ip: clientIp(request),
        secret,
        siteUrl,
      },
      input,
    )
    return json(result, 201)
  })
