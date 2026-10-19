import type { MemberDetailKey, MemberFieldMode } from './content/settings'
import { GENDER_OPTIONS } from './enrolment/forms'
import { isEmail, isPhone, normaliseEmail, type FieldErrors } from './enrolment/validate'
import { defaultSignupMode, type ProgrammeKind, type ProgrammeStatus, type SignupMode } from '../server/db/schema/enums'

// Expressions of interest (docs/interest.md), the pure rules shared by the public pages, the EOI form island and the
// Worker: which programmes take EOIs, where the form lives, the join line on a programme page, the deposit an EOI
// owes, and the team-member checks. No bindings, no DOM.

/** The EOI form. `/interest/<programme slug>` is the same form with that programme ticked. */
export const INTEREST_ROUTE = '/interest'

export const interestPath = (slug?: string | null) => (slug ? `${INTEREST_ROUTE}/${slug}` : INTEREST_ROUTE)

/** The largest JSON body POST /api/interest reads: a full team with every detail is well under 20 KB. */
export const INTEREST_BODY_LIMIT = 64 * 1024

/** What the sign-up rules read of a programme (a leagues row satisfies it). */
export type SignupFields = { kind: ProgrammeKind; signupMode?: SignupMode | null; status: ProgrammeStatus; interestOpen?: boolean | null }

/** The programme's sign-up mode: its own, else its kind's default (leagues and events take EOIs). */
export const signupModeOf = (p: Pick<SignupFields, 'kind' | 'signupMode'>): SignupMode => p.signupMode ?? defaultSignupMode(p.kind)

export const isInterestMode = (p: Pick<SignupFields, 'kind' | 'signupMode'>) => signupModeOf(p) === 'interest'

/**
 * Offered on the EOI form (and given a join section on its page): active, in interest mode and taking EOIs. A missing
 * `interestOpen` counts as on (the column's default).
 */
export const takesInterest = (p: SignupFields) => p.status === 'active' && isInterestMode(p) && p.interestOpen !== false

/** The join section's invitation, under the next-start line when the programme has no text of its own. */
export const JOIN_INVITE =
  'Come on your own and we’ll find you a team, or enter a whole team. Tell us you’re interested and we’ll be in touch.'

/**
 * The join section's line: the programme's own text (leagues.interest_text), else "Next season starts …." when a next
 * start is known, else nothing. Never "closed": EOIs are welcome all year.
 */
export function joinLine(interestText: string | null | undefined, nextStarts: string): string {
  const own = interestText?.trim()
  if (own) return own
  return nextStarts ? (/[.!?]$/.test(nextStarts) ? nextStarts : `${nextStarts}.`) : ''
}

/** The deposit an EOI owes (AUD cents): the highest of the programmes picked, for a team or a player. Null = none. */
export function depositFor(
  kind: 'player' | 'team',
  picked: readonly { depositPlayerCents: number | null; depositTeamCents: number | null }[],
): number | null {
  const amounts = picked.map((p) => (kind === 'team' ? p.depositTeamCents : p.depositPlayerCents)).filter((c): c is number => !!c && c > 0)
  return amounts.length ? Math.max(...amounts) : null
}

/** "$50", "$12.50". */
export const formatDeposit = (cents: number) =>
  cents % 100 === 0 ? `$${(cents / 100).toLocaleString('en-AU')}` : `$${(cents / 100).toFixed(2)}`

// ── Team members ──────────────────────────────────────────────────────────────

export const MEMBER_DETAIL_LABELS: Record<MemberDetailKey, string> = {
  email: 'Email',
  phone: 'Mobile',
  gender: 'Gender',
  birthYear: 'Year of birth',
  vnswNumber: 'VNSW number',
}

/** A team member as typed (everything but the names is optional or switched off by Settings → Interest). */
export type MemberInput = {
  firstName?: unknown
  lastName?: unknown
  email?: unknown
  phone?: unknown
  gender?: unknown
  birthYear?: unknown
  vnswNumber?: unknown
}

