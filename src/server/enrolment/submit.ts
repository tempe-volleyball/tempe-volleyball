import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { formatAud, sydneyDate } from '../../lib/time'
import { entryTypesFor } from '../../lib/enrolment/defaults'
import { formEntryTypes, type FormEntryType } from '../../lib/enrolment/forms'
import { newReference } from '../../lib/enrolment/reference'
import { isTargetKind, type TargetRef } from '../../lib/enrolment/targets'
import { canonicalMailbox, normaliseEmail, validateEnrolment, type MappedAnswers, type PersonInput } from '../../lib/enrolment/validate'
import { runBatch, type AppDb } from '../db'
import { closedRegistrationStatuses, groups, players, registrations, type RegistrationSource } from '../db/schema'
import { isUniqueFailure } from '../content/common'
import { getSettings } from '../content/settings'
import type { Mailer, SendOptions } from '../email'
import { HttpError } from '../http'
import { hashKey, hit, type Limit } from '../ratelimit'
import { verifyTurnstile } from '../turnstile'
import {
  effective,
  ensureProduct,
  invalid,
  isOpen,
  loadTarget,
  notFound,
  resolveForm,
  sendQuietly,
  settleStatements,
  waitlistRankSql,
  type Effective,
  type ResolvedForm,
  type Target,
} from './core'
import { confirmToken, confirmUrl } from './tokens'

// Taking an enrolment: the public form (POST /api/enrol) and the admin's "Add enrolment". Both go through
// createEntry(), which matches or creates the player, inserts the entry holding a spot and settles it against the
// caps in the same batch (core.ts), so the last spot can't be taken twice.
//
// Where the target asks for email confirmation (Effective.emailConfirm, on by default for anything capped), a public
// entry is inserted as pending_email instead: it holds no spot and isn't on the waitlist. The emailed link
// (confirm.ts) settles it against the caps when it's clicked, so a spot is never held for an address nobody owns.

/**
 * Public form limits (fixed windows). Only the IP limit is counted before Turnstile, so nobody can lock a person
 * out by sending junk with their email; the email limits (on the canonical mailbox) are counted once the check
 * has passed.
 */
export const ENROL_LIMITS = {
  perIpHour: 20,
  perEmailHour: 6,
  perEmailDay: 15,
} as const

const HOUR = 3_600_000

export type EnrolStatus = 'confirmed' | 'waitlist'

/** The largest form answers (JSON) a public entry may carry; the real ceiling of 60 questions is far below it. */
export const MAX_ANSWERS_BYTES = 32 * 1024

export type EnrolResult = {
  /** pending_email: waiting for the emailed link (public entries where the target asks for it). */
  status: EnrolStatus | 'pending_email'
  reference: string
  /** 1-based place on the waitlist, when waitlisted. */
  position: number | null
  registrationId: string
  groupId: string | null
  teamName: string | null
  amountCents: number | null
  /** The form's confirmation text (or null for the default message). */
  message: string | null
  programme: string
  target: string
}

export type EntryOptions = {
  source: RegistrationSource
  actorId?: string | null
  /** Admin: put the entry straight onto the waitlist, or confirm it even over the cap. */
  forceStatus?: EnrolStatus | null
  /** Public, email confirmation on: insert it as pending_email (no spot held) until this deadline (UTC ISO). */
  pendingUntil?: string | null
  now: Date
  /** More statements for the same batch (the admin's audit entry). */
  extra?: (ids: { registrationId: string; groupId: string | null; reference: string }) => BatchItem<'sqlite'>[]
}

const parseRef = (v: unknown): TargetRef => {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  if (!isTargetKind(o.kind) || typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.id)) throw invalid('Choose what to enrol in.')
  return { kind: o.kind, id: o.id }
}

const parseEntryType = (v: unknown, allowed: FormEntryType[]): FormEntryType => {
  const t = (v ?? allowed[0]) as FormEntryType
  if (!(formEntryTypes as readonly string[]).includes(t) || !allowed.includes(t))
    throw invalid(allowed.length === 0 ? "This programme isn't taking entries." : 'Choose how you are entering.')
  return t
}

