import { asc, eq, ne } from 'drizzle-orm'
import { readSettings, type MemberDetailKey, type MemberFieldMode, settingKeys } from '../../lib/content/settings'
import { defaultInterestFields } from '../../lib/enrolment/defaults'
import { activeFields, GENDER_OPTIONS, type FormEntryType, type FormField } from '../../lib/enrolment/forms'
import {
  answerText,
  canonicalMailbox,
  isDisplayOnly,
  normaliseEmail,
  validateEnrolment,
  visibleFields,
  type FieldErrors,
  type MappedAnswers,
} from '../../lib/enrolment/validate'
import { checkMembers, depositFor, formatDeposit, takesInterest } from '../../lib/interest'
import { nextStartsLine, scheduleText, summaryLine, venueText } from '../../lib/programme-text'
import { sydneyDate } from '../../lib/time'
import { runBatch, type AppDb } from '../db'
import {
  categories,
  enrolmentForms,
  programmes,
  siteSettings,
  venues,
  type Gender,
  type MemberDetails,
  type PlayerPool,
  type Programme,
  type ProgrammeKind,
} from '../db/schema'
import type { Mailer } from '../email'
import type { InterestEmail } from '../email/templates'
import { HttpError } from '../http'
import { getSettings } from '../content/settings'
import { describeError } from '../log'
import { createInterest } from '../players/core'
import { nextInstanceMap, nextInstanceQueries } from '../programmes/programmes'
import { hashKey, hit, type Limit } from '../ratelimit'
import { TURNSTILE_ACTIONS, verifyTurnstile } from '../turnstile'

// The public expression-of-interest form (docs/interest.md, docs/api/interest.md): what /interest and
// /interest/<slug> show (loadInterestForm, for the <InterestForm> island), and POST /api/interest (submitInterest).
//
// The form isn't personal, so its pages are edge-cached; answers only ever go to the API (never cached, never in a
// URL). Submitting mirrors the contact and enrolment forms: IP limit → honeypot → Turnstile → mailbox limit →
// validation → one batch (createInterest) → notification and acknowledgement emails through the outbox. The page's
// answer is always the same, so the form can't tell anyone whether a person has sent one before; the reference is
// only in the acknowledgement email.

/** Public form limits (fixed windows). Only the IP is counted before Turnstile, as on the other forms. */
export const INTEREST_RATE = { perIpHour: 10, perEmailHour: 5, perEmailDay: 10 } as const

const HOUR = 3_600_000

/** The largest answers (JSON) one EOI may carry, as for enrolment. */
export const MAX_INTEREST_ANSWERS_BYTES = 32 * 1024

/** The most programme ids a request may name (far above any real list). */
const MAX_PROGRAMME_IDS = 50

/** One programme on the form. */
export type InterestProgrammeOption = {
  id: string
  slug: string
  kind: ProgrammeKind
  name: string
  code: string
  /** The summary line, as on cards ("Thursday Night League (TNL) @ … , Thursdays 8–10pm"). */
  summary: string
  schedule: string
  venue: string
  /** "Next season starts Thursday 15 January 2027", or ''. */
  nextStarts: string
  depositPlayerCents: number | null
  depositTeamCents: number | null
}

export type InterestFormProps = {
  /** The offered programmes by category (category order, then programme order); no category last, as `null`. */
  groups: { category: { id: string; name: string } | null; programmes: InterestProgrammeOption[] }[]
  /** Ticked to start with (/interest/<slug>). */
  preselectedId: string | null
  /** Settings → PayID, when a PayID is set (deposits are paid that way). */
  payid: { name: string; payId: string } | null
  /** The questions (active, without team_name: the team name is the form's own field). */
  fields: FormField[]
  formId: string | null
  formVersion: number | null
  /** The form's confirmation text (shown after sending, and in the email). */
  confirmationText: string | null
  /** 0 = no limit. */
  maxProgrammes: number
  /** Counting the captain. */
  maxMembers: number
  memberFields: Record<MemberDetailKey, MemberFieldMode>
  introText: string
  successText: string
  /** Null = the form is unavailable (production without Turnstile keys). */
  turnstileSiteKey: string | null
  /** Where the form posts (default /api/interest). */
  endpoint?: string
}

