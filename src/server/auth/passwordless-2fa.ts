import type { BetterAuthPlugin } from 'better-auth'
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import { deleteSessionCookie } from 'better-auth/cookies'
import { generateRandomString } from 'better-auth/crypto'

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
// Trusted devices aren't supported: every sign-in asks for the code. If Better Auth starts matching these paths
// itself, delete this plugin (the tests in auth.flow.test.ts will show a double challenge otherwise).

/** Sign-in endpoints that create a session without a password. */
export const PASSWORDLESS_SIGN_IN_PATHS: readonly string[] = ['/sign-in/email-otp', '/magic-link/verify', '/email-otp/verify-email']

/** Where the magic link lands when a TOTP code is still needed. */
export const TOTP_SIGN_IN_PAGE = '/admin/sign-in?step=totp'

/** Matches twoFactor's defaults (constant.mjs): the cookie name and the 10-minute challenge window. */
const TWO_FACTOR_COOKIE_NAME = 'two_factor'
const CHALLENGE_SECONDS = 600

export const passwordlessTwoFactor = (opts: { totpPage: string }) =>
  ({
    id: 'passwordless-two-factor',
    hooks: {
      before: [
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
          matcher: (ctx) => PASSWORDLESS_SIGN_IN_PATHS.includes(ctx.path ?? ''),
          handler: createAuthMiddleware(async (ctx) => {
            const data = ctx.context.newSession
            if (!data || !(data.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled) return
            const totp = await ctx.context.adapter.findOne<{ verified: boolean | null }>({
              model: 'twoFactor',
              where: [{ field: 'userId', value: data.user.id }],
            })
            if (!totp || totp.verified === false) return

            deleteSessionCookie(ctx, true)
            await ctx.context.internalAdapter.deleteSession(data.session.token)
            ctx.context.setNewSession(null)

            const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME, { maxAge: CHALLENGE_SECONDS })
            const identifier = `2fa-${generateRandomString(20)}`
            const expiresAt = new Date(Date.now() + CHALLENGE_SECONDS * 1000)
            await ctx.context.internalAdapter.createVerificationValue({ value: data.user.id, identifier, expiresAt })
            await ctx.context.internalAdapter.createVerificationValue({ value: '0', identifier: `2fa-attempts-${identifier}`, expiresAt })
            await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes)

            if (ctx.path === '/magic-link/verify') throw ctx.redirect(opts.totpPage)
            return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'] })
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
