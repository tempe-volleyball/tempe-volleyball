// Signed links in enrolment emails. Both kinds are HMAC-SHA-256 over what they name, sent in the URL fragment (so
// they stay out of server logs and analytics) and posted to the API by the page's island. Nothing secret is stored.
//
// Waitlist offer links (/enrol/offer#<token>). A token names one offer (a registration or a team entry, plus the
// moment it was offered) and is signed with HMAC-SHA-256, so nothing secret is stored and a token stops working as
// soon as the offer is accepted, declined, re-offered or lapses (the server checks offered_at and the status).
//
// The key is derived from BETTER_AUTH_SECRET with its own label, so offer tokens can't be confused with anything
// Better Auth signs.

export type OfferSubject = { type: 'registration' | 'group'; id: string; offeredAt: string }

const VERSION = 'o1'
const LABEL = 'tempevb:enrolment-offer:v1'

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

const keys = new Map<string, Promise<CryptoKey>>()

function keyFor(secret: string, label = LABEL): Promise<CryptoKey> {
  const cacheKey = `${label}:${secret}`
  let key = keys.get(cacheKey)
  if (!key) {
    key = crypto.subtle
      .importKey('raw', new TextEncoder().encode(cacheKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .catch((e: unknown) => {
        keys.delete(cacheKey)
        throw e
      })
    keys.set(cacheKey, key)
  }
  return key
}

async function sign(secret: string, payload: string, label = LABEL) {
  const sig = await crypto.subtle.sign('HMAC', await keyFor(secret, label), new TextEncoder().encode(payload))
  return b64url(new Uint8Array(sig))
}

/** Constant-time string compare. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const payloadOf = (s: OfferSubject) => `${VERSION}.${s.type === 'group' ? 'g' : 'r'}.${s.id}.${Date.parse(s.offeredAt).toString(36)}`

export async function offerToken(secret: string, subject: OfferSubject): Promise<string> {
  const payload = payloadOf(subject)
  return `${payload}.${await sign(secret, payload)}`
}

/** The offer a token names, if its signature is good. The caller still checks the offer is live. */
export async function readOfferToken(secret: string, token: unknown): Promise<OfferSubject | null> {
  if (typeof token !== 'string' || token.length > 300) return null
  const parts = token.split('.')
  if (parts.length !== 5 || parts[0] !== VERSION) return null
  const [, t, id, at, sig] = parts as [string, string, string, string, string]
  if ((t !== 'r' && t !== 'g') || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/^[0-9a-z]{1,12}$/.test(at)) return null
  if (!same(await sign(secret, parts.slice(0, 4).join('.')), sig)) return null
  const ms = parseInt(at, 36)
  if (!Number.isFinite(ms)) return null
  return { type: t === 'g' ? 'group' : 'registration', id, offeredAt: new Date(ms).toISOString() }
}

export const offerUrl = (siteUrl: string, token: string) => `${siteUrl.replace(/\/$/, '')}/enrol/offer#${token}`

// Email confirmation links (/enrol/confirm#<token>, docs/admin.md §3.7). A token names one registration and the
// moment it was created, with its own key label. It only acts while the registration is still pending_email and
// inside its deadline, so it's single-use: once clicked (or expired, or confirmed by an admin) it does nothing.

export type ConfirmSubject = { id: string; createdAt: string }

const CONFIRM_VERSION = 'c1'
const CONFIRM_LABEL = 'tempevb:enrolment-confirm:v1'

const confirmPayload = (s: ConfirmSubject) => `${CONFIRM_VERSION}.${s.id}.${Date.parse(s.createdAt).toString(36)}`

export async function confirmToken(secret: string, subject: ConfirmSubject): Promise<string> {
  const payload = confirmPayload(subject)
  return `${payload}.${await sign(secret, payload, CONFIRM_LABEL)}`
}

/** The registration a confirm token names, if its signature is good. The caller checks it's still pending. */
export async function readConfirmToken(secret: string, token: unknown): Promise<ConfirmSubject | null> {
  if (typeof token !== 'string' || token.length > 300) return null
  const parts = token.split('.')
  if (parts.length !== 4 || parts[0] !== CONFIRM_VERSION) return null
  const [, id, at, sig] = parts as [string, string, string, string]
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !/^[0-9a-z]{1,12}$/.test(at)) return null
  if (!same(await sign(secret, parts.slice(0, 3).join('.'), CONFIRM_LABEL), sig)) return null
  const ms = parseInt(at, 36)
  if (!Number.isFinite(ms)) return null
  return { id, createdAt: new Date(ms).toISOString() }
}

export const confirmUrl = (siteUrl: string, token: string) => `${siteUrl.replace(/\/$/, '')}/enrol/confirm#${token}`
