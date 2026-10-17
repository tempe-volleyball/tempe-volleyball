import { and, asc, eq, lte, sql } from 'drizzle-orm'
import { sydneyDate } from '../../lib/time'
import { runBatch, type AppDb } from '../db'
import { emailDailyCount, emailOutbox, type EmailOutboxRow } from '../db/schema'
import { SENSITIVE_TEMPLATES, isTemplateName, renderEmail, type RenderedEmail, type TemplateData, type TemplateName } from './templates'

// Every email goes through here (CLAUDE.md: "Providers stay swappable"). Each one is written to email_outbox first.
// If today's count (Sydney date) is under the cap it is sent straight away through Resend; otherwise it stays
// queued and the hourly cron drains it with drainOutbox(). Without RESEND_API_KEY, development and staging log
// emails (codes included) to the console so sign-in can be tested; production fails closed and logs nothing.

/** Resend's free plan allows 100 a day; keep a margin. */
export const DAILY_CAP = 95
/** Give up on an email after this many failed sends. */
export const MAX_ATTEMPTS = 5
/** Emails the cron sends per run; keeps one invocation well under the 50 D1 queries / 50 subrequests limits. */
export const DRAIN_BATCH = 10
export const FROM = 'Tempe Volleyball <noreply@mail.tempevb.com>'
export const RESEND_URL = 'https://api.resend.com/emails'

export type MailerEnv = { SITE_ENV: string; RESEND_API_KEY?: string | undefined }

export type MailerDeps = {
  db: AppDb
  env: MailerEnv
  fetch?: typeof fetch
  now?: () => Date
  /** Where console-mode emails and warnings go (default console.info). */
  log?: (message: string) => void
  dailyCap?: number
}

export type SendOptions = {
  /**
   * Send now or not at all: if the cap is reached or the send fails, mark the email failed instead of queuing it.
   * For sign-in codes and links, which expire in minutes, so a late send is useless.
   */
  immediateOnly?: boolean
}

export type SendStatus = 'sent' | 'logged' | 'queued' | 'failed'
export type SendResult = { id: string; status: SendStatus }

export class EmailNotConfiguredError extends Error {
  constructor() {
    super('Email is not configured (RESEND_API_KEY is not set).')
    this.name = 'EmailNotConfiguredError'
  }
}

type Mode = 'resend' | 'console' | 'disabled'

export const emailMode = (env: MailerEnv): Mode => {
  if (env.RESEND_API_KEY) return 'resend'
  return env.SITE_ENV === 'development' || env.SITE_ENV === 'staging' ? 'console' : 'disabled'
}

type ProviderResult = { ok: true; id: string } | { ok: false; error: string; retry: boolean }

