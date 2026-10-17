import { expireInvites } from './auth/roles'
import { getDb, type AppDb } from './db'
import { createMailer, type Mailer } from './email'

/**
 * Cron Trigger entry point (see `triggers.crons` in wrangler.jsonc; schedules are UTC). Hourly. Every job is
 * idempotent and batches its D1 writes:
 *  - expire admin invites past their expiry
 *  - send queued emails that went over Resend's daily limit
 *  - clear secret payloads (codes, sign-in and invite links) from outbox rows that can no longer be sent
 * Still to come: release unpaid registrations past their hold time (Phase 5).
 * The nightly D1 backup runs from GitHub Actions, not here (see .github/workflows/backup.yml).
 */
export async function runScheduled(cron: string, env: Env): Promise<void> {
  const db = getDb(env.DB)
  const secrets = env as unknown as { RESEND_API_KEY?: string }
  const mailer = createMailer({ db, env: { SITE_ENV: env.SITE_ENV, RESEND_API_KEY: secrets.RESEND_API_KEY } })
  const result = await runJobs(db, mailer)
  console.info(`[cron] ${cron} in ${env.SITE_ENV}: ${JSON.stringify(result)}`)
}

/** The jobs themselves, with bindings passed in so tests can run them. One failing job doesn't stop the others. */
export async function runJobs(db: AppDb, mailer: Pick<Mailer, 'drainOutbox' | 'scrubSensitivePayloads'>, now = new Date()) {
  const [invites, email, scrubbed] = await Promise.allSettled([
    expireInvites(db, now),
    mailer.drainOutbox(),
    mailer.scrubSensitivePayloads(),
  ])
  const value = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : `error: ${String(r.reason)}`)
  return { invitesExpired: value(invites), email: value(email), payloadsScrubbed: value(scrubbed) }
}
