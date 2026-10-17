import { safeHref } from '../content/render'
import {
  FORM_FIELD_KEY_PATTERN,
  FORM_LIMITS,
  displayOnlyFieldTypes,
  formEntryTypes,
  formFieldTypes,
  mappedFieldTypes,
  type FormEntryType,
  type FormField,
  type FormFieldType,
  type FormOption,
} from './forms'

// Checks for enrolment forms, shared by the admin form builder, the public form and the server (which never trusts
// the browser). Pure and cheap: one pass over at most FORM_LIMITS.maxFields fields.
//
//  - checkFormFields(): is a form definition valid, and does it keep every key the previous version had?
//  - visibleFields(): which questions a given entry type sees, given the answers so far (appliesTo, showIf).
//  - validateEnrolment(): the person's details plus the answers, normalised, with an error per field.

export type FieldErrors = Record<string, string>

export type CheckedForm = { ok: true; fields: FormField[] } | { ok: false; message: string }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

const oneLine = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '')

/** Types whose answers are interchangeable, so a field can switch between them without breaking old answers. */
const TYPE_GROUPS: readonly (readonly FormFieldType[])[] = [
  ['text', 'textarea', 'email', 'phone'],
  ['select', 'radio'],
]
const compatibleTypes = (a: FormFieldType, b: FormFieldType) => a === b || TYPE_GROUPS.some((g) => g.includes(a) && g.includes(b))

export const hasOptions = (type: FormFieldType) => type === 'select' || type === 'radio' || type === 'checkboxes'
export const isDisplayOnly = (type: FormFieldType) => (displayOnlyFieldTypes as readonly FormFieldType[]).includes(type)
export const isMapped = (type: FormFieldType) => (mappedFieldTypes as readonly FormFieldType[]).includes(type)

/** Text answers: default length limits by type. */
const defaultMaxLength = (type: FormFieldType) => (type === 'textarea' ? FORM_LIMITS.maxAnswer : type === 'team_name' ? 80 : 200)

class Invalid extends Error {}

