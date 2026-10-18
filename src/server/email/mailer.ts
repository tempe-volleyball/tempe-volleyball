import { and, asc, eq, gt, inArray, lt, lte, ne, or, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { canonicalMailbox } from '../../lib/enrolment/validate'
import { sydneyDate } from '../../lib/time'
import { hashInviteToken, inviteStatus } from '../auth/roles'
import { runBatch, type AppDb } from '../db'
import { adminInvites, emailDailyCount, emailOutbox, groups, registrations, type EmailOutboxRow } from '../db/schema'
import { hashKey, hit } from '../ratelimit'
import {
  AUTH_TEMPLATES,
  SENSITIVE_TEMPLATES,
  isAuthTemplate,
  isSensitiveTemplate,
  isTemplateName,
  renderEmail,
  type RenderedEmail,
  type TemplateData,
  type TemplateName,
} from './templates'

// Every email goes through here (CLAUDE.md: "Providers stay swappable"). Each one is written to email_outbox first.
// If today's count (Sydney date) is under the cap it is sent straight away through Resend; otherwise it stays
// queued and the hourly cron drains it with drainOutbox(). Without RESEND_API_KEY, development and staging log
// emails (codes included) to the console so sign-in can be tested; production fails closed and logs nothing.
//
// Secrets (sign-in codes and links, invite links) are only stored while the email can still be sent: sign-in
// emails are send-now-or-never and never stored with their payload, and every final state (sent, logged, failed)
// clears a sensitive payload. The cron (scrubSensitivePayloads) clears any that slipped through.
//
// The daily cap is split in two pools, so a flood of sign-in requests can't use up the allowance for other mail
// and other mail can't lock admins out: sign-in emails get AUTH_DAILY_CAP of DAILY_CAP, everything else the rest.
// Sign-in emails are also limited per recipient (AUTH_PER_HOUR, AUTH_PER_DAY).
//
// Enrolment emails that an anonymous form can trigger (anything not sent with `priority`) are limited per mailbox
// (ENROLMENT_PER_HOUR / _PER_DAY, keyed on canonicalMailbox so +tags and Gmail dots count as one), and may only use
// the general pool up to PRIORITY_RESERVE short of its cap: the rest is kept for waitlist offers, admin emails and
// emails after a confirmed address, so junk entries can't hold up a real offer (docs/admin.md §3.7).
//
// A waitlist offer's hold starts when its email actually goes: the payload's `hold` names the offer, and a send
// extends offer_expires_at to sentAt + hours (the cron also never lapses an offer whose email is still queued).

/** Resend's free plan allows 100 a day; keep a margin. */
export const DAILY_CAP = 95
/** The part of DAILY_CAP for sign-in emails (auth.otp, auth.magic_link). Other emails get DAILY_CAP minus this. */
export const AUTH_DAILY_CAP = 40
/** Sign-in emails to one address in any rolling hour / 24 hours. Requests over the limit are dropped silently. */
export const AUTH_PER_HOUR = 5
export const AUTH_PER_DAY = 10
/** Of the general pool (DAILY_CAP − AUTH_DAILY_CAP), this many a day are kept for priority emails. */
export const PRIORITY_RESERVE = 20
/** Non-priority enrolment emails to one mailbox per hour (more are queued for later) and per day (more are dropped). */
export const ENROLMENT_PER_HOUR = 5
export const ENROLMENT_PER_DAY = 10
/** Give up on an email after this many failed sends. */
export const MAX_ATTEMPTS = 5
/** Emails the cron sends per run; keeps one invocation well under the 50 D1 queries / 50 subrequests limits. */
export const DRAIN_BATCH = 10
/** The cron clears sensitive payloads that can no longer be sent once they're this old. */
export const SCRUB_AFTER_MS = 60 * 60 * 1000
/** Invites last 7 days (roles.ts INVITE_TTL_MS); a queued invite email older than that can't be useful. */
const INVITE_EMAIL_TTL_MS = 7 * 24 * 60 * 60 * 1000
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
  /** Emails a day in all (default DAILY_CAP). */
  dailyCap?: number
  /** How much of dailyCap is for sign-in emails (default AUTH_DAILY_CAP, at most dailyCap). */
  authDailyCap?: number
  /** How much of the general pool is kept for priority emails (default PRIORITY_RESERVE). */
  priorityReserve?: number
  /** Salts the per-mailbox rate-limit keys (BETTER_AUTH_SECRET). Without it the enrolment per-mailbox limit is off. */
  hashSalt?: string | undefined
}

