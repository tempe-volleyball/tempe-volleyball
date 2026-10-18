import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { deleteSessionCookie, expireCookie } from 'better-auth/cookies'
import { constantTimeEqual, generateRandomString } from 'better-auth/crypto'
import { createHMAC } from '@better-auth/utils/hmac'

// TOTP as a second factor for passwordless sign-in.
//
// Better Auth's twoFactor plugin (1.7.10) only challenges for 2FA after *password* sign-ins: its after-hook matches
// /sign-in/email, /sign-in/username and /sign-in/phone-number. Email-OTP and magic-link sign-ins would create a
// full session even for a user with TOTP enrolled. This plugin adds the same after-hook for the passwordless
// sign-in paths. It mirrors twoFactor's hook step for step (same cookie name, same verification records), so
// twoFactor's own /two-factor/verify-totp and /two-factor/verify-backup-code endpoints finish the sign-in:
//
//   1. drop the session the sign-in just created (and its cookie),
//   2. store a short-lived "2fa-<id>" verification record for the user plus an attempts counter,
//   3. set the signed `two_factor` cookie pointing at it,
//   4. answer { twoFactorRedirect: true } (or, for the magic link, which is a browser GET, redirect to the TOTP page).
//
// Trusted devices: before step 1, a valid `trust_device` cookie (set by twoFactor's verify endpoints when the
// sign-in page sends `trustDevice: true`) skips the challenge, checked exactly as twoFactor's own hook checks it
// (HMAC of `<user id>!<identifier>`, a live verification row for the same user), plus our trust period: the row
// must be younger than Settings → Security's days (0 = off), so the code is asked again N days after it was
// entered. Unlike twoFactor's hook we don't rotate the row on use, which is what keeps the period fixed. See
// trusted-devices.ts for revoking.
//
// If Better Auth starts matching these paths itself, delete this plugin (the tests in auth.flow.test.ts will show
// a double challenge otherwise).

/** Sign-in endpoints that create a session without a password. */
export const PASSWORDLESS_SIGN_IN_PATHS: readonly string[] = ['/sign-in/email-otp', '/magic-link/verify', '/email-otp/verify-email']

/** Where the magic link lands when a TOTP code is still needed. */
export const TOTP_SIGN_IN_PAGE = '/admin/sign-in?step=totp'

/** Matches twoFactor's defaults (constant.mjs): the cookie names and the 10-minute challenge window. */
const TWO_FACTOR_COOKIE_NAME = 'two_factor'
const TRUST_DEVICE_COOKIE_NAME = 'trust_device'
const CHALLENGE_SECONDS = 600
const DAY_MS = 24 * 60 * 60 * 1000

/** twoFactor's endpoints that finish a challenged sign-in (and take `trustDevice`). */
const VERIFY_PATHS: readonly string[] = ['/two-factor/verify-totp', '/two-factor/verify-backup-code']
/** Setting TOTP up again, or turning it off, forgets the user's trusted devices. */
const RESET_PATHS: readonly string[] = ['/two-factor/enable', '/two-factor/disable']

/** The database side of trusted devices (trusted-devices.ts), passed in so this plugin stays storage-free. */
export type TrustedDeviceHooks = {
  /** Days a trusted device skips the code (Settings → Security); 0 turns trusted devices off. */
  trustDays: () => Promise<number>
  /** Forgets every trusted device of the user, audited when there were any. */
  revokeAll: (userId: string, reason: string, ip: string | null) => Promise<void>
  /** Audits a newly trusted device. */
  onTrusted: (userId: string, days: number, ip: string | null) => Promise<void>
}

type HookCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]

const requestIp = (ctx: HookCtx) => ctx.request?.headers.get('cf-connecting-ip') ?? null

const succeeded = (ctx: HookCtx) => {
  const r = ctx.context.returned
  return r !== undefined && !(r instanceof Error) && !(r instanceof Response && !r.ok)
}

