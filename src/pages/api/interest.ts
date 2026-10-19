import type { APIRoute } from 'astro'
import { INTEREST_BODY_LIMIT } from '../../lib/interest'
import { submitInterest } from '../../server/interest/public'
import { clientIp, handle, json, readJson } from '../../server/http'
import { getEnrolmentDeps, getTurnstileHostname, getTurnstileKeys } from '../../server/services'

/**
 * The expression-of-interest form posts here (docs/api/interest.md): { kind, programmeIds, person, answers, teamName,
 * members, website (honeypot), turnstileToken }. Body capped at 64 KB (413), rate-limited per IP and mailbox,
 * Turnstile-checked, stored before any email goes, never cached (json() sends no-store).
 */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const { db, mailer, secret, siteUrl } = getEnrolmentDeps()
    const input = await readJson(request, { maxBytes: INTEREST_BODY_LIMIT })
    const result = await submitInterest(
      {
        db,
        mailer,
        secret,
        siteUrl,
        turnstileSecret: getTurnstileKeys()?.secretKey ?? null,
        turnstileHostname: getTurnstileHostname(request),
        ip: clientIp(request),
      },
      input,
    )
    return json(result, 201)
  })
