/**
 * Cron Trigger entry point (see `triggers.crons` in wrangler.jsonc; schedules are UTC).
 * Stub for now. Planned jobs, all of which must be idempotent and batch their D1 writes:
 *  - expire admin invites past their expiry
 *  - release unpaid registrations past their hold time (frees capacity)
 *  - send queued emails that went over Resend's daily limit
 * The nightly D1 backup runs from GitHub Actions, not here (see .github/workflows/backup.yml).
 */
export async function runScheduled(cron: string, env: Env): Promise<void> {
  console.info(`[cron] ${cron} fired in ${env.SITE_ENV}; no jobs yet`)
}
