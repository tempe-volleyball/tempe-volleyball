// Google service-account auth for the Data and Search Console APIs: a JWT signed with WebCrypto (RS256),
// exchanged for an access token. https://developers.google.com/identity/protocols/oauth2/service-account
// The secret GOOGLE_SERVICE_ACCOUNT_JSON is the key file downloaded from Google Cloud (JSON, as is).

export type ServiceAccount = { client_email: string; private_key: string; token_uri?: string }

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export class AnalyticsConfigError extends Error {}

/** Reads the key file; throws AnalyticsConfigError with a readable message when it isn't one. */
export function parseServiceAccount(json: string | undefined): ServiceAccount {
  if (!json?.trim()) throw new AnalyticsConfigError('GOOGLE_SERVICE_ACCOUNT_JSON is not set.')
  let o: unknown
  try {
    o = JSON.parse(json)
  } catch {
    throw new AnalyticsConfigError('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (paste the whole key file).')
  }
  const sa = o as Partial<ServiceAccount>
  if (typeof sa.client_email !== 'string' || typeof sa.private_key !== 'string' || !sa.private_key.includes('PRIVATE KEY'))
    throw new AnalyticsConfigError('GOOGLE_SERVICE_ACCOUNT_JSON needs client_email and private_key (a service-account key file).')
  return { client_email: sa.client_email, private_key: sa.private_key, ...(sa.token_uri ? { token_uri: sa.token_uri } : {}) }
}

const b64url = (bytes: Uint8Array) => {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)))

const pemToDer = (pem: string) => {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '')
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** The signed JWT assertion (valid for an hour). */
export async function signJwt(sa: ServiceAccount, scopes: string[], now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claims = { iss: sa.client_email, scope: scopes.join(' '), aud: sa.token_uri ?? GOOGLE_TOKEN_URL, iat, exp: iat + 3600 }
  const input = `${b64urlJson(header)}.${b64urlJson(claims)}`
  let key: CryptoKey
  try {
    key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  } catch {
    throw new AnalyticsConfigError('The private key in GOOGLE_SERVICE_ACCOUNT_JSON could not be read.')
  }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input))
  return `${input}.${b64url(new Uint8Array(sig))}`
}

/** An access token for `scopes`. */
export async function googleAccessToken(sa: ServiceAccount, scopes: string[], fetcher: typeof fetch, now: Date): Promise<string> {
  const assertion = await signJwt(sa, scopes, now)
  const res = await fetcher(sa.token_uri ?? GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  })
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string }
  if (!res.ok || !data.access_token)
    throw new Error(`Google sign-in failed (${res.status}): ${data.error_description ?? data.error ?? 'no access token'}`)
  return data.access_token
}