export type CheckedMember = {
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
  gender: string | null
  birthYear: number | null
  vnswNumber: string | null
}

const oneLine = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : typeof v === 'number' ? String(v) : '')

const blankMember = (m: MemberInput) =>
  (['firstName', 'lastName', 'email', 'phone', 'gender', 'birthYear', 'vnswNumber'] as const).every((k) => !oneLine(m[k]))

/**
 * Checks the team members sent with a team EOI (the captain is the contact, not one of these). Rows left completely
 * blank are dropped. Each needs a first and last name; the other details follow Settings → Interest → "Member details"
 * (off = dropped even if sent, optional, required). Errors are keyed `members.<i>.<field>` (i counts the rows sent),
 * plus `members` for too many.
 */
export function checkMembers(
  raw: unknown,
  modes: Record<MemberDetailKey, MemberFieldMode>,
  opts: { max: number; currentYear: number },
): { ok: true; members: CheckedMember[] } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {}
  if (raw !== undefined && raw !== null && !Array.isArray(raw))
    return { ok: false, errors: { members: 'Send the team members as a list.' } }
  const rows = ((raw as unknown[] | undefined) ?? []).map((r) => (r && typeof r === 'object' ? (r as MemberInput) : {}))
  const kept = rows.map((m, i) => ({ m, i })).filter(({ m }) => !blankMember(m))
  if (kept.length > opts.max)
    return {
      ok: false,
      errors: { members: opts.max === 0 ? 'This form takes the captain only.' : `At most ${opts.max} team members besides the captain.` },
    }
  const members: CheckedMember[] = []
  for (const { m, i } of kept) {
    const err = (field: string, message: string) => {
      errors[`members.${i}.${field}`] = message
    }
    const firstName = oneLine(m.firstName)
    const lastName = oneLine(m.lastName)
    if (!firstName) err('firstName', 'Enter a first name.')
    else if (firstName.length > 80) err('firstName', 'That name is too long.')
    if (!lastName) err('lastName', 'Enter a last name.')
    else if (lastName.length > 80) err('lastName', 'That name is too long.')
    const on = (k: MemberDetailKey) => modes[k] !== 'off'
    const need = (k: MemberDetailKey) => modes[k] === 'required'

    let email: string | null = null
    if (on('email')) {
      const v = normaliseEmail(m.email)
      if (!v) {
        if (need('email')) err('email', 'Enter an email address.')
      } else if (!isEmail(v)) err('email', "That email address doesn't look right.")
      else email = v
    }
    let phone: string | null = null
    if (on('phone')) {
      const v = oneLine(m.phone)
      if (!v) {
        if (need('phone')) err('phone', 'Enter a phone number.')
      } else if (!isPhone(v)) err('phone', "That phone number doesn't look right.")
      else phone = v
    }
    let gender: string | null = null
    if (on('gender')) {
      const v = oneLine(m.gender)
      if (!v) {
        if (need('gender')) err('gender', 'Choose one.')
      } else if (!GENDER_OPTIONS.some((o) => o.value === v)) err('gender', 'Choose one of the options.')
      else gender = v
    }
    let birthYear: number | null = null
    if (on('birthYear')) {
      const v = oneLine(m.birthYear)
      const n = Number(v)
      if (!v) {
        if (need('birthYear')) err('birthYear', 'Enter the year of birth.')
      } else if (!Number.isInteger(n) || n < 1900 || n > opts.currentYear) err('birthYear', 'Enter a year like 1995.')
      else birthYear = n
    }
    let vnswNumber: string | null = null
    if (on('vnswNumber')) {
      const v = oneLine(m.vnswNumber)
      if (!v) {
        if (need('vnswNumber')) err('vnswNumber', 'Enter the VNSW number.')
      } else if (v.length > 30) err('vnswNumber', 'Too long (at most 30 characters).')
      else vnswNumber = v
    }
    members.push({ firstName, lastName, email, phone, gender, birthYear, vnswNumber })
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, members }
}
