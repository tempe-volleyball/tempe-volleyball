import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { eq } from 'drizzle-orm'
import type { AppDb } from '../db'
import * as authSchema from '../db/schema/auth'
import { EmailNotConfiguredError, type Mailer } from '../email'
import { authSchemaOptions, type AuthSenders } from './options'

// The runtime Better Auth instance, built on the schema-shaping options in options.ts. Pure (no cloudflare:*
// imports) so tests can build one over the in-memory database; the Worker's instance is in instance.ts.
//
// CPU: nothing here hashes passwords. Sign-in costs a few HMAC/SHA-256 operations and D1 round trips. Session
// checks use the signed cookie cache (5 minutes), so most admin requests verify one HMAC and don't touch D1.

export type AuthEnv = {
  SITE_ENV: string
  SITE_URL: string
  BETTER_AUTH_SECRET?: string | undefined
}

/** How long a session cookie cache entry is trusted before the session is re-read from D1. */
export const COOKIE_CACHE_SECONDS = 5 * 60
const DAY = 24 * 60 * 60

/** Development falls back to a fixed secret so `npm run dev` works without .dev.vars; nowhere else does. */
const DEV_SECRET = 'development-only-secret-do-not-use-anywhere-else'

export const authSecret = (env: AuthEnv) => {
  if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET !== 'change-me') return env.BETTER_AUTH_SECRET
  if (env.SITE_ENV === 'development') return DEV_SECRET
  throw new Error('BETTER_AUTH_SECRET is not set')
}

/**
 * Email senders for the emailOTP and magicLink plugins, through the outbox (sendEmail). They never fail the
 * request: a known address whose email couldn't be sent (email not set up, daily limit, per-recipient limit,
 * provider error) answers exactly like an unknown address, so the endpoints don't reveal who is an admin. The
 * failure is logged without the code or link.
 */
export function createAuthSenders(db: AppDb, mailer: Mailer): AuthSenders {
  const send = async (...args: Parameters<Mailer['sendEmail']>) => {
    const template = args[1]
    try {
      const res = await mailer.sendEmail(...args)
      if (res.status === 'failed' || res.status === 'queued' || res.status === 'limited')
        console.warn(`[auth] ${template} email not sent (${res.status})`)
    } catch (e) {
      const reason = e instanceof EmailNotConfiguredError ? 'email is not configured' : e instanceof Error ? e.name : 'error'
      console.warn(`[auth] ${template} email not sent: ${reason}`)
    }
  }
  return {
    sendVerificationOTP: async ({ email, otp, type }) => {
      // Only sign-in codes are used. emailOTP (with sign-up disabled) only calls this for existing users.
      if (type !== 'sign-in') return
      await send(email, 'auth.otp', { otp }, { immediateOnly: true })
    },
    sendMagicLink: async ({ email, url }) => {
      // magicLink sends even to unknown addresses (sign-up is checked when the link is used), so check here and
      // stay silent either way, which keeps the endpoint from revealing who is an admin.
      const known = await db
        .select({ id: authSchema.user.id })
        .from(authSchema.user)
        .where(eq(authSchema.user.email, email.trim().toLowerCase()))
        .get()
      if (!known) return
      await send(email, 'auth.magic_link', { url }, { immediateOnly: true })
    },
  }
}

export function createAuth(opts: { db: AppDb; env: AuthEnv; senders: AuthSenders }) {
  const { env } = opts
  return betterAuth({
    ...authSchemaOptions(opts.senders),
    secret: authSecret(env),
    baseURL: env.SITE_URL,
    basePath: '/api/auth',
    trustedOrigins: [env.SITE_URL],
    database: drizzleAdapter(opts.db, { provider: 'sqlite', schema: authSchema, transaction: false }),
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: 7 * DAY,
      updateAge: DAY,
      cookieCache: { enabled: true, maxAge: COOKIE_CACHE_SECONDS, strategy: 'compact' },
    },
    rateLimit: {
      // In-memory per isolate (a database store would cost a D1 write per request). Better Auth's plugin rules
      // (e.g. 3 per 10 s on /two-factor/*, 5 per minute on magic links) apply on top.
      enabled: env.SITE_ENV !== 'development',
      window: 60,
      max: 30,
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      useSecureCookies: env.SITE_URL.startsWith('https://'),
      database: { generateId: () => crypto.randomUUID() },
    },
    telemetry: { enabled: false },
  })
}

export type Auth = ReturnType<typeof createAuth>
export type AuthSession = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>
/** twoFactorEnabled is added by the twoFactor plugin; Better Auth's inference loses it through the plugin array. */
export type SessionUser = AuthSession['user'] & { twoFactorEnabled?: boolean | null }