function checkField(raw: unknown, index: number): FormField {
  const where = `Question ${index + 1}`
  if (!isObject(raw)) throw new Invalid(`${where} is not a question.`)
  const key = typeof raw.key === 'string' ? raw.key.trim() : ''
  if (!FORM_FIELD_KEY_PATTERN.test(key))
    throw new Invalid(`${where}: its key must start with a letter and use only a–z, 0–9 and _ (at most 40 characters).`)
  const type = raw.type as FormFieldType
  if (!(formFieldTypes as readonly string[]).includes(type)) throw new Invalid(`${where}: unknown question type.`)
  const maxLabel = type === 'paragraph' ? FORM_LIMITS.maxHelp : FORM_LIMITS.maxLabel
  const label = type === 'paragraph' ? (typeof raw.label === 'string' ? raw.label.trim() : '') : oneLine(raw.label)
  if (!label) throw new Invalid(`${where}: enter the question's text.`)
  if (label.length > maxLabel) throw new Invalid(`${where}: the text is too long (at most ${maxLabel} characters).`)
  const field: FormField = { key, type, label }
  const named = `“${label.slice(0, 40)}”`

  if (raw.help !== undefined && raw.help !== null && raw.help !== '') {
    if (typeof raw.help !== 'string') throw new Invalid(`${named}: the help text must be text.`)
    const help = raw.help.trim()
    if (help.length > FORM_LIMITS.maxHelp) throw new Invalid(`${named}: the help text is too long (at most ${FORM_LIMITS.maxHelp}).`)
    if (help) field.help = help
  }
  if (!isDisplayOnly(type)) {
    if (raw.required === true || type === 'consent') field.required = true
  }
  if (hasOptions(type)) {
    if (!Array.isArray(raw.options) || raw.options.length === 0) throw new Invalid(`${named}: add at least one choice.`)
    if (raw.options.length > FORM_LIMITS.maxOptions) throw new Invalid(`${named}: at most ${FORM_LIMITS.maxOptions} choices.`)
    const seen = new Set<string>()
    const options: FormOption[] = []
    for (const o of raw.options) {
      const optLabel = oneLine(isObject(o) ? o.label : o)
      const value = oneLine(isObject(o) ? (o.value ?? o.label) : o).slice(0, 100)
      if (!optLabel || !value) throw new Invalid(`${named}: a choice is empty.`)
      if (optLabel.length > FORM_LIMITS.maxLabel) throw new Invalid(`${named}: a choice is too long.`)
      if (seen.has(value.toLowerCase())) throw new Invalid(`${named}: the choice “${optLabel}” is there twice.`)
      seen.add(value.toLowerCase())
      options.push({ value, label: optLabel })
    }
    field.options = options
  }
  const num = (v: unknown, what: string) => {
    if (v === undefined || v === null || v === '') return undefined
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n)) throw new Invalid(`${named}: ${what} must be a number.`)
    return n
  }
  if (type === 'text' || type === 'textarea' || type === 'team_name') {
    const maxLength = num(raw.maxLength, 'the length limit')
    if (maxLength !== undefined) {
      if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > FORM_LIMITS.maxAnswer)
        throw new Invalid(`${named}: the length limit must be 1–${FORM_LIMITS.maxAnswer}.`)
      field.maxLength = maxLength
    }
  }
  if (type === 'number') {
    const min = num(raw.min, 'the minimum')
    const max = num(raw.max, 'the maximum')
    if (min !== undefined) field.min = min
    if (max !== undefined) field.max = max
    if (min !== undefined && max !== undefined && min > max) throw new Invalid(`${named}: the minimum is above the maximum.`)
  }
  if (typeof raw.placeholder === 'string' && raw.placeholder.trim() && !isDisplayOnly(type)) {
    const placeholder = oneLine(raw.placeholder)
    if (placeholder.length > FORM_LIMITS.maxLabel) throw new Invalid(`${named}: the placeholder is too long.`)
    field.placeholder = placeholder
  }
  if (raw.href !== undefined && raw.href !== null && raw.href !== '') {
    if (type !== 'consent' && type !== 'vnsw_membership') throw new Invalid(`${named}: only consent questions take a link.`)
    const href = safeHref(raw.href)
    if (!href || !/^(\/|https:\/\/)/i.test(href))
      throw new Invalid(`${named}: the link must be a site path (/rules) or an https:// address.`)
    field.href = href
  }
  if (raw.showIf !== undefined && raw.showIf !== null) {
    if (!isObject(raw.showIf) || typeof raw.showIf.key !== 'string') throw new Invalid(`${named}: the "show only if" rule is incomplete.`)
    const equals = raw.showIf.equals
    if (typeof equals !== 'string' && typeof equals !== 'boolean') throw new Invalid(`${named}: the "show only if" answer is missing.`)
    field.showIf = { key: raw.showIf.key, equals }
  }
  if (type === 'team_name') {
    // A team name only makes sense on a team entry.
    field.appliesTo = ['team']
  } else if (raw.appliesTo !== undefined && raw.appliesTo !== null) {
    if (!Array.isArray(raw.appliesTo)) throw new Invalid(`${named}: "asked on" must be a list.`)
    const list = [...new Set(raw.appliesTo)].filter((t): t is FormEntryType => (formEntryTypes as readonly unknown[]).includes(t))
    if (list.length !== raw.appliesTo.length || list.length === 0) throw new Invalid(`${named}: choose who's asked this question.`)
    if (list.length < formEntryTypes.length) field.appliesTo = list
  }
  if (raw.retired === true) field.retired = true
  return field
}

/**
 * Validates a form definition. `previous` is the saved version's fields: every key it had must still be there
 * (retired is fine) with a compatible type, so old answers keep their meaning and label (docs/data-model-phase6.md).
 */
