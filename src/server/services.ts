import { env } from 'cloudflare:workers'
import { createAuth, createAuthSenders, type Auth } from './auth/auth'
import { getDb, type Db } from './db'
import { createMailer, type Mailer } from './email'
import { turnstileKeys } from './turnstile'

// The Worker's shared services, built once per isolate on first use (building Better Auth costs ~1 ms of CPU, so
// it isn't redone per request). Bindings and secrets come from `cloudflare:workers`, so only routes and
// middleware import this; code in src/server takes db/mailer/auth as arguments so tests can pass their own.

/** Secrets set with `wrangler secret put` (or .dev.vars locally). Typed here because `wrangler types` only sees the ones in your local .dev.vars. */
export type Secrets = {
  BETTER_AUTH_SECRET?: string
  RESEND_API_KEY?: string
  /** Analytics (docs/admin.md §2): the Google service-account key file (JSON) and a Cloudflare Analytics: Read token. */
  GOOGLE_SERVICE_ACCOUNT_JSON?: string
  CF_ANALYTICS_TOKEN?: string
  /** Turnstile for public forms; development and staging fall back to the test keys (src/server/turnstile.ts). */
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET_KEY?: string
}

/** The analytics secrets, for src/server/analytics. */
export const analyticsSecrets = () => ({
  GOOGLE_SERVICE_ACCOUNT_JSON: secrets.GOOGLE_SERVICE_ACCOUNT_JSON,
  CF_ANALYTICS_TOKEN: secrets.CF_ANALYTICS_TOKEN,
})

export const secrets = env as unknown as Secrets

export type Services = { db: Db; mailer: Mailer; auth: Auth }

let services: Services | undefined

/** The R2 bucket for the media library (media/<id>/…). */
export const getMediaBucket = (): R2Bucket => env.MEDIA

/** Turnstile keys for this environment, or null in production without them (public forms then refuse). */
export const getTurnstileKeys = () =>
  turnstileKeys({
    SITE_ENV: env.SITE_ENV,
    TURNSTILE_SITE_KEY: secrets.TURNSTILE_SITE_KEY,
    TURNSTILE_SECRET_KEY: secrets.TURNSTILE_SECRET_KEY,
  })

/**
 * What the enrolment code needs (src/server/enrolment): the db, the mailer, the key that signs waitlist offer links
 * (derived from BETTER_AUTH_SECRET) and the site URL for those links.
 */
export const getEnrolmentDeps = () => {
  const { db, mailer } = getServices()
  if (!secrets.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is not set')
  return { db, mailer, secret: secrets.BETTER_AUTH_SECRET, siteUrl: env.SITE_URL }
}

export const getServices = (): Services => {
  if (services) return services
  const db = getDb(env.DB)
  const mailer = createMailer({ db, env: { SITE_ENV: env.SITE_ENV, RESEND_API_KEY: secrets.RESEND_API_KEY } })
  const auth = createAuth({
    db,
    env: { SITE_ENV: env.SITE_ENV, SITE_URL: env.SITE_URL, BETTER_AUTH_SECRET: secrets.BETTER_AUTH_SECRET },
    senders: createAuthSenders(db, mailer),
  })
  services = { db, mailer, auth }
  return services
}