export type SendOptions = {
  /**
   * Send now or not at all: if the cap is reached or the send fails, mark the email failed instead of queuing it.
   * For sign-in codes and links, which expire in minutes, so a late send is useless. Always on for AUTH_TEMPLATES.
   */
  immediateOnly?: boolean
  /**
   * Sent because of an admin action, the cron or an address the person has confirmed, not straight from an anonymous
   * form: skips the per-mailbox enrolment limit and may use the reserved share of the pool. Waitlist offers and
   * cancellations are always priority.
   */
  priority?: boolean
}

/** Templates that are always priority: nothing anonymous can trigger them. */
export const PRIORITY_TEMPLATES: ReadonlySet<string> = new Set(['admin.invite', 'enrolment.offer', 'enrolment.cancelled'])

const isEnrolmentTemplate = (t: string) => t.startsWith('enrolment.')

/** What an offer email's payload carries so a send can start the hold (`hold`). */
export type OfferHold = { type: 'registration' | 'group'; id: string; offeredAt: string; hours: number }

const holdOf = (payload: Record<string, unknown>): OfferHold | null => {
  const h = payload.hold as Partial<OfferHold> | undefined
  return h && (h.type === 'registration' || h.type === 'group') && typeof h.id === 'string' && typeof h.offeredAt === 'string'
    ? { type: h.type, id: h.id, offeredAt: h.offeredAt, hours: typeof h.hours === 'number' && h.hours > 0 ? h.hours : 48 }
    : null
}

/** `limited`: over a per-recipient limit, dropped without being stored. */
export type SendStatus = 'sent' | 'logged' | 'queued' | 'failed' | 'limited'
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

type Pool = 'auth' | 'general'

/** The email_daily_count key for a pool: the Sydney date for general mail, "<date>:auth" for sign-in emails. */
export const poolKey = (at: Date, pool: Pool) => (pool === 'auth' ? `${sydneyDate(at)}:auth` : sydneyDate(at))

const poolOf = (template: string): Pool => (isAuthTemplate(template) ? 'auth' : 'general')