export function checkFormFields(input: unknown, previous: readonly FormField[] = []): CheckedForm {
  try {
    if (!Array.isArray(input)) throw new Invalid('The questions must be a list.')
    if (input.length > FORM_LIMITS.maxFields) throw new Invalid(`A form can have at most ${FORM_LIMITS.maxFields} questions.`)
    const fields = input.map(checkField)
    const byKey = new Map<string, FormField>()
    for (const f of fields) {
      if (byKey.has(f.key)) throw new Invalid(`Two questions use the key “${f.key}”. Keys must be unique.`)
      byKey.set(f.key, f)
    }
    const active = fields.filter((f) => !f.retired)
    for (const type of mappedFieldTypes) {
      if (active.filter((f) => f.type === type).length > 1)
        throw new Invalid(`A form can only have one “${type.replace('_', ' ')}” question.`)
    }
    for (const f of active) {
      if (!f.showIf) continue
      const target = byKey.get(f.showIf.key)
      if (!target || target.retired || target.key === f.key || isDisplayOnly(target.type))
        throw new Invalid(`“${f.label.slice(0, 40)}”: its "show only if" question isn't on the form.`)
      if (target.showIf)
        throw new Invalid(`“${f.label.slice(0, 40)}”: "show only if" can't depend on a question that is itself conditional.`)
    }
    for (const old of previous) {
      const now = byKey.get(old.key)
      if (!now)
        throw new Invalid(`The question “${old.label.slice(0, 40)}” can't be deleted because answers may use its key. Retire it instead.`)
      if (!compatibleTypes(old.type, now.type))
        throw new Invalid(`“${now.label.slice(0, 40)}” can't change from ${old.type} to ${now.type}. Retire it and add a new question.`)
    }
    return { ok: true, fields }
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, message: e.message }
    throw e
  }
}

/** A key that isn't used yet in the form, from a label: "Skill level" → "skill_level", "skill_level_2" … */
export function suggestKey(label: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'question'
  if (!/^[a-z]/.test(base)) base = `q_${base}`.slice(0, 32)
  if (!used.has(base)) return base
  for (let i = 2; ; i++) if (!used.has(`${base}_${i}`)) return `${base}_${i}`
}

// ── Answers ───────────────────────────────────────────────────────────────────

/** Is a showIf rule met? `answers` are raw (from the browser) or normalised; both compare the same way. */
const showIfMet = (rule: FormField['showIf'], answers: Record<string, unknown>) => {
  if (!rule) return true
  const a = answers[rule.key]
  if (typeof rule.equals === 'boolean') return (a === true || a === 'true' || a === 'on') === rule.equals
  if (Array.isArray(a)) return a.includes(rule.equals)
  return typeof a === 'string' && a.trim() === rule.equals
}