/** The person's player row (matched by email and name, so siblings sharing a parent's email stay separate). */
async function findPlayer(db: AppDb, person: PersonInput, productId: string) {
  return db
    .select({
      id: players.id,
      liveId: registrations.id,
      liveReference: registrations.reference,
      liveStatus: registrations.status,
      liveCreatedAt: registrations.createdAt,
      liveHoldExpiresAt: registrations.holdExpiresAt,
      liveGroupId: registrations.groupId,
      liveFreeAgent: registrations.freeAgent,
    })
    .from(players)
    .leftJoin(
      registrations,
      and(
        eq(registrations.playerId, players.id),
        eq(registrations.productId, productId),
        notInArray(registrations.status, [...closedRegistrationStatuses]),
      ),
    )
    .where(
      and(
        eq(players.email, person.email),
        sql`lower(${players.firstName}) = lower(${person.firstName})`,
        sql`lower(${players.lastName}) = lower(${person.lastName})`,
      ),
    )
    .orderBy(players.createdAt)
    .limit(1)
    .get()
}

/** The live entry a duplicate submission matched, when it's known (not when a unique index caught a race). */
export type ExistingEntry = {
  registrationId: string
  reference: string
  status: string
  createdAt: string
  holdExpiresAt: string | null
  groupId: string | null
  freeAgent: boolean
}

/** 409 duplicate. The public form never shows it (it answers as for a new entry and emails the person instead). */
export class DuplicateEntryError extends HttpError {
  readonly existing: ExistingEntry | null
  constructor(target: Target, existing: ExistingEntry | null) {
    super(
      409,
      'duplicate',
      `You're already enrolled in ${target.label}. Check your email for the confirmation, or contact us to change it.`,
    )
    this.existing = existing
  }
}

const duplicate = (target: Target, existing: ExistingEntry | null = null) => new DuplicateEntryError(target, existing)

const teamTaken = (name: string) =>
  new HttpError(409, 'team_name_taken', `A team called “${name}” has already entered. Choose another name, or contact us if it's yours.`, {
    fieldErrors: { team_name: 'That team name is taken.' },
  })

/**
 * Creates one entry. `check` is a validated person plus answers (validateEnrolment). Returns where it landed.
 * Throws 409 duplicate / team_name_taken / full.
 */
