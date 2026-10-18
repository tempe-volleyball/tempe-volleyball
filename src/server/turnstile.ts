// Cloudflare Turnstile for public forms (the enrolment form). The browser renders the widget with the site key and
// sends the token it gets; the server checks the token with siteverify before doing anything else.
//
// Keys: TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY (secrets, `wrangler secret put … --env <env>`). Development and
// staging fall back to Cloudflare's always-pass test keys, so forms work without setup there. Production has no
// fallback: without real keys the public form shows "enrolment is unavailable" and the API refuses (fail closed).
// Production also refuses the test keys if someone sets them by mistake (they'd let any bot through).
//
// With real keys, the siteverify answer's hostname must be the host the form posted to (the page's own), so a token
// solved on another site that embeds our key isn't accepted, and its `action` must be the form's (TURNSTILE_ACTIONS),
// so a token solved on some other widget with our key can't be spent on this form.

/** The action each widget is rendered with (the browser passes it to turnstile.render; siteverify echoes it). */
export const TURNSTILE_ACTIONS = { enrol: 'enrol' } as const

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Cloudflare's test keys that always pass (https://developers.cloudflare.com/turnstile/troubleshooting/testing/). */
export const TURNSTILE_TEST_KEYS = { siteKey: '1x00000000000000000000AA', secretKey: '1x0000000000000000000000000000000AA' } as const

export type TurnstileEnv = { SITE_ENV: string; TURNSTILE_SITE_KEY?: string | undefined; TURNSTILE_SECRET_KEY?: string | undefined }

export type TurnstileKeys = { siteKey: string; secretKey: string; test: boolean }

/** Cloudflare's published test secrets (always pass, always fail, token already spent). */
const TEST_SECRET = /^[123]x0000000000000000000000000000000AA$/
const TEST_SITE_KEY = /^[123]x00000000000000000000(AA|BB)$/

/** The keys to use, or null in production when they aren't set (or are Cloudflare's test keys). */
export function turnstileKeys(env: TurnstileEnv): TurnstileKeys | null {
  if (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY) {
    const test = TEST_SECRET.test(env.TURNSTILE_SECRET_KEY) || TEST_SITE_KEY.test(env.TURNSTILE_SITE_KEY)
    if (test && env.SITE_ENV === 'production') {
      console.warn('[turnstile] test keys refused in production; set the real TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY')
      return null
    }
    return { siteKey: env.TURNSTILE_SITE_KEY, secretKey: env.TURNSTILE_SECRET_KEY, test }
  }
  if (env.SITE_ENV === 'development' || env.SITE_ENV === 'staging') return { ...TURNSTILE_TEST_KEYS, test: true }
  return null
}

export type TurnstileResult = { ok: true } | { ok: false; reason: string }

/**
 * Checks a widget token with Cloudflare. Network failures fail closed. With `hostname`, the token must have been
 * solved on that host, and with `action` on a widget rendered with that action (pass null for both with the test
 * keys, whose answers say example.com and carry no action).
 */
export async function verifyTurnstile(
  secretKey: string,
  token: unknown,
  ip: string | null,
  doFetch: typeof fetch = fetch,
  opts: { hostname?: string | null; action?: string | null } = {},
): Promise<TurnstileResult> {
  if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false, reason: 'missing-input-response' }
  const body = new FormData()
  body.append('secret', secretKey)
  body.append('response', token)
  if (ip) body.append('remoteip', ip)
  try {
    const res = await doFetch(TURNSTILE_VERIFY_URL, { method: 'POST', body })
    const data = (await res.json().catch(() => ({}))) as { success?: boolean; hostname?: string; action?: string; 'error-codes'?: string[] }
    if (data.success === true) {
      if (opts.hostname && data.hostname?.toLowerCase() !== opts.hostname.toLowerCase())
        return { ok: false, reason: `hostname ${data.hostname ?? 'missing'}` }
      if (opts.action && data.action !== opts.action) return { ok: false, reason: `action ${data.action ?? 'missing'}` }
      return { ok: true }
    }
    return { ok: false, reason: data['error-codes']?.join(',') || `status ${res.status}` }
  } catch (e) {
    return { ok: false, reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}