/** The questions this entry type is asked, given the answers so far. Display-only fields are included. */
export function visibleFields(fields: readonly FormField[], entryType: FormEntryType, answers: Record<string, unknown> = {}): FormField[] {
  return fields.filter((f) => !f.retired && (!f.appliesTo || f.appliesTo.includes(entryType)) && showIfMet(f.showIf, answers))
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

export const normaliseEmail = (v: unknown) => oneLine(v).toLowerCase()
export const isEmail = (v: string) => v.length <= 254 && EMAIL.test(v)
/** Australian or international numbers: 6–15 digits with spaces, dashes, dots, brackets and a leading +. */
export const isPhone = (v: string) =>
  /^\+?[\d\s().-]+$/.test(v) && (v.match(/\d/g)?.length ?? 0) >= 6 && (v.match(/\d/g)?.length ?? 0) <= 15

const isValidDate = (v: string) => {
  if (!DATE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export type Guardian = { name: string; email: string; phone: string }
export type EmergencyContact = { name: string; phone: string }

/** Answers that go to fixed columns (players.*, groups.name, registrations.vnsw_confirmed) instead of `answers`. */
export type MappedAnswers = {
  guardian?: Guardian
  emergencyContact?: EmergencyContact
  birthYear?: number
  teamName?: string
  vnswConfirmed?: boolean
}

export type PersonInput = { firstName: string; lastName: string; email: string; phone: string }

export type EnrolmentCheck =
  { ok: true; person: PersonInput; answers: Record<string, unknown>; mapped: MappedAnswers } | { ok: false; errors: FieldErrors }

export type ValidateOptions = {
  /** For birth-year limits. */
  currentYear: number
  /** Admin entries: required questions may be left blank (the organiser may not have every answer). */
  relaxRequired?: boolean
  /** Programme age limits (years in the current year), checked against a birth_year answer. */
  ageMin?: number | null
  ageMax?: number | null
}

/** The fixed questions every form asks (players columns). Keys are reserved: a form field can't use them. */
export const PERSON_KEYS = ['firstName', 'lastName', 'email', 'phone'] as const

/**
 * Validates and normalises one enrolment: the person's details (`person`) and the form's answers (`answers`).
 * Questions the entry type doesn't see (appliesTo, an unmet showIf, retired) and unknown keys are dropped.
 * Mapped types come back in `mapped` and not in `answers`, so juniors' and guardians' details are stored once.
 */
export function validateEnrolment(
  fields: readonly FormField[],
  entryType: FormEntryType,
  rawPerson: unknown,
  rawAnswers: unknown,
  opts: ValidateOptions,
): EnrolmentCheck {
  const errors: FieldErrors = {}
  const person = isObject(rawPerson) ? rawPerson : {}
  const input = isObject(rawAnswers) ? rawAnswers : {}
  const required = (f: { required?: boolean }) => !!f.required && !opts.relaxRequired

  const firstName = oneLine(person.firstName)
  const lastName = oneLine(person.lastName)
  const email = normaliseEmail(person.email)
  const phone = oneLine(person.phone)
  if (!firstName) errors.firstName = 'Enter a first name.'
  else if (firstName.length > 80) errors.firstName = 'That name is too long.'
  if (!lastName) errors.lastName = 'Enter a last name.'
  else if (lastName.length > 80) errors.lastName = 'That name is too long.'
  if (!email) errors.email = 'Enter an email address.'
  else if (!isEmail(email)) errors.email = "That email address doesn't look right."
  if (!phone) {
    if (!opts.relaxRequired) errors.phone = 'Enter a phone number.'
  } else if (!isPhone(phone)) errors.phone = "That phone number doesn't look right."

  const answers: Record<string, unknown> = {}
  const mapped: MappedAnswers = {}
  for (const f of visibleFields(fields, entryType, input)) {
    if (isDisplayOnly(f.type)) continue
    const raw = input[f.key]
    const blank = raw === undefined || raw === null || raw === '' || raw === false || (Array.isArray(raw) && raw.length === 0)
    const fail = (message: string) => {
      errors[f.key] = message
    }
    switch (f.type) {
      case 'text':
      case 'textarea':
      case 'team_name': {
        const v = f.type === 'textarea' ? (typeof raw === 'string' ? raw.trim() : '') : oneLine(raw)
        if (raw !== undefined && raw !== null && typeof raw !== 'string') fail('Enter text.')
        else if (!v) {
          if (required(f) || f.type === 'team_name') fail(f.type === 'team_name' ? 'Enter your team name.' : 'This question is required.')
        } else if (v.length > (f.maxLength ?? defaultMaxLength(f.type)))
          fail(`Too long (at most ${f.maxLength ?? defaultMaxLength(f.type)} characters).`)
        else if (f.type === 'team_name') mapped.teamName = v
        else answers[f.key] = v
        break
      }
      case 'email': {
        const v = normaliseEmail(raw)
        if (!v) {
          if (required(f)) fail('Enter an email address.')
        } else if (!isEmail(v)) fail("That email address doesn't look right.")
        else answers[f.key] = v
        break
      }
      case 'phone': {
        const v = oneLine(raw)
        if (!v) {
          if (required(f)) fail('Enter a phone number.')
        } else if (!isPhone(v)) fail("That phone number doesn't look right.")
        else answers[f.key] = v
        break
      }
      case 'number': {
        if (blank) {
          if (required(f)) fail('Enter a number.')
          break
        }
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
        if (!Number.isFinite(n)) fail('Enter a number.')
        else if (f.min !== undefined && n < f.min) fail(`At least ${f.min}.`)
        else if (f.max !== undefined && n > f.max) fail(`At most ${f.max}.`)
        else answers[f.key] = n
        break
      }
      case 'date': {
        const v = oneLine(raw)
        if (!v) {
          if (required(f)) fail('Enter a date.')
        } else if (!isValidDate(v)) fail('Enter a date like 2026-10-18.')
        else answers[f.key] = v
        break
      }
      case 'select':
      case 'radio': {
        const v = oneLine(raw)
        if (!v) {
          if (required(f)) fail('Choose one.')
        } else if (!f.options?.some((o) => o.value === v)) fail('Choose one of the options.')
        else answers[f.key] = v
        break
      }
      case 'checkboxes': {
        const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw]
        const values = [...new Set(list.map(oneLine))].filter(Boolean)
        if (values.some((v) => !f.options?.some((o) => o.value === v))) fail('Choose from the options.')
        else if (values.length === 0) {
          if (required(f)) fail('Choose at least one.')
        } else answers[f.key] = values
        break
      }
      case 'checkbox':
      case 'consent':
      case 'vnsw_membership': {
        const v = raw === true || raw === 'true' || raw === 'on'
        if (!v && (f.type === 'consent' ? !opts.relaxRequired : required(f)))
          fail(f.type === 'consent' ? 'Please tick to agree.' : 'Please tick this box.')
        if (f.type === 'vnsw_membership') mapped.vnswConfirmed = v
        else answers[f.key] = v
        break
      }
      case 'birth_year': {
        if (blank) {
          if (required(f)) fail('Enter the year of birth.')
          break
        }
        const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN
        if (!Number.isInteger(n) || n < 1900 || n > opts.currentYear) fail('Enter a year like 2014.')
        else {
          const age = opts.currentYear - n
          if (opts.ageMin != null && age < opts.ageMin) fail(`This programme is for ages ${opts.ageMin} and up.`)
          else if (opts.ageMax != null && age > opts.ageMax) fail(`This programme is for ages ${opts.ageMax} and under.`)
          else mapped.birthYear = n
        }
        break
      }
      case 'guardian': {
        const o = isObject(raw) ? raw : {}
        // On a junior form the contact email and phone are the guardian's (the form labels them so), so the
        // guardian section asks only for the name and the rest comes from the contact details: asked once.
        const g = { name: oneLine(o.name), email: normaliseEmail(o.email) || email, phone: oneLine(o.phone) || phone }
        if (!g.name) {
          if (required(f)) fail("Enter the parent or guardian's name.")
          break
        }
        if (!g.name || g.name.length > 120) fail("Enter the parent or guardian's name.")
        else if (!isEmail(g.email)) fail("Enter the parent or guardian's email address.")
        else if (!isPhone(g.phone)) fail("Enter the parent or guardian's phone number.")
        else mapped.guardian = g
        break
      }
      case 'emergency_contact': {
        const o = isObject(raw) ? raw : {}
        const c = { name: oneLine(o.name), phone: oneLine(o.phone) }
        if (!c.name && !c.phone) {
          if (required(f)) fail('Enter an emergency contact.')
          break
        }
        if (!c.name || c.name.length > 120) fail("Enter the emergency contact's name.")
        else if (!isPhone(c.phone)) fail("Enter the emergency contact's phone number.")
        else mapped.emergencyContact = c
        break
      }
      case 'heading':
      case 'paragraph':
        break
    }
    if (typeof answers[f.key] === 'string' && (answers[f.key] as string).length > FORM_LIMITS.maxAnswer) fail('Too long.')
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, person: { firstName, lastName, email, phone }, answers, mapped }
}

/** An answer for display (CSV, admin): option labels for choices, Yes/No for ticks. */
export function answerText(field: FormField | undefined, value: unknown): string {
  if (value === undefined || value === null) return ''
  const label = (v: unknown) => field?.options?.find((o) => o.value === v)?.label ?? String(v)
  if (Array.isArray(value)) return value.map(label).join('; ')
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (field && hasOptions(field.type)) return label(value)
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
