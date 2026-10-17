import type { BetterAuthOptions } from 'better-auth'
import { emailOTP, magicLink, twoFactor } from 'better-auth/plugins'
import { userRoles } from '../db/schema/enums'
import { TOTP_SIGN_IN_PAGE, passwordlessTwoFactor } from './passwordless-2fa'

// The parts of the Better Auth config that shape the database schema. The runtime config (secret, base URL,
// database, email senders, cookie cache …) is built on top of this by auth.ts, and the CLI config in
// auth.cli.ts uses it to generate the Drizzle tables. If you change the plugins or user fields here, regenerate
// (see auth.cli.ts), update src/server/db/schema/auth.ts to match and run `npm run db:generate`.

export { userRoles, type UserRole } from '../db/schema/enums'

export type AuthSenders = {
  sendVerificationOTP: (data: { email: string; otp: string; type: string }) => Promise<void>
  sendMagicLink: (data: { email: string; url: string; token: string }) => Promise<void>
}

export const TOTP_ISSUER = 'Tempe Volleyball'

/** How long sign-in codes and links last. */
export const SIGN_IN_TTL_SECONDS = 300

/**
 * Plugins whose tables and fields live in our schema, plus their runtime options (which don't change the schema).
 * Sign-up is disabled: users only come from invites (roles.ts) or the bootstrap script, so a code or link is only
 * ever sent to an existing admin. Codes and link tokens are stored hashed.
 */
export const authPlugins = (senders: AuthSenders) => [
  emailOTP({
    sendVerificationOTP: senders.sendVerificationOTP,
    disableSignUp: true,
    otpLength: 6,
    expiresIn: SIGN_IN_TTL_SECONDS,
    allowedAttempts: 5,
    storeOTP: 'hashed',
  }),
  magicLink({ sendMagicLink: senders.sendMagicLink, disableSignUp: true, expiresIn: SIGN_IN_TTL_SECONDS, storeToken: 'hashed' }),
  // allowPasswordless: our users have no password (no credential account), so Better Auth would otherwise demand
  // one to enable TOTP. With it, a signed-in session is enough. The sign-in challenge for passwordless sign-ins
  // comes from passwordless-2fa.ts, because twoFactor's own hook only covers password sign-ins.
  twoFactor({ issuer: TOTP_ISSUER, allowPasswordless: true }),
  passwordlessTwoFactor({ totpPage: TOTP_SIGN_IN_PAGE }),
]

export const authUserOptions = {
  additionalFields: {
    // Users can't set their own role; roles change only through invites and src/server/auth/roles.ts.
    role: { type: [...userRoles], required: true, defaultValue: 'editor', input: false },
  },
} satisfies BetterAuthOptions['user']

export const authSchemaOptions = (senders: AuthSenders) =>
  ({
    appName: 'Tempe Volleyball',
    user: authUserOptions,
    plugins: authPlugins(senders),
  }) satisfies Partial<BetterAuthOptions>
