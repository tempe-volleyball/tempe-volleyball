import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import * as authSchema from '../db/schema/auth'
import { authSchemaOptions } from './options'

// Config for the Better Auth CLI only (schema generation). Never import this from app code.
//   npx auth generate --config src/server/auth/auth.cli.ts --output auth-schema.gen.ts --yes
// Diff the output against src/server/db/schema/auth.ts, bring changes across, delete the output, then run
// `npm run db:generate -- --name <what>`. Run with the schema passed (as below), the CLI also reports a mismatch.
const noop = async () => {}

export const auth = betterAuth({
  ...authSchemaOptions({ sendVerificationOTP: noop, sendMagicLink: noop }),
  // The adapter only needs the provider and schema to generate; it never connects.
  database: drizzleAdapter({}, { provider: 'sqlite', schema: authSchema }),
})
