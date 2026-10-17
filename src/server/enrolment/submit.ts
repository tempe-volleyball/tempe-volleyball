import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { formatAud, sydneyDate } from '../../lib/time'
import { entryTypesFor } from '../../lib/enrolment/defaults'
import { formEntryTypes, type FormEntryType } from '../../lib/enrolment/forms'
import { newReference } from '../../lib/enrolment/reference'
import { isTargetKind, type TargetRef } from '../../lib/enrolment/targets'
import { normaliseEmail, validateEnrolment, type MappedAnswers, type PersonInput } from '../../lib/enrolment/validate'
import { runBatch, type AppDb } from '../db'
import { closedRegistrationStatuses, groups, players, registrations, type RegistrationSource } from '../db/schema'
import { isUniqueFailure } from '../content/common'
import { getSettings } from '../content/settings'
import type { Mailer } from '../email'
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
  type Effective,
  type ResolvedForm,
  type Target,
} from './core'

// Taking an enrolment: the public form (POST /api/enrol) and the admin's "Add enrolment". Both go through
// createEntry(), which matches or creates the player, inserts the entry holding a spot and settles it against the
// caps in the same batch (core.ts), so the last spot can't be taken twice.

/** Public form limits (fixed windows, counted before Turnstile so a flood costs one upsert each). */
export const ENROL_LIMITS = {
  perIpHour: 20,
  perEmailHour: 6,
  perEmailDay: 15,
} as const

const HOUR = 3_600_000

export type EnrolStatus = 'confirmed' | 'waitlist'

export type EnrolResult = {
  status: EnrolStatus
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
      liveReference: registrations.reference,
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

const duplicate = (target: Target) =>
  new HttpError(
    409,
    'duplicate',
    `You're already enrolled in ${target.label}. Check your email for the confirmation, or contact us to change it.`,
  )

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
  if (existing?.liveReference) throw duplicate(target)

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
  for (let attempt = 0; ; attempt++) {
    const reference = newReference()
    const settle =
      force === 'confirmed'
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
                status: 'confirmed',
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
          status: 'confirmed',
          reference,
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
        ...(!existing && !force && !eff.waitlistEnabled
          ? [
              db
                .delete(players)
                .where(and(eq(players.id, playerId), sql`not exists (select 1 from registrations r9 where r9.player_id = ${playerId})`)),
            ]
          : []),
        ...(opts.extra?.({ registrationId, groupId, reference }) ?? []),
        db.select({ status: registrations.status }).from(registrations).where(eq(registrations.id, registrationId)),
        ...(groupId
          ? [db.select({ status: groups.status, position: groups.waitlistPosition }).from(groups).where(eq(groups.id, groupId))]
          : [
              db
                .select({ status: registrations.status, position: registrations.waitlistPosition })
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
        status: row.status === 'waitlist' ? 'waitlist' : 'confirmed',
        reference,
        position: row.status === 'waitlist' ? row.position : null,
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

/** The confirmation or waitlist email for a new entry. Never throws. */
export async function emailNewEntry(db: AppDb, mailer: Pick<Mailer, 'sendEmail'>, to: string, firstName: string, r: EnrolResult) {
  const base = { name: firstName, programme: r.programme, target: r.target, reference: r.reference, teamName: r.teamName }
  if (r.status === 'waitlist')
    return sendQuietly(() => mailer.sendEmail(to, 'enrolment.waitlisted', { ...base, position: r.position }), 'waitlisted')
  const payid = r.amountCents ? (await getSettings(db)).payid : null
  return sendQuietly(
    () =>
      mailer.sendEmail(to, 'enrolment.confirmed', {
        ...base,
        amount: r.amountCents ? formatAud(r.amountCents) : null,
        payid: payid?.payId ? payid : null,
        message: r.message,
      }),
    'confirmation',
  )
}

// ── The public form ───────────────────────────────────────────────────────────

export type PublicEnrolDeps = {
  db: AppDb
  mailer: Pick<Mailer, 'sendEmail'>
  /** Null when Turnstile isn't configured (production without keys): enrolment is refused. */
  turnstileSecret: string | null
  ip: string | null
  /** Salts the rate-limit keys (BETTER_AUTH_SECRET), so the stored hashes can't be reversed to IPs or emails. */
  hashSalt?: string
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

/** What the public form gets back. */
export type PublicEnrolResult = Pick<
  EnrolResult,
  'status' | 'reference' | 'position' | 'teamName' | 'amountCents' | 'message' | 'programme' | 'target'
>

/** POST /api/enrol. Rate limit → Turnstile → target open? → validate → createEntry → email. */
export async function submitPublicEnrolment(deps: PublicEnrolDeps, input: PublicEnrolInput): Promise<PublicEnrolResult> {
  const { db } = deps
  const now = deps.now ?? new Date()
  if (!deps.turnstileSecret)
    throw new HttpError(503, 'unavailable', 'Online enrolment is unavailable right now. Please contact us to enrol.')
  const ref = parseRef(input.target)

  const email = normaliseEmail((input.person as { email?: unknown } | undefined)?.email)
  const limits: Limit[] = []
  if (deps.ip) limits.push({ key: `enrol:ip:${await hashKey(deps.ip, deps.hashSalt)}`, max: ENROL_LIMITS.perIpHour, windowMs: HOUR })
  if (email) {
    const h = await hashKey(email, deps.hashSalt)
    limits.push({ key: `enrol:email:${h}`, max: ENROL_LIMITS.perEmailHour, windowMs: HOUR })
    limits.push({ key: `enrol:email-day:${h}`, max: ENROL_LIMITS.perEmailDay, windowMs: 24 * HOUR })
  }
  const limited = await hit(db, limits, now)
  if (!limited.ok)
    throw new HttpError(429, 'rate_limited', 'Too many enrolments from here just now. Please wait a while and try again.', {
      retryAfter: limited.retryAfter,
    })

  const human = await verifyTurnstile(deps.turnstileSecret, input.turnstileToken, deps.ip, deps.fetch)
  if (!human.ok) throw new HttpError(403, 'turnstile_failed', 'Please complete the "are you human" check and try again.')

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

  const result = await createEntry(db, target, eff, form, entryType, check, { source: 'public', now })
  await emailNewEntry(db, deps.mailer, check.person.email, check.person.firstName, result)
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
