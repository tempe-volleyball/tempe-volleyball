import { runAnalytics, type AnalyticsDeps } from './analytics/fetch'
import { expireInvites } from './auth/roles'
import { getSettings } from './content/settings'
import { getDb, runBatch, type AppDb } from './db'
import { createMailer, type Mailer } from './email'
import { expirePendingStatements } from './enrolment/confirm'
import { runEnrolmentCron } from './enrolment/offers'
import { pruneRateLimits } from './ratelimit'

/**
 * Cron Trigger entry point (see `triggers.crons` in wrangler.jsonc; schedules are UTC). Hourly. Every job is
 * idempotent and batches its D1 writes:
 *  - enrolment: expire lapsed waitlist offers and offer free spots down the list (src/server/enrolment/offers.ts),
 *    queueing the emails, which is why it runs before the outbox is drained
 *  - delete ended rate-limit windows
 *  - housekeeping (one settings read and one batch): expire public entries whose email address wasn't confirmed in
 *    time (src/server/enrolment/confirm.ts), and delete sent or failed emails older than Settings → Enrolment's
 *    "days to keep sent emails" (default 30), so addresses don't stay in the outbox
 *  - expire admin invites past their expiry
 *  - send queued emails that went over Resend's daily limit
 *  - clear secret payloads (codes, sign-in and invite links) from outbox rows that can no longer be sent
 *  - fetch analytics: at most one source per invocation, each about once a day (src/server/analytics/fetch.ts);
 *    skipped ("deferred") in an hour when the enrolment job queued emails, to stay inside 50 D1 queries
 * Still to come: release unpaid registrations past their hold time (Phase 5).
 * The nightly D1 backup runs from GitHub Actions, not here (see .github/workflows/backup.yml).
 */
export async function runScheduled(cron: string, env: Env): Promise<void> {
  const db = getDb(env.DB)
  const secrets = env as unknown as {
    RESEND_API_KEY?: string
    BETTER_AUTH_SECRET?: string
    GOOGLE_SERVICE_ACCOUNT_JSON?: string
    CF_ANALYTICS_TOKEN?: string
  }
  const mailer = createMailer({
    db,
    env: { SITE_ENV: env.SITE_ENV, RESEND_API_KEY: secrets.RESEND_API_KEY },
    hashSalt: secrets.BETTER_AUTH_SECRET,
  })
  const analytics: AnalyticsDeps = {
    secrets: { GOOGLE_SERVICE_ACCOUNT_JSON: secrets.GOOGLE_SERVICE_ACCOUNT_JSON, CF_ANALYTICS_TOKEN: secrets.CF_ANALYTICS_TOKEN },
    fetch: (input, init) => fetch(input, init),
  }
  const enrolment = secrets.BETTER_AUTH_SECRET ? { secret: secrets.BETTER_AUTH_SECRET, siteUrl: env.SITE_URL } : undefined
  const result = await runJobs(db, mailer, new Date(), { analytics, enrolment })
  console.info(`[cron] ${cron} in ${env.SITE_ENV}: ${JSON.stringify(result)}`)
}

/** Emails drained in a run where the enrolment job did work (half the usual DRAIN_BATCH). */
export const BUSY_DRAIN_BATCH = 5

export type JobDeps = {
  analytics?: AnalyticsDeps
  /** The token secret and site URL for waitlist offer links; without it the enrolment job is skipped. */
  enrolment?: { secret: string; siteUrl: string }
}

/**
 * Expires unconfirmed entries and prunes the outbox: one settings read plus one batch of three statements, whatever
 * the amount of work (each statement is bounded).
 */
export async function runHousekeeping(db: AppDb, mailer: Partial<Pick<Mailer, 'pruneStatement'>>, now = new Date()) {
  const settings = await getSettings(db)
  const at = now.toISOString()
  const results = await runBatch(db, [
    ...expirePendingStatements(db, at),
    ...(mailer.pruneStatement ? [mailer.pruneStatement(settings.enrolment.emailRetentionDays, now)] : []),
  ])
  return {
    pendingExpired: (results[0] as unknown[]).length,
    emailsPruned: mailer.pruneStatement ? (results[2] as unknown[]).length : 0,
  }
}

/** The jobs themselves, with bindings passed in so tests can run them. One failing job doesn't stop the others. */
export async function runJobs(
  db: AppDb,
  mailer: Pick<Mailer, 'drainOutbox' | 'scrubSensitivePayloads'> & Partial<Pick<Mailer, 'queueStatement' | 'pruneStatement'>>,
  now = new Date(),
  deps: JobDeps = {},
) {
  const { analytics, enrolment: enrolmentDeps } = deps
  // Enrolment first: it queues offer emails for the drain below to send in the same run.
  const queue = mailer.queueStatement
  const [enrolment, pruned, housekeeping] = await Promise.allSettled([
    enrolmentDeps && queue
      ? runEnrolmentCron(db, { mailer: { queueStatement: queue }, ...enrolmentDeps }, now)
      : Promise.resolve('skipped'),
    pruneRateLimits(db, now),
    runHousekeeping(db, mailer, now),
  ])
  // A run where enrolment did work (up to ~20 D1 queries) sends fewer emails and leaves analytics to the next hour,
  // so the whole invocation stays inside the free plan's 50 queries.
  const busy = enrolment.status === 'fulfilled' && typeof enrolment.value === 'object' && enrolment.value.emailsQueued > 0
  const [invites, email, scrubbed, stats] = await Promise.allSettled([
    expireInvites(db, now),
    busy ? mailer.drainOutbox(BUSY_DRAIN_BATCH) : mailer.drainOutbox(),
    mailer.scrubSensitivePayloads(),
    analytics && !busy ? runAnalytics(db, analytics, now) : Promise.resolve('deferred' as const),
  ])
  const value = <T>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : `error: ${String(r.reason)}`)
  return {
    invitesExpired: value(invites),
    email: value(email),
    payloadsScrubbed: value(scrubbed),
    ...(analytics ? { analytics: value(stats) } : {}),
    enrolment: value(enrolment),
    rateLimitsPruned: value(pruned),
    housekeeping: value(housekeeping),
  }
}