/** What a page asked about the slug in its URL: offered, a real programme not taking EOIs (301), or none (404). */
export type SlugStatus = 'offered' | 'not_offered' | 'unknown'

export type InterestFormLoad = {
  form: InterestFormProps
  /** Only with a programmeSlug. */
  slug: { status: SlugStatus; programme: InterestProgrammeOption | null } | null
  /** How many programmes are offered (0: the page says nothing is taking EOIs right now). */
  offered: number
}

type ProgrammeRow = Pick<
  Programme,
  | 'id'
  | 'kind'
  | 'code'
  | 'name'
  | 'slug'
  | 'status'
  | 'categoryId'
  | 'sort'
  | 'weekday'
  | 'startTime'
  | 'endTime'
  | 'scheduleLabel'
  | 'summaryLine'
  | 'nextStartsOn'
  | 'nextStartsText'
  | 'defaultVenueId'
  | 'signupMode'
  | 'interestOpen'
  | 'depositPlayerCents'
  | 'depositTeamCents'
>

const programmeColumns = {
  id: programmes.id,
  kind: programmes.kind,
  code: programmes.code,
  name: programmes.name,
  slug: programmes.slug,
  status: programmes.status,
  categoryId: programmes.categoryId,
  sort: programmes.sort,
  weekday: programmes.weekday,
  startTime: programmes.startTime,
  endTime: programmes.endTime,
  scheduleLabel: programmes.scheduleLabel,
  summaryLine: programmes.summaryLine,
  nextStartsOn: programmes.nextStartsOn,
  nextStartsText: programmes.nextStartsText,
  defaultVenueId: programmes.defaultVenueId,
  signupMode: programmes.signupMode,
  interestOpen: programmes.interestOpen,
  depositPlayerCents: programmes.depositPlayerCents,
  depositTeamCents: programmes.depositTeamCents,
}

/** The questions the EOI form asks: the chosen enrolment form's (active, minus team_name), else the built-in default. */
export function interestFields(form: { fields: FormField[] } | null | undefined): FormField[] {
  return activeFields(form ? form.fields : defaultInterestFields()).filter((f) => f.type !== 'team_name')
}

type Offering = {
  rows: ProgrammeRow[]
  offered: ProgrammeRow[]
  options: Map<string, InterestProgrammeOption>
  groups: InterestFormProps['groups']
  settings: ReturnType<typeof readSettings>
  form: { id: string; version: number; fields: FormField[]; confirmationText: string | null } | null
}

/**
 * Programmes, categories, venues, next start dates and settings in one batch, then the chosen form (a second query
 * only when Settings → Interest names one). Draft programmes are never read.
 */