async function sendViaResend(
  doFetch: typeof fetch,
  apiKey: string,
  outboxId: string,
  to: string,
  email: RenderedEmail,
): Promise<ProviderResult> {
  try {
    const res = await doFetch(RESEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': outboxId },
      body: JSON.stringify({ from: FROM, to: [to], subject: email.subject, html: email.html, text: email.text }),
    })
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string }
    if (res.ok && body.id) return { ok: true, id: body.id }
    // 4xx other than rate limiting won't get better on retry (bad address, bad key).
    const retry = res.status === 429 || res.status >= 500
    return { ok: false, error: `Resend ${res.status}: ${body.message ?? body.name ?? 'no message'}`.slice(0, 500), retry }
  } catch (e) {
    return { ok: false, error: `Resend fetch failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500), retry: true }
  }
}

export function createMailer(deps: MailerDeps) {
  const { db, env } = deps
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((m: string) => console.info(m))
  const cap = deps.dailyCap ?? DAILY_CAP
  const mode = emailMode(env)

  /** Takes one slot of today's allowance. Returns false when the cap is reached. Atomic (one upsert). */
  const reserveQuery = (at: Date) => {
    const iso = at.toISOString()
    return db
      .insert(emailDailyCount)
      .values({ day: sydneyDate(at), sent: 1, createdAt: iso, updatedAt: iso })
      .onConflictDoUpdate({
        target: emailDailyCount.day,
        set: { sent: sql`${emailDailyCount.sent} + 1`, updatedAt: iso },
        setWhere: sql`${emailDailyCount.sent} < ${cap}`,
      })
      .returning({ sent: emailDailyCount.sent })
  }

  const releaseQuery = (at: Date) =>
    db
      .update(emailDailyCount)
      .set({ sent: sql`max(${emailDailyCount.sent} - 1, 0)` })
      .where(eq(emailDailyCount.day, sydneyDate(at)))

  const logEmail = (to: string, template: string, email: RenderedEmail) =>
    log(`[email:${env.SITE_ENV}] to=${to} template=${template} subject="${email.subject}"\n${email.text}`)

  const sentUpdate = (row: Pick<EmailOutboxRow, 'id' | 'template' | 'attempts'>, providerId: string, at: Date) =>
    db
      .update(emailOutbox)
      .set({
        status: 'sent',
        sentAt: at.toISOString(),
        providerId,
        attempts: row.attempts + 1,
        error: null,
        // Codes and sign-in links aren't kept once delivered.
        ...(isTemplateName(row.template) && SENSITIVE_TEMPLATES.has(row.template) ? { payload: {} } : {}),
      })
      .where(eq(emailOutbox.id, row.id))

  const failedUpdate = (row: Pick<EmailOutboxRow, 'id' | 'attempts'>, error: string, giveUp: boolean) =>
    db
      .update(emailOutbox)
      .set({ status: giveUp ? 'failed' : 'queued', attempts: row.attempts + 1, error })
      .where(eq(emailOutbox.id, row.id))

  /**
   * Queues an email and sends it now if today's cap allows. Throws EmailNotConfiguredError in production when
   * RESEND_API_KEY is missing (the email stays queued for when it's set, except immediateOnly ones).
   */
  async function sendEmail<K extends TemplateName>(
    to: string,
    template: K,
    data: TemplateData[K],
    opts: SendOptions = {},
  ): Promise<SendResult> {
    const at = now()
    const email = renderEmail(template, data)
    const row = { id: crypto.randomUUID(), to, template, payload: data as Record<string, unknown>, attempts: 0 }
    const insert = db.insert(emailOutbox).values({ ...row, status: 'queued', sendAfter: at.toISOString() })

    if (mode === 'disabled') {
      await (opts.immediateOnly
        ? db.insert(emailOutbox).values({ ...row, payload: {}, status: 'failed', error: 'RESEND_API_KEY not set' })
        : insert)
      throw new EmailNotConfiguredError()
    }

    if (mode === 'console') {
      await runBatch(db, [insert, sentUpdate(row, 'console', at)])
      logEmail(to, template, email)
      return { id: row.id, status: 'logged' }
    }

    const [, reserved] = await runBatch(db, [insert, reserveQuery(at)])
    if ((reserved as unknown[]).length === 0) {
      if (opts.immediateOnly) {
        await failedUpdate(row, 'Daily email limit reached', true)
        return { id: row.id, status: 'failed' }
      }
      return { id: row.id, status: 'queued' }
    }
    const result = await sendViaResend(doFetch, env.RESEND_API_KEY!, row.id, to, email)
    if (result.ok) {
      await sentUpdate(row, result.id, now())
      return { id: row.id, status: 'sent' }
    }
    console.warn(`[email] send failed for ${row.id} (${template}): ${result.error}`)
    const giveUp = opts.immediateOnly || !result.retry
    await runBatch(db, [failedUpdate(row, result.error, giveUp), releaseQuery(at)])
    return { id: row.id, status: giveUp ? 'failed' : 'queued' }
  }

  /** Cron: sends queued emails, oldest first, while today's cap allows. Returns counts for the log. */
  async function drainOutbox(limit = DRAIN_BATCH) {
    const at = now()
    const counts = { sent: 0, failed: 0, remaining: 0 }
    if (mode === 'disabled') {
      log('[email] outbox not drained: RESEND_API_KEY is not set')
      return counts
    }
    const rows = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.status, 'queued'), lte(emailOutbox.sendAfter, at.toISOString())))
      .orderBy(asc(emailOutbox.sendAfter))
      .limit(limit)
    const updates = []
    for (const row of rows) {
      if (!isTemplateName(row.template)) {
        updates.push(failedUpdate(row, `Unknown template ${row.template}`, true))
        counts.failed++
        continue
      }
      const email = renderEmail(row.template, row.payload as never)
      if (mode === 'console') {
        logEmail(row.to, row.template, email)
        updates.push(sentUpdate(row, 'console', at))
        counts.sent++
        continue
      }
      const reserved = await reserveQuery(at)
      if (reserved.length === 0) {
        counts.remaining = rows.length - counts.sent - counts.failed
        break
      }
      const result = await sendViaResend(doFetch, env.RESEND_API_KEY!, row.id, row.to, email)
      if (result.ok) {
        updates.push(sentUpdate(row, result.id, now()))
        counts.sent++
      } else {
        const giveUp = !result.retry || row.attempts + 1 >= MAX_ATTEMPTS
        updates.push(failedUpdate(row, result.error, giveUp), releaseQuery(at))
        if (giveUp) counts.failed++
      }
    }
    if (updates.length > 0) await runBatch(db, updates)
    return counts
  }

  return { mode, sendEmail, drainOutbox }
}

export type Mailer = ReturnType<typeof createMailer>
