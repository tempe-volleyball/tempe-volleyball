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

function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret)
  if (!key) {
    key = crypto.subtle
      .importKey('raw', new TextEncoder().encode(`${LABEL}:${secret}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .catch((e: unknown) => {
        keys.delete(secret)
        throw e
      })
    keys.set(secret, key)
  }
  return key
}

async function sign(secret: string, payload: string) {
  const sig = await crypto.subtle.sign('HMAC', await keyFor(secret), new TextEncoder().encode(payload))
  return b64url(new Uint8Array(sig))
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
  const expected = await sign(secret, parts.slice(0, 4).join('.'))
  // Constant-time compare.
  if (expected.length !== sig.length) return null
  let diff = 0
  for (let i = 0; i < sig.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i)
  if (diff !== 0) return null
  const ms = parseInt(at, 36)
  if (!Number.isFinite(ms)) return null
  return { type: t === 'g' ? 'group' : 'registration', id, offeredAt: new Date(ms).toISOString() }
}

export const offerUrl = (siteUrl: string, token: string) => `${siteUrl.replace(/\/$/, '')}/enrol/offer#${token}`