async function loadOffering(db: AppDb, now: Date): Promise<Offering> {
  const today = sydneyDate(now)
  const [rows, cats, vens, settingRows, ...dates] = (await runBatch(db, [
    db.select(programmeColumns).from(programmes).where(ne(programmes.status, 'draft')).orderBy(asc(programmes.sort), asc(programmes.name)),
    db
      .select({ id: categories.id, name: categories.name, status: categories.status })
      .from(categories)
      .orderBy(asc(categories.sort), asc(categories.name)),
    db.select({ id: venues.id, name: venues.name, address: venues.address }).from(venues),
    db.select({ key: siteSettings.key, value: siteSettings.value }).from(siteSettings),
    ...nextInstanceQueries(db, today),
  ])) as unknown as [
    ProgrammeRow[],
    { id: string; name: string; status: string }[],
    { id: string; name: string; address: string | null }[],
    { key: string; value: unknown }[],
    ...{ programmeId: string; date: string | null }[][],
  ]
  const settings = readSettings(settingRows.filter((r) => (settingKeys as readonly string[]).includes(r.key)))
  const next = nextInstanceMap(dates)
  const venueById = new Map(vens.map((v) => [v.id, v]))
  const offered = rows.filter((p) => takesInterest(p))
  const options = new Map<string, InterestProgrammeOption>()
  for (const p of rows) {
    const venue = (p.defaultVenueId && venueById.get(p.defaultVenueId)) || null
    options.set(p.id, {
      id: p.id,
      slug: p.slug,
      kind: p.kind,
      name: p.name,
      code: p.code,
      summary: summaryLine(p, venue),
      schedule: scheduleText(p),
      venue: venueText(venue),
      nextStarts: nextStartsLine(p, next.get(p.id) ?? null),
      depositPlayerCents: p.depositPlayerCents,
      depositTeamCents: p.depositTeamCents,
    })
  }
  const publicCats = cats.filter((c) => c.status !== 'draft')
  const groups: InterestFormProps['groups'] = publicCats
    .map((c) => ({
      category: { id: c.id, name: c.name },
      programmes: offered.filter((p) => p.categoryId === c.id).map((p) => options.get(p.id)!),
    }))
    .filter((g) => g.programmes.length > 0)
  const known = new Set(publicCats.map((c) => c.id))
  const rest = offered.filter((p) => !p.categoryId || !known.has(p.categoryId))
  if (rest.length) groups.push({ category: null, programmes: rest.map((p) => options.get(p.id)!) })

  const formId = settings.interest.formId
  const formRow = formId
    ? await db
        .select({
          id: enrolmentForms.id,
          version: enrolmentForms.version,
          fields: enrolmentForms.fields,
          confirmationText: enrolmentForms.confirmationText,
          archivedAt: enrolmentForms.archivedAt,
        })
        .from(enrolmentForms)
        .where(eq(enrolmentForms.id, formId))
        .get()
    : undefined
  // A missing or archived form falls back to the built-in questions, so the form never breaks.
  const form = formRow && !formRow.archivedAt ? formRow : null
  return { rows, offered, options, groups, settings, form }
}

/**
 * The props for the EOI form island, and (with `programmeSlug`) what the URL's slug is: offered (ticked), a real
 * programme that isn't taking EOIs (the page 301s to /interest) or unknown (404; drafts count as unknown). Two
 * round trips at most.
 */
export async function loadInterestForm(
  db: AppDb,
  now = new Date(),
  opts: { programmeSlug?: string | null; turnstileSiteKey?: string | null } = {},
): Promise<InterestFormLoad> {
  const o = await loadOffering(db, now)
  const slug = opts.programmeSlug?.toLowerCase() ?? null
  const match = slug ? o.rows.find((p) => p.slug === slug) : undefined
  const preselected = match && o.offered.some((p) => p.id === match.id) ? match : undefined
  const s = o.settings
  return {
    form: {
      groups: o.groups,
      preselectedId: preselected?.id ?? null,
      payid: s.payid.payId.trim() ? { name: s.payid.name, payId: s.payid.payId } : null,
      fields: interestFields(o.form),
      formId: o.form?.id ?? null,
      formVersion: o.form?.version ?? null,
      confirmationText: o.form?.confirmationText ?? null,
      maxProgrammes: s.interest.maxProgrammes,
      maxMembers: s.interest.maxMembers,
      memberFields: s.interest.memberFields,
      introText: s.interest.introText,
      successText: s.interest.successText,
      turnstileSiteKey: opts.turnstileSiteKey ?? null,
    },
    slug: slug
      ? {
          status: preselected ? 'offered' : match ? 'not_offered' : 'unknown',
          programme: preselected ? o.options.get(preselected.id)! : null,
        }
      : null,
    offered: o.offered.length,
  }
}

// ── POST /api/interest ────────────────────────────────────────────────────────

export type PublicInterestDeps = {
  db: AppDb
  mailer: Pick<Mailer, 'sendEmail'>
  /** BETTER_AUTH_SECRET: salts the rate-limit keys. */
  secret: string | undefined
  /** For the "open in the admin" link. */
  siteUrl: string
  /** Null when Turnstile isn't configured (production without keys): the form is unavailable. */
  turnstileSecret: string | null
  /** The host a real token must have been solved on (null with the test keys). */
  turnstileHostname?: string | null
  ip: string | null
  fetch?: typeof fetch
  now?: Date
}