/** Is this browser a trusted device for `userId`, under a trust period of `days`? Clears a stale cookie. */
async function trustedDevice(ctx: HookCtx, userId: string, days: number, maxAgeSeconds: number): Promise<boolean> {
  const cookie = ctx.context.createAuthCookie(TRUST_DEVICE_COOKIE_NAME, { maxAge: maxAgeSeconds })
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret)
  if (!value) return false
  const [token, identifier] = value.split('!')
  if (days > 0 && token && identifier) {
    const expected = await createHMAC('SHA-256', 'base64urlnopad').sign(ctx.context.secret, `${userId}!${identifier}`)
    if (constantTimeEqual(token, expected)) {
      const record = await ctx.context.internalAdapter.findVerificationValue(identifier)
      const now = Date.now()
      if (record && record.value === userId) {
        if (record.expiresAt.getTime() > now && new Date(record.createdAt).getTime() + days * DAY_MS > now) return true
        await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier)
      }
    }
  }
  // Someone else's, expired, revoked or forged: drop it so the browser stops sending it.
  expireCookie(ctx, cookie)
  return false
}

export const passwordlessTwoFactor = (opts: { totpPage: string; trust?: TrustedDeviceHooks | undefined; trustMaxAgeSeconds: number }) =>
  ({
    id: 'passwordless-two-factor',
    hooks: {
      before: [
        {
          // With trusted devices off, ignore a stale sign-in page's "trust this device" tick.
          matcher: (ctx) => VERIFY_PATHS.includes(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as { trustDevice?: unknown } | undefined
            if (!body?.trustDevice) return
            if (opts.trust && (await opts.trust.trustDays()) > 0) return
            return { context: { body: { ...body, trustDevice: false } } }
          }),
        },
        {
          // TOTP is required for owners (PLAN.md), so they can't turn it off. (They can still re-enrol: the
          // middleware sends an owner without TOTP straight to enrolment.)
          matcher: (ctx) => ctx.path === '/two-factor/disable',
          handler: createAuthMiddleware(async (ctx) => {
            const current = await getSessionFromCtx(ctx)
            if ((current?.user as { role?: string } | undefined)?.role === 'owner') {
              throw new APIError('FORBIDDEN', { message: "Owners can't turn off two-factor sign-in.", code: 'OWNER_TOTP_REQUIRED' })
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => VERIFY_PATHS.includes(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as { trustDevice?: unknown } | undefined
            const userId = ctx.context.newSession?.user.id
            if (!opts.trust || !body?.trustDevice || !userId || !succeeded(ctx)) return
            await opts.trust.onTrusted(userId, await opts.trust.trustDays(), requestIp(ctx))
          }),
        },
        {
          matcher: (ctx) => RESET_PATHS.includes(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const userId = ctx.context.session?.user.id
            if (!opts.trust || !userId || !succeeded(ctx)) return
            await opts.trust.revokeAll(userId, ctx.path === '/two-factor/disable' ? 'totp.disable' : 'totp.enable', requestIp(ctx))
          }),
        },
        {
          matcher: (ctx) => PASSWORDLESS_SIGN_IN_PATHS.includes(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const data = ctx.context.newSession
            if (!data || !(data.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled) return
            const totp = await ctx.context.adapter.findOne<{ verified: boolean | null }>({
              model: 'twoFactor',
              where: [{ field: 'userId', value: data.user.id }],
            })
            if (!totp || totp.verified === false) return

            const days = opts.trust ? await opts.trust.trustDays() : 0
            if (await trustedDevice(ctx, data.user.id, days, opts.trustMaxAgeSeconds)) return

            deleteSessionCookie(ctx, true)
            await ctx.context.internalAdapter.deleteSession(data.session.token)
            ctx.context.setNewSession(null)

            const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME, { maxAge: CHALLENGE_SECONDS })
            const identifier = `2fa-${generateRandomString(20)}`
            const expiresAt = new Date(Date.now() + CHALLENGE_SECONDS * 1000)
            await ctx.context.internalAdapter.createVerificationValue({ value: data.user.id, identifier, expiresAt })
            await ctx.context.internalAdapter.createVerificationValue({ value: '0', identifier: `2fa-attempts-${identifier}`, expiresAt })
            await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes)

            // The sign-in page offers "Trust this device for N days" when N > 0.
            if (ctx.path === '/magic-link/verify') throw ctx.redirect(`${opts.totpPage}&trust=${days}`)
            return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'], trustDeviceDays: days })
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