export async function createEntry(
  db: AppDb,
  target: Target,
  eff: Effective,
  form: ResolvedForm,
  entryType: FormEntryType,
  check: { person: PersonInput; answers: Record<string, unknown>; mapped: MappedAnswers },
  opts: EntryOptions,
): Promise<EnrolResult> {
  const product = await ensureProduct(db, target, opts.actorId ?? null)
  const { person, answers, mapped } = check
  const teamName = entryType === 'team' ? (mapped.teamName ?? '').trim() : null
  if (entryType === 'team' && !teamName) throw invalid('Enter your team name.', { fieldErrors: { team_name: 'Enter your team name.' } })

  if (teamName) {
    const taken = await db
      .select({ id: groups.id })
      .from(groups)
      .where(
        and(eq(groups.productId, product.id), sql`${groups.status} <> 'cancelled'`, sql`lower(trim(${groups.name})) = lower(${teamName})`),
      )
      .get()
    if (taken) throw teamTaken(teamName)
  }
  const existing = await findPlayer(db, person, product.id)
  if (existing?.liveId)
    throw duplicate(target, {
      registrationId: existing.liveId,
      reference: existing.liveReference!,
      status: existing.liveStatus!,
      createdAt: existing.liveCreatedAt!,
      holdExpiresAt: existing.liveHoldExpiresAt ?? null,
      groupId: existing.liveGroupId ?? null,
      freeAgent: !!existing.liveFreeAgent,
    })

  const at = opts.now.toISOString()
  const playerId = existing?.id ?? crypto.randomUUID()
  const groupId = teamName ? crypto.randomUUID() : null
  const registrationId = crypto.randomUUID()
  const g = mapped.guardian
  const playerStatement = existing
    ? // Fill blanks only: a public form must not overwrite details someone else entered (docs/admin.md §3.7).
      db
        .update(players)
        .set({
          phone: sql`coalesce(${players.phone}, ${person.phone || null})`,
          birthYear: sql`coalesce(${players.birthYear}, ${mapped.birthYear ?? null})`,
          guardianName: sql`coalesce(${players.guardianName}, ${g?.name ?? null})`,
          guardianEmail: sql`coalesce(${players.guardianEmail}, ${g?.email ?? null})`,
          guardianPhone: sql`coalesce(${players.guardianPhone}, ${g?.phone ?? null})`,
          emergencyContact: sql`coalesce(${players.emergencyContact}, ${mapped.emergencyContact ? `${mapped.emergencyContact.name}, ${mapped.emergencyContact.phone}` : null})`,
          updatedBy: opts.actorId ?? null,
        })
        .where(eq(players.id, playerId))
    : db.insert(players).values({
        id: playerId,
        firstName: person.firstName,
        lastName: person.lastName,
        email: person.email,
        phone: person.phone || null,
        birthYear: mapped.birthYear ?? null,
        guardianName: g?.name ?? null,
        guardianEmail: g?.email ?? null,
        guardianPhone: g?.phone ?? null,
        emergencyContact: mapped.emergencyContact ? `${mapped.emergencyContact.name}, ${mapped.emergencyContact.phone}` : null,
        notes: null,
        createdAt: at,
        updatedAt: at,
        updatedBy: opts.actorId ?? null,
      })

  const force = opts.forceStatus ?? null
  const pending = !force && opts.pendingUntil ? opts.pendingUntil : null
  const startStatus = pending ? ('pending_email' as const) : ('confirmed' as const)
  for (let attempt = 0; ; attempt++) {
    const reference = newReference()
    const settle =
      force === 'confirmed' || pending
        ? []
        : force === 'waitlist'
          ? settleStatements(
              db,
              { productId: product.id, registrationId, groupId },
              { capPlayers: -1, capTeams: -1, waitlistEnabled: true },
            )
          : settleStatements(db, { productId: product.id, registrationId, groupId }, eff)
    try {
      const results = await runBatch(db, [
        playerStatement,
        ...(groupId
          ? [
              db.insert(groups).values({
                id: groupId,
                kind: 'team',
                name: teamName!,
                captainPlayerId: playerId,
                productId: product.id,
                status: startStatus,
                answers: {},
                createdAt: at,
                updatedAt: at,
                updatedBy: opts.actorId ?? null,
              }),
            ]
          : []),
        db.insert(registrations).values({
          id: registrationId,
          productId: product.id,
          playerId,
          groupId,
          status: startStatus,
          reference,
          holdExpiresAt: pending,
          answers,
          vnswConfirmed: mapped.vnswConfirmed ?? false,
          freeAgent: entryType === 'free_agent',
          amountCents: eff.amountCents,
          formId: form.id,
          formVersion: form.version,
          source: opts.source,
          createdAt: at,
          updatedAt: at,
          updatedBy: opts.actorId ?? null,
        }),
        ...settle,
        // Refused for lack of room: don't leave a new player row behind.
        ...(!existing && !force && !pending && !eff.waitlistEnabled
          ? [
              db
                .delete(players)
                .where(and(eq(players.id, playerId), sql`not exists (select 1 from registrations r9 where r9.player_id = ${playerId})`)),
            ]
          : []),
        ...(opts.extra?.({ registrationId, groupId, reference }) ?? []),
        db.select({ status: registrations.status }).from(registrations).where(eq(registrations.id, registrationId)),
        // The place on the waitlist is read as a rank (stored positions keep gaps; core.ts waitlistRankSql).
        ...(groupId
          ? [
              db
                .select({ status: groups.status, position: sql<number>`${waitlistRankSql('group', product.id, groupId)}`.as('wl_rank') })
                .from(groups)
                .where(eq(groups.id, groupId)),
            ]
          : [
              db
                .select({
                  status: registrations.status,
                  position: sql<number>`${waitlistRankSql('registration', product.id, registrationId)}`.as('wl_rank'),
                })
                .from(registrations)
                .where(eq(registrations.id, registrationId)),
            ]),
      ])
      const last = results[results.length - 1] as { status: string; position: number | null }[]
      const reg = results[results.length - 2] as { status: string }[]
      if (reg.length === 0 || last.length === 0) {
        throw new HttpError(409, 'full', `${target.label} is full.`)
      }
      const row = last[0]!
      return {
        status: row.status === 'waitlist' ? 'waitlist' : row.status === 'pending_email' ? 'pending_email' : 'confirmed',
        reference,
        position: row.status === 'waitlist' ? Number(row.position) : null,
        registrationId,
        groupId,
        teamName,
        amountCents: eff.amountCents,
        message: form.confirmationText,
        programme: target.programme.name,
        target: target.label,
      }
    } catch (e) {
      if (isUniqueFailure(e, 'registrations.reference') && attempt < 4) continue
      if (isUniqueFailure(e, 'registrations.product_id')) throw duplicate(target)
      if (isUniqueFailure(e, 'groups.product_id')) throw teamTaken(teamName ?? '')
      throw e
    }
  }
}