export type InterestInput = {
  kind?: unknown
  programmeIds?: unknown
  person?: unknown
  answers?: unknown
  teamName?: unknown
  members?: unknown
  /** Honeypot: people never see it, so anything in it is a bot. */
  website?: unknown
  turnstileToken?: unknown
}

export type InterestResult = {
  status: 'sent'
  /** Settings → Interest's thank-you text. */
  message: string
  /** The form's confirmation text, if it has one. */
  confirmationText: string | null
  /** When the programmes picked ask for one. The reference to pay with is only in the email. */
  deposit: { cents: number; amount: string; payid: { name: string; payId: string } | null; emailed: boolean } | null
}

const rateLimited = (retryAfter: number) =>
  new HttpError(429, 'rate_limited', 'Too many forms from here just now. Please wait a while and try again, or email us.', { retryAfter })

const invalid = (fieldErrors: FieldErrors, message = 'Please check the highlighted answers.') =>
  new HttpError(400, 'invalid_input', message, { fieldErrors })

const oneLine = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '')

/** The answers as "label: value" lines for the emails, in form order, the mapped questions included. */
export function answerLines(
  fields: readonly FormField[],
  entryType: FormEntryType,
  answers: Record<string, unknown>,
  mapped: MappedAnswers,
) {
  const out: { label: string; value: string }[] = []
  for (const f of visibleFields(fields, entryType, answers)) {
    if (isDisplayOnly(f.type)) continue
    let value = ''
    switch (f.type) {
      case 'birth_year':
        value = mapped.birthYear ? String(mapped.birthYear) : ''
        break
      case 'gender':
        value = GENDER_OPTIONS.find((o) => o.value === mapped.gender)?.label ?? ''
        break
      case 'suburb':
        value = mapped.suburb ?? ''
        break
      case 'vnsw_number':
        value = mapped.vnswNumber ?? ''
        break
      case 'vnsw_membership':
        value = mapped.vnswConfirmed ? 'Yes' : 'No'
        break
      case 'guardian':
        value = mapped.guardian ? `${mapped.guardian.name}, ${mapped.guardian.email}, ${mapped.guardian.phone}` : ''
        break
      case 'emergency_contact':
        value = mapped.emergencyContact ? `${mapped.emergencyContact.name}, ${mapped.emergencyContact.phone}` : ''
        break
      default:
        value = answerText(f, answers[f.key])
    }
    if (value) out.push({ label: f.label, value })
  }
  return out
}