/** The invite token in an invite email's URL (/admin/invite#<token>), if any. */
const inviteTokenOf = (payload: Record<string, unknown>) => {
  const url = typeof payload.url === 'string' ? payload.url : ''
  const i = url.indexOf('#')
  return i >= 0 ? url.slice(i + 1) : null
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
  const authCap = Math.min(deps.authDailyCap ?? AUTH_DAILY_CAP, cap)
  const poolCap: Record<Pool, number> = { auth: authCap, general: cap - authCap }
  const reserve = Math.min(Math.max(0, deps.priorityReserve ?? PRIORITY_RESERVE), poolCap.general)
  const mode = emailMode(env)

  /**
   * Takes one slot of today's allowance for the pool. Returns no rows when it's used up. Atomic (one upsert).
   * Non-priority general mail stops PRIORITY_RESERVE short of the pool's cap.
   */
  const reserveQuery = (at: Date, pool: Pool, priority = false) => {
    const iso = at.toISOString()
    const limit = pool === 'general' && !priority ? poolCap.general - reserve : poolCap[pool]
    return db
      .insert(emailDailyCount)
      .values({ day: poolKey(at, pool), sent: limit > 0 ? 1 : 0, createdAt: iso, updatedAt: iso })
      .onConflictDoUpdate({
        target: emailDailyCount.day,
        set: { sent: sql`${emailDailyCount.sent} + 1`, updatedAt: iso },
        setWhere: sql`${emailDailyCount.sent} < ${limit}`,
      })
      .returning({ sent: emailDailyCount.sent })
  }

  /** Did the reserve query get a slot? (A pool with no allowance inserts a 0 row, which isn't a slot.) */
  const gotSlot = (rows: unknown) => (rows as { sent: number }[]).some((r) => r.sent > 0)

  const releaseQuery = (at: Date, pool: Pool) =>
    db
      .update(emailDailyCount)
      .set({ sent: sql`max(${emailDailyCount.sent} - 1, 0)` })
      .where(eq(emailDailyCount.day, poolKey(at, pool)))

  const logEmail = (to: string, template: string, email: RenderedEmail) =>
    log(`[email:${env.SITE_ENV}] to=${to} template=${template} subject="${email.subject}"\n${email.text}`)

  /** Codes, sign-in links and invite links aren't kept once the email reaches a final state. */
  const scrub = (template: string) => (isSensitiveTemplate(template) ? { payload: {} } : {})

  const sentUpdate = (row: Pick<EmailOutboxRow, 'id' | 'template' | 'attempts'>, providerId: string, at: Date) =>
    db
      .update(emailOutbox)
      .set({ status: 'sent', sentAt: at.toISOString(), providerId, attempts: row.attempts + 1, error: null, ...scrub(row.template) })
      .where(eq(emailOutbox.id, row.id))

  const failedUpdate = (
    row: Pick<EmailOutboxRow, 'id' | 'template' | 'attempts'>,
    error: string,
    giveUp: boolean,
    opts: { attempted?: boolean } = {},
  ) =>
    db
      .update(emailOutbox)
      .set({
        status: giveUp ? 'failed' : 'queued',
        attempts: row.attempts + (opts.attempted === false ? 0 : 1),
        error,
        ...(giveUp ? scrub(row.template) : {}),
      })
      .where(eq(emailOutbox.id, row.id))

  /** Starts (extends) a waitlist offer's hold from the moment its email went: offer_expires_at = at + hours. */
  const holdStatements = (hold: OfferHold, at: Date): BatchItem<'sqlite'>[] => {
    const until = new Date(at.getTime() + hold.hours * 3_600_000).toISOString()
    const live = (t: typeof registrations | typeof groups) =>
      and(eq(t.status, 'offered'), eq(t.offeredAt, hold.offeredAt), lt(t.offerExpiresAt, until))
    return hold.type === 'group'
      ? [
          db
            .update(groups)
            .set({ offerExpiresAt: until })
            .where(and(eq(groups.id, hold.id), live(groups))),
          db
            .update(registrations)
            .set({ offerExpiresAt: until })
            .where(and(eq(registrations.groupId, hold.id), eq(registrations.freeAgent, false), live(registrations))),
        ]
      : [
          db
            .update(registrations)
            .set({ offerExpiresAt: until })
            .where(and(eq(registrations.id, hold.id), live(registrations))),
        ]
  }

  /** The payload to render and the hold statements for an email being sent at `at`. */
  const forSend = (template: string, payload: Record<string, unknown>, at: Date) => {
    const hold = template === 'enrolment.offer' ? holdOf(payload) : null
    if (!hold) return { payload, extra: [] as BatchItem<'sqlite'>[] }
    const until = new Date(at.getTime() + hold.hours * 3_600_000).toISOString()
    const shown = typeof payload.expiresAt === 'string' && payload.expiresAt > until ? payload.expiresAt : until
    return { payload: { ...payload, expiresAt: shown }, extra: holdStatements(hold, at) }
  }

  /**
   * The per-mailbox limit for non-priority enrolment emails: 'ok', 'later' (over the hour: queue it until the window
   * ends) or 'drop' (over the day). One batch of two upserts.
   */
  async function enrolmentLimit(to: string, at: Date): Promise<{ verdict: 'ok' | 'later' | 'drop'; retryAfter: number }> {
    if (!deps.hashSalt) return { verdict: 'ok', retryAfter: 0 }
    const h = await hashKey(canonicalMailbox(to), deps.hashSalt)
    const hour = `mail:enrol:${h}`
    const day = `mail:enrol-day:${h}`
    const r = await hit(
      db,
      [
        { key: hour, max: ENROLMENT_PER_HOUR, windowMs: 60 * 60 * 1000 },
        { key: day, max: ENROLMENT_PER_DAY, windowMs: 24 * 60 * 60 * 1000 },
      ],
      at,
    )
    if (r.exceeded.includes(day)) return { verdict: 'drop', retryAfter: r.retryAfter }
    if (r.exceeded.includes(hour)) return { verdict: 'later', retryAfter: r.retryAfter }
    return { verdict: 'ok', retryAfter: 0 }
  }

  /** Sign-in emails to this address recently: { hour, day } in the rolling hour and 24 hours. */
  async function recentAuthEmails(to: string, at: Date) {
    const hourAgo = new Date(at.getTime() - 60 * 60 * 1000).toISOString()
    const dayAgo = new Date(at.getTime() - 24 * 60 * 60 * 1000).toISOString()
    const row = await db
      .select({
        day: sql<number>`count(*)`,
        hour: sql<number>`coalesce(sum(case when ${emailOutbox.createdAt} > ${hourAgo} then 1 else 0 end), 0)`,
      })
      .from(emailOutbox)
      .where(and(eq(emailOutbox.to, to), inArray(emailOutbox.template, [...AUTH_TEMPLATES]), gt(emailOutbox.createdAt, dayAgo)))
      .get()
    return { hour: Number(row?.hour ?? 0), day: Number(row?.day ?? 0) }
  }

  /**
   * Queues an email and sends it now if today's cap allows. Throws EmailNotConfiguredError in production when
   * RESEND_API_KEY is missing (non-sensitive emails stay queued for when it's set; sensitive ones are marked failed
   * with no payload, since an invite's link is shown in the admin and a sign-in code is useless later).
   */
  async function sendEmail<K extends TemplateName>(
    rawTo: string,
    template: K,
    data: TemplateData[K],
    opts: SendOptions = {},
  ): Promise<SendResult> {
    const at = now()
    const iso = at.toISOString()
    const auth = isAuthTemplate(template)
    const immediateOnly = auth || !!opts.immediateOnly
    const pool = poolOf(template)
    const priority = !!opts.priority || PRIORITY_TEMPLATES.has(template)
    // Sign-in addresses are case-insensitive; one spelling keeps the per-recipient count honest.
    const to = auth ? rawTo.trim().toLowerCase() : rawTo
    let sendAfter = iso

    if (auth) {
      const recent = await recentAuthEmails(to, at)
      if (recent.hour >= AUTH_PER_HOUR || recent.day >= AUTH_PER_DAY) {
        console.warn(`[email] ${template} not sent: per-recipient limit reached (${recent.hour} this hour, ${recent.day} today)`)
        return { id: '', status: 'limited' }
      }
    }
    if (isEnrolmentTemplate(template) && !priority) {
      const limit = await enrolmentLimit(to, at)
      if (limit.verdict === 'drop') {
        console.warn(`[email] ${template} not sent: per-mailbox limit for today reached`)
        return { id: '', status: 'limited' }
      }
      if (limit.verdict === 'later') sendAfter = new Date(at.getTime() + limit.retryAfter * 1000).toISOString()
    }

    const prepared = forSend(template, data as Record<string, unknown>, at)
    const email = renderEmail(template, prepared.payload as TemplateData[K])
    // An immediate-only email is sent from memory, so its payload is never stored.
    const payload = immediateOnly ? {} : (data as Record<string, unknown>)
    const row = { id: crypto.randomUUID(), to, template, payload, attempts: 0, createdAt: iso, updatedAt: iso }
    const insert = db.insert(emailOutbox).values({ ...row, priority, status: 'queued', sendAfter })
    if (sendAfter !== iso) {
      // Over the hourly per-mailbox limit: the cron sends it once the window has passed.
      await insert
      if (mode === 'disabled') throw new EmailNotConfiguredError()
      return { id: row.id, status: 'queued' }
    }

    if (mode === 'disabled') {
      await (immediateOnly || isSensitiveTemplate(template)
        ? db.insert(emailOutbox).values({ ...row, payload: {}, status: 'failed', error: 'RESEND_API_KEY not set' })
        : insert)
      throw new EmailNotConfiguredError()
    }

    if (mode === 'console') {
      await runBatch(db, [insert, sentUpdate(row, 'console', at), ...prepared.extra])
      logEmail(to, template, email)
      return { id: row.id, status: 'logged' }
    }

    const [, reserved] = await runBatch(db, [insert, reserveQuery(at, pool, priority)])
    if (!gotSlot(reserved)) {
      if (immediateOnly) {
        console.warn(`[email] ${template} not sent: today's ${pool} email limit is reached`)
        await failedUpdate(row, 'Daily email limit reached', true, { attempted: false })
        return { id: row.id, status: 'failed' }
      }
      return { id: row.id, status: 'queued' }
    }
    const result = await sendViaResend(doFetch, env.RESEND_API_KEY!, row.id, to, email)
    if (result.ok) {
      const sentAt = now()
      const extra = forSend(template, data as Record<string, unknown>, sentAt).extra
      await (extra.length > 0 ? runBatch(db, [sentUpdate(row, result.id, sentAt), ...extra]) : sentUpdate(row, result.id, sentAt))
      return { id: row.id, status: 'sent' }
    }
    console.warn(`[email] send failed for ${row.id} (${template}): ${result.error}`)
    const giveUp = immediateOnly || !result.retry
    await runBatch(db, [failedUpdate(row, result.error, giveUp), releaseQuery(at, pool)])
    return { id: row.id, status: giveUp ? 'failed' : 'queued' }
  }

  /**
   * An insert that queues an email, for a caller's own db.batch(), so the email is written in the same transaction
   * as the change it reports (the enrolment cron). drainOutbox() sends it. Not for sign-in emails.
   */
  function queueStatement<K extends TemplateName>(
    to: string,
    template: K,
    data: TemplateData[K],
    at = now(),
    opts: Pick<SendOptions, 'priority'> = {},
  ) {
    if (isAuthTemplate(template)) throw new Error(`queueStatement: ${template} is send-now-or-never`)
    const iso = at.toISOString()
    return db.insert(emailOutbox).values({
      id: crypto.randomUUID(),
      to,
      template,
      payload: data as Record<string, unknown>,
      priority: !!opts.priority || PRIORITY_TEMPLATES.has(template),
      status: 'queued',
      attempts: 0,
      sendAfter: iso,
      createdAt: iso,
      updatedAt: iso,
    })
  }

  /** Looks up the invites behind the invite emails among `rows` (by the token's hash, one query), to check they're still pending. */
  async function invitesFor(rows: EmailOutboxRow[]) {
    const hashes = new Map<string, string>()
    for (const row of rows) {
      if (row.template !== 'admin.invite') continue
      const token = inviteTokenOf(row.payload)
      if (token) hashes.set(row.id, await hashInviteToken(token))
    }
    const found =
      hashes.size === 0
        ? []
        : await db
            .select({
              tokenHash: adminInvites.tokenHash,
              acceptedAt: adminInvites.acceptedAt,
              revokedAt: adminInvites.revokedAt,
              expiredAt: adminInvites.expiredAt,
              expiresAt: adminInvites.expiresAt,
            })
            .from(adminInvites)
            .where(inArray(adminInvites.tokenHash, [...new Set(hashes.values())]))
    const byHash = new Map(found.map((i) => [i.tokenHash, i]))
    return (rowId: string) => {
      const hash = hashes.get(rowId)
      return hash ? byHash.get(hash) : undefined
    }
  }

  /** Which of the offer emails among `rows` still name a live offer (one query, only when there are any). */
  async function liveOffersFor(rows: EmailOutboxRow[]) {
    const holds = new Map<string, OfferHold>()
    for (const row of rows) {
      const hold = row.template === 'enrolment.offer' ? holdOf(row.payload) : null
      if (hold) holds.set(row.id, hold)
    }
    if (holds.size === 0) return () => true
    const regIds = [...holds.values()].filter((h) => h.type === 'registration').map((h) => h.id)
    const groupIds = [...holds.values()].filter((h) => h.type === 'group').map((h) => h.id)
    const live = await db
      .select({ id: registrations.id, groupId: registrations.groupId, offeredAt: registrations.offeredAt })
      .from(registrations)
      .where(
        and(
          eq(registrations.status, 'offered'),
          or(
            regIds.length > 0 ? inArray(registrations.id, regIds) : undefined,
            groupIds.length > 0 ? and(inArray(registrations.groupId, groupIds), eq(registrations.freeAgent, false)) : undefined,
          ),
        ),
      )
      .all()
    const ok = new Set(live.flatMap((r) => [`registration:${r.id}:${r.offeredAt}`, `group:${r.groupId}:${r.offeredAt}`]))
    return (rowId: string) => {
      const h = holds.get(rowId)
      return !h || ok.has(`${h.type}:${h.id}:${h.offeredAt}`)
    }
  }

  /** Cron: sends queued emails, oldest first, while today's cap allows. Returns counts for the log. */
  async function drainOutbox(limit = DRAIN_BATCH) {
    const at = now()
    const counts = { sent: 0, failed: 0, skipped: 0, remaining: 0 }
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
    const inviteOf = await invitesFor(rows)
    const offerLive = await liveOffersFor(rows)
    const updates: BatchItem<'sqlite'>[] = []
    for (const row of rows) {
      if (!isTemplateName(row.template)) {
        updates.push(failedUpdate(row, `Unknown template ${row.template}`, true, { attempted: false }))
        counts.failed++
        continue
      }
      // Sign-in emails are send-now-or-never; one left queued (e.g. the Worker died mid-send) is stale.
      if (isAuthTemplate(row.template)) {
        updates.push(failedUpdate(row, 'Sign-in email not sent in time', true, { attempted: false }))
        counts.skipped++
        continue
      }
      // A waitlist offer that was answered, cancelled or re-offered before it could be sent would only confuse.
      // (One that's still open is held until its email goes: the send starts the hold.)
      if (row.template === 'enrolment.offer' && !offerLive(row.id)) {
        updates.push(failedUpdate(row, 'Offer no longer open', true, { attempted: false }))
        counts.skipped++
        continue
      }
      // A confirm link past its deadline is useless (the entry has expired).
      if (
        row.template === 'enrolment.confirm_email' &&
        typeof row.payload.expiresAt === 'string' &&
        row.payload.expiresAt <= at.toISOString()
      ) {
        updates.push(failedUpdate(row, 'Confirm link expired before it was sent', true, { attempted: false }))
        counts.skipped++
        continue
      }
      if (row.template === 'admin.invite') {
        const invite = inviteOf(row.id)
        const status = invite ? inviteStatus(invite, at) : 'missing'
        if (status !== 'pending') {
          updates.push(failedUpdate(row, `Invite is ${status}`, true, { attempted: false }))
          counts.skipped++
          continue
        }
      }
      const prepared = forSend(row.template, row.payload, at)
      const email = renderEmail(row.template, prepared.payload as never)
      if (mode === 'console') {
        logEmail(row.to, row.template, email)
        updates.push(sentUpdate(row, 'console', at), ...prepared.extra)
        counts.sent++
        continue
      }
      const pool = poolOf(row.template)
      if (!gotSlot(await reserveQuery(at, pool, row.priority))) {
        counts.remaining = rows.length - counts.sent - counts.failed - counts.skipped
        break
      }
      const result = await sendViaResend(doFetch, env.RESEND_API_KEY!, row.id, row.to, email)
      if (result.ok) {
        updates.push(sentUpdate(row, result.id, now()), ...prepared.extra)
        counts.sent++
      } else {
        const giveUp = !result.retry || row.attempts + 1 >= MAX_ATTEMPTS
        updates.push(failedUpdate(row, result.error, giveUp), releaseQuery(at, pool))
        if (giveUp) counts.failed++
      }
    }
    if (updates.length > 0) await runBatch(db, updates)
    return counts
  }

  /**
   * Cron: clears sensitive payloads (codes, sign-in links, invite links) older than SCRUB_AFTER_MS that can no
   * longer be sent: any in a final state, queued sign-in emails, queued invites past their lifetime, and, while
   * email is disabled, every queued sensitive email (they're marked failed; the admin shows invite links instead).
   * Returns how many rows it changed. Idempotent, two queries in one batch.
   */
  async function scrubSensitivePayloads() {
    const at = now()
    const cutoff = new Date(at.getTime() - SCRUB_AFTER_MS).toISOString()
    const inviteCutoff = new Date(at.getTime() - INVITE_EMAIL_TTL_MS).toISOString()
    const sensitive = [...SENSITIVE_TEMPLATES]
    const hasPayload = sql`${emailOutbox.payload} <> '{}'`
    const old = and(inArray(emailOutbox.template, sensitive), hasPayload, lt(emailOutbox.createdAt, cutoff))
    const unsendable =
      mode === 'disabled' ? undefined : or(inArray(emailOutbox.template, [...AUTH_TEMPLATES]), lt(emailOutbox.createdAt, inviteCutoff))
    const [finished, stale] = await runBatch(db, [
      db
        .update(emailOutbox)
        .set({ payload: {} })
        .where(and(old, ne(emailOutbox.status, 'queued')))
        .returning({ id: emailOutbox.id }),
      db
        .update(emailOutbox)
        .set({ payload: {}, status: 'failed', error: mode === 'disabled' ? 'RESEND_API_KEY not set' : 'No longer sendable' })
        .where(and(old, eq(emailOutbox.status, 'queued'), unsendable))
        .returning({ id: emailOutbox.id }),
    ])
    return (finished as unknown[]).length + (stale as unknown[]).length
  }

  /**
   * Cron: deletes sent and failed emails older than `days` (Settings → Enrolment, default 30), so addresses don't
   * stay in the outbox for ever. Queued ones are kept. One statement for the cron's batch (status/send_after index).
   */
  function pruneStatement(days: number, at = now()) {
    const cutoff = new Date(at.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
    return db
      .delete(emailOutbox)
      .where(and(inArray(emailOutbox.status, ['sent', 'failed']), lt(emailOutbox.sendAfter, cutoff)))
      .returning({ id: emailOutbox.id })
  }

  return { mode, sendEmail, queueStatement, drainOutbox, scrubSensitivePayloads, pruneStatement }
}

export type Mailer = ReturnType<typeof createMailer>