/**
 * The confirmation or waitlist email for an entry that has (or waits for) a spot. Never throws. `priority` when it
 * follows an admin action or a confirmed address (mailer.ts), not an anonymous form.
 */
export async function emailNewEntry(
  db: AppDb,
  mailer: Pick<Mailer, 'sendEmail'>,
  to: string,
  firstName: string,
  r: Omit<EnrolResult, 'status'> & { status: EnrolStatus },
  opts: Pick<SendOptions, 'priority'> = {},
) {
  const base = { name: firstName, programme: r.programme, target: r.target, reference: r.reference, teamName: r.teamName }
  if (r.status === 'waitlist')
    return sendQuietly(() => mailer.sendEmail(to, 'enrolment.waitlisted', { ...base, position: r.position }, opts), 'waitlisted')
  const payid = r.amountCents ? (await getSettings(db)).payid : null
  return sendQuietly(
    () =>
      mailer.sendEmail(
        to,
        'enrolment.confirmed',
        {
          ...base,
          amount: r.amountCents ? formatAud(r.amountCents) : null,
          payid: payid?.payId ? payid : null,
          message: r.message,
        },
        opts,
      ),
    'confirmation',
  )
}

/** The "confirm your email address" email for a pending entry. Never throws. */
export async function emailConfirmLink(
  deps: { mailer: Pick<Mailer, 'sendEmail'>; secret: string; siteUrl: string },
  to: string,
  entry: {
    firstName: string
    programme: string
    target: string
    teamName: string | null
    registrationId: string
    createdAt: string
    expiresAt: string
  },
  opts: Pick<SendOptions, 'priority'> = {},
) {
  const token = await confirmToken(deps.secret, { id: entry.registrationId, createdAt: entry.createdAt })
  return sendQuietly(
    () =>
      deps.mailer.sendEmail(
        to,
        'enrolment.confirm_email',
        {
          name: entry.firstName,
          programme: entry.programme,
          target: entry.target,
          teamName: entry.teamName,
          url: confirmUrl(deps.siteUrl, token),
          expiresAt: entry.expiresAt,
        },
        opts,
      ),
    'confirm-email',
  )
}

// ── The public form ───────────────────────────────────────────────────────────

export type PublicEnrolDeps = {
  db: AppDb
  mailer: Pick<Mailer, 'sendEmail'>
  /** Null when Turnstile isn't configured (production without keys): enrolment is refused. */
  turnstileSecret: string | null
  /** The site's hostname, checked against Turnstile's answer (null with the test keys, which answer example.com). */
  turnstileHostname?: string | null
  ip: string | null
  /**
   * BETTER_AUTH_SECRET: signs the confirm links (with its own key label) and salts the rate-limit keys, so the
   * stored hashes can't be reversed to IPs or emails. Required.
   */
  secret: string
  /** For the confirm link. */
  siteUrl: string
  fetch?: typeof fetch
  now?: Date
}

export type PublicEnrolInput = {
  target?: unknown
  entryType?: unknown
  person?: unknown
  answers?: unknown
  turnstileToken?: unknown
}