/** POST /api/interest. Answers the same for every accepted form (and a discarded bot), so it gives nothing away. */
export async function submitInterest(deps: PublicInterestDeps, input: InterestInput): Promise<InterestResult> {
  const { db } = deps
  const now = deps.now ?? new Date()
  if (!deps.secret) throw new Error('submitInterest: no secret (BETTER_AUTH_SECRET is not set)')
  if (!deps.turnstileSecret)
    throw new HttpError(503, 'unavailable', 'The form is unavailable right now. Please email or phone us to tell us you’re interested.')
  if (
    JSON.stringify(input.answers ?? {}).length > MAX_INTEREST_ANSWERS_BYTES ||
    JSON.stringify(input.members ?? []).length > MAX_INTEREST_ANSWERS_BYTES
  )
    throw new HttpError(413, 'too_large', 'Those answers are too long. Please shorten them and try again.')

  if (deps.ip) {
    const byIp = await hit(
      db,
      [{ key: `interest:ip:${await hashKey(deps.ip, deps.secret)}`, max: INTEREST_RATE.perIpHour, windowMs: HOUR }],
      now,
    )
    if (!byIp.ok) throw rateLimited(byIp.retryAfter)
  }

  const generic: InterestResult = { status: 'sent', message: '', confirmationText: null, deposit: null }
  // A filled-in hidden field is a bot: say "sent" and keep nothing (no Turnstile call, no row, no email).
  if (typeof input.website === 'string' && input.website.trim()) {
    return { ...generic, message: (await getSettings(db)).interest.successText }
  }

  const human = await verifyTurnstile(deps.turnstileSecret, input.turnstileToken, deps.ip, deps.fetch, {
    hostname: deps.turnstileHostname ?? null,
    action: deps.turnstileHostname ? TURNSTILE_ACTIONS.interest : null,
  })
  if (!human.ok) throw new HttpError(403, 'turnstile_failed', 'Please complete the "are you human" check and try again.')

  const email = normaliseEmail((input.person as { email?: unknown } | undefined)?.email)
  if (email) {
    // On the mailbox, so +tags and Gmail dots don't get round it.
    const h = await hashKey(canonicalMailbox(email), deps.secret)
    const limits: Limit[] = [
      { key: `interest:email:${h}`, max: INTEREST_RATE.perEmailHour, windowMs: HOUR },
      { key: `interest:email-day:${h}`, max: INTEREST_RATE.perEmailDay, windowMs: 24 * HOUR },
    ]
    const byEmail = await hit(db, limits, now)
    if (!byEmail.ok) throw rateLimited(byEmail.retryAfter)
  }

  const o = await loadOffering(db, now)
  const s = o.settings.interest
  const errors: FieldErrors = {}

  const kind = input.kind === 'team' ? 'team' : input.kind === 'player' ? 'player' : null
  if (!kind) errors.kind = 'Choose whether you’re entering on your own or as a team.'

  // Programmes: each must be offered now; at least one; at most Settings → Interest's limit.
  const ids = Array.isArray(input.programmeIds)
    ? [...new Set(input.programmeIds.filter((v): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)))]
    : []
  const offeredById = new Map(o.offered.map((p) => [p.id, p]))
  const picked = ids.slice(0, MAX_PROGRAMME_IDS).map((id) => offeredById.get(id))
  if (ids.length === 0) errors.programmes = o.offered.length ? 'Tick at least one.' : 'Nothing is taking expressions of interest right now.'
  else if (ids.length > MAX_PROGRAMME_IDS || picked.some((p) => !p))
    errors.programmes = 'Something you ticked isn’t taking expressions of interest any more. Reload the page and try again.'
  else if (s.maxProgrammes > 0 && ids.length > s.maxProgrammes) errors.programmes = `Tick at most ${s.maxProgrammes}.`
  const chosen = picked.filter((p): p is ProgrammeRow => !!p)

  const fields = interestFields(o.form)
  const entryType: FormEntryType = kind === 'team' ? 'team' : 'free_agent'
  const currentYear = Number(sydneyDate(now).slice(0, 4))
  const check = validateEnrolment(fields, entryType, input.person, input.answers, { currentYear })
  if (!check.ok) Object.assign(errors, check.errors)

  let teamName: string | null = null
  if (kind === 'team') {
    teamName = oneLine(input.teamName)
    if (!teamName) errors.teamName = 'Enter your team’s name.'
    else if (teamName.length > 80) errors.teamName = 'Too long (at most 80 characters).'
  }
  const members = kind === 'team' ? checkMembers(input.members, s.memberFields, { max: Math.max(0, s.maxMembers - 1), currentYear }) : null
  if (members && !members.ok) Object.assign(errors, members.errors)

  if (Object.keys(errors).length > 0 || !check.ok || !kind || (members && !members.ok)) throw invalid(errors)

  const { person, answers, mapped } = check
  const contact: MemberDetails = {
    firstName: person.firstName,
    lastName: person.lastName,
    email: person.email,
    phone: person.phone || null,
    gender: (mapped.gender as Gender | undefined) ?? null,
    birthYear: mapped.birthYear ?? null,
    suburb: mapped.suburb ?? null,
    vnswNumber: mapped.vnswNumber ?? null,
    guardianName: mapped.guardian?.name ?? null,
    guardianEmail: mapped.guardian?.email ?? null,
    guardianPhone: mapped.guardian?.phone ?? null,
    emergencyContact: mapped.emergencyContact ? `${mapped.emergencyContact.name}, ${mapped.emergencyContact.phone}` : null,
  }
  const others: MemberDetails[] = (members?.ok ? members.members : []).map((m) => ({
    firstName: m.firstName,
    lastName: m.lastName,
    email: m.email,
    phone: m.phone,
    gender: m.gender as Gender | null,
    birthYear: m.birthYear,
    suburb: null,
    vnswNumber: m.vnswNumber,
    guardianName: null,
    guardianEmail: null,
    guardianPhone: null,
    emergencyContact: null,
  }))
  // Competition players are kept apart from training players (docs/interest.md): leagues and events win.
  const pool: PlayerPool = chosen.some((p) => p.kind === 'league' || p.kind === 'event') ? 'competition' : 'training'
  const depositCents = depositFor(kind, chosen)
  const created = await createInterest(db, {
    kind,
    pool,
    teamName,
    members: [contact, ...others],
    programmeIds: chosen.map((p) => p.id),
    answers,
    formId: o.form?.id ?? null,
    formVersion: o.form?.version ?? null,
    depositCents,
    source: 'public',
    now,
  })

  const payidSettings = o.settings.payid
  const payid = payidSettings.payId.trim() ? payidSettings : null
  const emailData: InterestEmail = {
    name: person.firstName,
    reference: created.reference,
    kind,
    teamName,
    programmes: chosen.map((p) => p.name),
    answers: answerLines(fields, entryType, answers, mapped),
    members: others.map((m) => [`${m.firstName} ${m.lastName}`, m.email, m.phone].filter(Boolean).join(', ')),
    deposit: depositCents ? formatDeposit(depositCents) : null,
    payid,
  }

  await notify(
    deps,
    o.settings.contact.email,
    s,
    emailData,
    { id: created.id, email: person.email, phone: person.phone, at: created.createdAt },
    now,
  )
  if (s.acknowledge)
    await quietly(
      () =>
        deps.mailer.sendEmail(person.email, 'interest.ack', {
          ...emailData,
          text: s.successText,
          message: o.form?.confirmationText ?? null,
        }),
      'acknowledgement',
    )

  return {
    status: 'sent',
    message: s.successText,
    confirmationText: o.form?.confirmationText ?? null,
    deposit: depositCents
      ? {
          cents: depositCents,
          amount: formatDeposit(depositCents),
          payid: payid ? { name: payid.name, payId: payid.payId } : null,
          emailed: s.acknowledge,
        }
      : null,
  }
}

