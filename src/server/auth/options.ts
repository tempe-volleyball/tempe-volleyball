import type { BetterAuthOptions } from 'better-auth'
import { emailOTP, magicLink, twoFactor } from 'better-auth/plugins'
import { userRoles } from '../db/schema/enums'

// The parts of the Better Auth config that shape the database schema. The runtime config (secret, base URL,
// database, email senders, cookie cache …) is built on top of this by the auth module, and the CLI config in
// auth.cli.ts uses it to generate the Drizzle tables. If you change the plugins or user fields here, regenerate
// (see auth.cli.ts), update src/server/db/schema/auth.ts to match and run `npm run db:generate`.

export { userRoles, type UserRole } from '../db/schema/enums'

export type AuthSenders = {
  sendVerificationOTP: (data: { email: string; otp: string; type: string }) => Promise<void>
  sendMagicLink: (data: { email: string; url: string; token: string }) => Promise<void>
}

export const TOTP_ISSUER = 'Tempe Volleyball'

/** Plugins whose tables and fields live in our schema. */
export const authPlugins = (senders: AuthSenders) => [
  emailOTP({ sendVerificationOTP: senders.sendVerificationOTP }),
  magicLink({ sendMagicLink: senders.sendMagicLink }),
  twoFactor({ issuer: TOTP_ISSUER }),
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