/**
 * What the public form gets back. `pending_email`: check your inbox (no reference yet). `emailed`: a repeat of an
 * entry that already exists, where no confirmation is asked for; its reference went to the address on file.
 * A repeat where confirmation is asked for answers exactly like a new entry (pending_email), so the form can't be
 * used to find out who is enrolled.
 */
export type PublicEnrolResult = Omit<
  Pick<EnrolResult, 'status' | 'reference' | 'position' | 'teamName' | 'amountCents' | 'message' | 'programme' | 'target'>,
  'status' | 'reference'
> & { status: EnrolResult['status'] | 'emailed'; reference: string | null; confirmHours?: number }

const rateLimited = (retryAfter: number) =>
  new HttpError(429, 'rate_limited', 'Too many enrolments from here just now. Please wait a while and try again.', { retryAfter })

/**
 * POST /api/enrol. IP limit → Turnstile → email limits → target open? → validate → createEntry (pending_email when
 * the target asks for email confirmation) → email (the confirm link, or the confirmation).
 */
export async function submitPublicEnrolment(deps: PublicEnrolDeps, input: PublicEnrolInput): Promise<PublicEnrolResult> {
  const { db } = deps
  const now = deps.now ?? new Date()
  if (!deps.secret) throw new Error('submitPublicEnrolment: no secret (BETTER_AUTH_SECRET is not set)')
  if (!deps.turnstileSecret)
    throw new HttpError(503, 'unavailable', 'Online enrolment is unavailable right now. Please contact us to enrol.')
  const ref = parseRef(input.target)
  if (JSON.stringify(input.answers ?? {}).length > MAX_ANSWERS_BYTES)
    throw new HttpError(413, 'too_large', 'Those answers are too long. Please shorten them and try again.')

  // Only the IP is counted before Turnstile: a request without a solved check can't use up someone's email limit.
  if (deps.ip) {
    const byIp = await hit(
      db,
      [{ key: `enrol:ip:${await hashKey(deps.ip, deps.secret)}`, max: ENROL_LIMITS.perIpHour, windowMs: HOUR }],
      now,
    )
    if (!byIp.ok) throw rateLimited(byIp.retryAfter)
  }

  const human = await verifyTurnstile(deps.turnstileSecret, input.turnstileToken, deps.ip, deps.fetch, {
    hostname: deps.turnstileHostname ?? null,
  })
  if (!human.ok) throw new HttpError(403, 'turnstile_failed', 'Please complete the "are you human" check and try again.')

  const email = normaliseEmail((input.person as { email?: unknown } | undefined)?.email)
  if (email) {
    // On the mailbox, so +tags and Gmail dots don't get round it.
    const h = await hashKey(canonicalMailbox(email), deps.secret)
    const limits: Limit[] = [
      { key: `enrol:email:${h}`, max: ENROL_LIMITS.perEmailHour, windowMs: HOUR },
      { key: `enrol:email-day:${h}`, max: ENROL_LIMITS.perEmailDay, windowMs: 24 * HOUR },
    ]
    const byEmail = await hit(db, limits, now)
    if (!byEmail.ok) throw rateLimited(byEmail.retryAfter)
  }

  const target = await loadTarget(db, ref, sydneyDate(now))
  if (!target || target.programme.status === 'draft') throw notFound('programme')
  if (!isOpen(target, now.toISOString()))
    throw new HttpError(409, 'closed', target.closedReason ?? `Enrolment for ${target.label} is closed.`)
  const eff = effective(target.programme, target.product)
  const entryType = parseEntryType(input.entryType, entryTypesFor(target.programme.kind, eff))
  const form = await resolveForm(db, eff.formId, target.programme.kind)
  const check = validateEnrolment(form.fields, entryType, input.person, input.answers, {
    currentYear: Number(sydneyDate(now).slice(0, 4)),
    ageMin: target.programme.ageMin,
    ageMax: target.programme.ageMax,
  })
  if (!check.ok) throw invalid('Please check the highlighted answers.', { fieldErrors: check.errors })
  if (!eff.waitlistEnabled && eff.capPlayers === 0) throw new HttpError(409, 'full', `${target.label} is full.`)

  const confirmHours = eff.emailConfirm ? (await getSettings(db)).enrolment.confirmHours : 0
  const pendingUntil = eff.emailConfirm ? new Date(now.getTime() + confirmHours * HOUR).toISOString() : null
  const teamName = entryType === 'team' ? (check.mapped.teamName ?? '').trim() || null : null
  const pendingAnswer: PublicEnrolResult = {
    status: 'pending_email',
    reference: null,
    position: null,
    teamName,
    amountCents: eff.amountCents,
    message: null,
    programme: target.programme.name,
    target: target.label,
    confirmHours,
  }
  const emailDeps = { mailer: deps.mailer, secret: deps.secret, siteUrl: deps.siteUrl }

  let result: EnrolResult
  try {
    result = await createEntry(db, target, eff, form, entryType, check, { source: 'public', now, pendingUntil })
  } catch (e) {
    if (!(e instanceof DuplicateEntryError)) throw e
    // Don't say so on the page (that would tell anyone who is enrolled): email the address on file instead.
    await emailExisting(db, emailDeps, target, check.person, e.existing, now)
    return eff.emailConfirm ? pendingAnswer : { ...pendingAnswer, status: 'emailed', confirmHours: undefined }
  }
  if (result.status === 'pending_email') {
    await emailConfirmLink(emailDeps, check.person.email, {
      firstName: check.person.firstName,
      programme: result.programme,
      target: result.target,
      teamName: result.teamName,
      registrationId: result.registrationId,
      createdAt: now.toISOString(),
      expiresAt: pendingUntil!,
    })
    return pendingAnswer
  }
  await emailNewEntry(db, deps.mailer, check.person.email, check.person.firstName, { ...result, status: result.status })
  return {
    status: result.status,
    reference: result.reference,
    position: result.position,
    teamName: result.teamName,
    amountCents: result.amountCents,
    message: result.message,
    programme: result.programme,
    target: result.target,
  }
}