/** The organiser's addresses: Settings → Interest → Notify, else the contact email (as the contact form does), each once. */
export const interestNotifyAddresses = (contactEmail: string, notifyEmails: readonly string[]) => [
  ...new Set((notifyEmails.length > 0 ? notifyEmails : [contactEmail]).map((e) => e.trim().toLowerCase()).filter(Boolean)),
]

async function notify(
  deps: PublicInterestDeps,
  contactEmail: string,
  s: { notify: boolean; notifyEmails: string[]; notifyPerDay: number },
  data: InterestEmail,
  m: { id: string; email: string; phone: string; at: string },
  now: Date,
) {
  const to = s.notify ? interestNotifyAddresses(contactEmail, s.notifyEmails) : []
  if (to.length === 0) return
  // One count per EOI (not per address), in a rolling day.
  const budget = await hit(deps.db, [{ key: 'interest:notify-day', max: s.notifyPerDay, windowMs: 24 * HOUR }], now)
  if (!budget.ok) {
    console.warn('[interest] notification not sent: the daily limit for EOI notifications is reached (the EOI is saved)')
    return
  }
  const url = new URL(`/admin/interest/${m.id}`, deps.siteUrl).toString()
  for (const addr of to)
    await quietly(
      () => deps.mailer.sendEmail(addr, 'interest.notify', { ...data, email: m.email, phone: m.phone, url, receivedAt: m.at }),
      'notification',
    )
}

async function quietly(fn: () => Promise<unknown>, what: string) {
  try {
    await fn()
  } catch (e) {
    console.warn(`[interest] ${what} email not sent: ${describeError(e)}`)
  }
}
