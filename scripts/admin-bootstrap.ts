// Create or promote an owner, for the first sign-in (nobody exists yet to send an invite).
//
//   npm run admin:bootstrap -- --email michael@example.com --env local|staging|production
//
// Runs `wrangler d1 execute` against that environment's D1 (remote for staging/production, so you need wrangler
// logged in to the Cloudflare account). Safe to re-run. The owner then signs in at /admin with an email code and
// is asked to set up TOTP before anything else.
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { bootstrapEnvs, bootstrapOwnerSql, wranglerArgs, type BootstrapEnv } from '../src/server/auth/bootstrap.ts'

const { values } = parseArgs({
  options: { email: { type: 'string' }, env: { type: 'string', default: 'local' }, name: { type: 'string' } },
})

const env = values.env as BootstrapEnv
if (!values.email || !(bootstrapEnvs as readonly string[]).includes(env)) {
  console.error('Usage: npm run admin:bootstrap -- --email <email> --env local|staging|production [--name "Full Name"]')
  process.exit(1)
}

const sql = bootstrapOwnerSql(values.email, { name: values.name })
console.info(`Making ${values.email.trim().toLowerCase()} an owner in ${env}…`)
execFileSync('npx', wranglerArgs(env, sql), { stdio: 'inherit' })
console.info('Done. Sign in at /admin with an email code; you will be asked to set up TOTP first.')
