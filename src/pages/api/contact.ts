import type { APIRoute } from 'astro'
import { CONTACT_BODY_LIMIT } from '../../lib/contact'
import { submitContact } from '../../server/contact/messages'
import { clientIp, handle, json, readJson } from '../../server/http'
import { getEnrolmentDeps, getTurnstileHostname, getTurnstileKeys } from '../../server/services'

/**
 * The contact form posts here (docs/api/contact.md): { name, email, topic, message, pagePath, website (honeypot),
 * turnstileToken }. Body capped at 16 KB (413), rate-limited per IP and mailbox, Turnstile-checked, stored before
 * any email goes, never cached (json() sends no-store).
 */
export const POST: APIRoute = ({ request }) =>
  handle(async () => {
    const { db, mailer, secret, siteUrl } = getEnrolmentDeps()
    const input = await readJson(request, { maxBytes: CONTACT_BODY_LIMIT })
    const result = await submitContact(
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
