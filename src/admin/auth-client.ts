import { createAuthClient } from 'better-auth/client'
import { emailOTPClient, magicLinkClient, twoFactorClient } from 'better-auth/client/plugins'

/** Better Auth's browser client for /api/auth (same origin). */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [emailOTPClient(), magicLinkClient(), twoFactorClient()],
})
