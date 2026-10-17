import type { APIRoute } from 'astro'
import { submitPublicEnrolment } from '../../../server/enrolment/submit'
import { clientIp, handle, json, readJson } from '../../../server/http'
import { getServices, getTurnstileKeys, secrets } from '../../../server/services'

/**
 * The public enrolment form posts here (docs/api/enrolment.md): { target: { kind, id }, entryType, person, answers,
 * turnstileToken }. Rate-limited per IP and email, Turnstile-checked, never cached (json() sends no-store).
 */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const { db, mailer } = getServices()
    const result = await submitPublicEnrolment(
      { db, mailer, turnstileSecret: getTurnstileKeys()?.secretKey ?? null, ip: clientIp(request), hashSalt: secrets.BETTER_AUTH_SECRET },
      await readJson(request),
    )
    return json(result, 201)
  })
