import { env } from 'cloudflare:workers'
import { createAuth, createAuthSenders, type Auth } from './auth/auth'
import { getDb, type Db } from './db'
import { createMailer, type Mailer } from './email'

// The Worker's shared services, built once per isolate on first use (building Better Auth costs ~1 ms of CPU, so
// it isn't redone per request). Bindings and secrets come from `cloudflare:workers`, so only routes and
// middleware import this; code in src/server takes db/mailer/auth as arguments so tests can pass their own.

/** Secrets set with `wrangler secret put` (or .dev.vars locally). Typed here because `wrangler types` only sees the ones in your local .dev.vars. */
export type Secrets = { BETTER_AUTH_SECRET?: string; RESEND_API_KEY?: string }

export const secrets = env as unknown as Secrets

export type Services = { db: Db; mailer: Mailer; auth: Auth }

let services: Services | undefined

/** The R2 bucket for the media library (media/<id>/…). */
export const getMediaBucket = (): R2Bucket => env.MEDIA

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