/**
 * A repeat submission of an entry that exists: a pending one gets its confirm link again (same link, same
 * deadline); any other gets an "already enrolled" email with its reference. Sent to the submitted address, which
 * is the address on file (duplicates match on it). Never throws.
 */
async function emailExisting(
  db: AppDb,
  deps: { mailer: Pick<Mailer, 'sendEmail'>; secret: string; siteUrl: string },
  target: Target,
  person: PersonInput,
  existing: ExistingEntry | null,
  now: Date,
) {
  if (!existing) return false
  const teamName =
    existing.groupId && !existing.freeAgent
      ? ((await db.select({ name: groups.name }).from(groups).where(eq(groups.id, existing.groupId)).get())?.name ?? null)
      : null
  const what = { programme: target.programme.name, target: target.label }
  if (existing.status === 'pending_email') {
    const until = existing.holdExpiresAt
    if (!until || until <= now.toISOString()) return false
    return emailConfirmLink(deps, person.email, {
      firstName: person.firstName,
      ...what,
      teamName,
      registrationId: existing.registrationId,
      createdAt: existing.createdAt,
      expiresAt: until,
    })
  }
  const state = existing.status === 'waitlist' ? 'waitlist' : existing.status === 'offered' ? 'offered' : 'confirmed'
  const position =
    state === 'waitlist' && target.product
      ? Number(
          (
            await db
              .select({
                rank: sql<number>`${waitlistRankSql(existing.groupId && !existing.freeAgent ? 'group' : 'registration', target.product.id, existing.groupId && !existing.freeAgent ? existing.groupId : existing.registrationId)}`,
              })
              .from(registrations)
              .where(eq(registrations.id, existing.registrationId))
              .get()
          )?.rank ?? 0,
        ) || null
      : null
  return sendQuietly(
    () =>
      deps.mailer.sendEmail(person.email, 'enrolment.already', {
        name: person.firstName,
        ...what,
        reference: existing.reference,
        state,
        position,
        teamName,
      }),
    'already-enrolled',
  )
}
