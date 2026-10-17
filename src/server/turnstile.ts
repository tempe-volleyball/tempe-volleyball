// Cloudflare Turnstile for public forms (the enrolment form). The browser renders the widget with the site key and
// sends the token it gets; the server checks the token with siteverify before doing anything else.
//
// Keys: TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY (secrets, `wrangler secret put … --env <env>`). Development and
// staging fall back to Cloudflare's always-pass test keys, so forms work without setup there. Production has no
// fallback: without real keys the public form shows "enrolment is unavailable" and the API refuses (fail closed).

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Cloudflare's test keys that always pass (https://developers.cloudflare.com/turnstile/troubleshooting/testing/). */
export const TURNSTILE_TEST_KEYS = { siteKey: '1x00000000000000000000AA', secretKey: '1x0000000000000000000000000000000AA' } as const

export type TurnstileEnv = { SITE_ENV: string; TURNSTILE_SITE_KEY?: string | undefined; TURNSTILE_SECRET_KEY?: string | undefined }

export type TurnstileKeys = { siteKey: string; secretKey: string; test: boolean }

/** The keys to use, or null in production when they aren't set. */
export function turnstileKeys(env: TurnstileEnv): TurnstileKeys | null {
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY)
    return {
      siteKey: env.TURNSTILE_SITE_KEY,
      secretKey: env.TURNSTILE_SECRET_KEY,
      test: env.TURNSTILE_SECRET_KEY === TURNSTILE_TEST_KEYS.secretKey,
    }
  if (env.SITE_ENV === 'development' || env.SITE_ENV === 'staging') return { ...TURNSTILE_TEST_KEYS, test: true }
  return null
}

export type TurnstileResult = { ok: true } | { ok: false; reason: string }

/** Checks a widget token with Cloudflare. Network failures fail closed. */
export async function verifyTurnstile(
  secretKey: string,
  token: unknown,
  ip: string | null,
  doFetch: typeof fetch = fetch,
): Promise<TurnstileResult> {
  if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false, reason: 'missing-input-response' }
  const body = new FormData()
  body.append('secret', secretKey)
  body.append('response', token)
  if (ip) body.append('remoteip', ip)
  try {
    const res = await doFetch(TURNSTILE_VERIFY_URL, { method: 'POST', body })
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; 'error-codes'?: string[] }
    if (data.success === true) return { ok: true }
    return { ok: false, reason: data['error-codes']?.join(',') || `status ${res.status}` }
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
