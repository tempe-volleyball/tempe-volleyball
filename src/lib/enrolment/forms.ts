// Enrolment form definitions (enrolment_forms.fields). Pure types and constants shared by the admin form builder,
// the public form and the server-side validator. See docs/data-model-phase6.md "Enrolment forms".
//
// Every form always asks for the player's first name, last name, email and phone (the `players` columns), plus the
// Turnstile check; those are not fields here. Fields add questions on top. Answers are stored in
// registrations.answers (and groups.answers for team-level fields) keyed by `key`.
//
// Keys are permanent: never reuse or rename a key once a form has answers. To remove a question, set `retired: true`
// so old answers still have their label in exports.

export const formFieldTypes = [
  // Answer types
  'text',
  'textarea',
  'email',
  'phone',
  'number',
  'date',
  /** One choice from a dropdown. */
  'select',
  /** One choice shown as radio buttons. */
  'radio',
  /** A single yes/no tick box. */
  'checkbox',
  /** Several choices from `options`. */
  'checkboxes',
  /** A required tick box with linked terms (waiver, code of conduct). */
  'consent',
  /** Guardian name, email and phone, saved to players.guardian_* (juniors). */
  'guardian',
  /** Emergency contact name and phone, saved to players.emergency_contact. */
  'emergency_contact',
  /** Year of birth, saved to players.birth_year (age checks against the programme's age_min/age_max). */
  'birth_year',
  /** Team name for team entries, saved to groups.name. */
  'team_name',
  /** "I hold a Volleyball NSW membership" (links to Revolutionise), saved to registrations.vnsw_confirmed. */
  'vnsw_membership',
  // Display only (no answer)
  'heading',
  'paragraph',
] as const
export type FormFieldType = (typeof formFieldTypes)[number]

/** Field types that only display text and take no answer. */
export const displayOnlyFieldTypes = ['heading', 'paragraph'] as const satisfies readonly FormFieldType[]

/** Field types whose answer goes to a fixed column instead of (as well as) `answers`. */
export const mappedFieldTypes = [
  'guardian',
  'emergency_contact',
  'birth_year',
  'team_name',
  'vnsw_membership',
] as const satisfies readonly FormFieldType[]

/** Which kind of entry a field is asked on. Missing = every entry. */
export const formEntryTypes = ['player', 'team', 'free_agent'] as const
export type FormEntryType = (typeof formEntryTypes)[number]

export type FormOption = { value: string; label: string }

export type FormField = {
  /** Stable answer key, FORM_FIELD_KEY_PATTERN. Unique within the form. Never reused. */
  key: string
  type: FormFieldType
  label: string
  /** Hint under the label. Plain text. */
  help?: string
  required?: boolean
  /** select, radio, checkboxes. */
  options?: FormOption[]
  /** text/textarea max length; number min/max. */
  maxLength?: number
  min?: number
  max?: number
  placeholder?: string
  /** consent: the linked terms (internal path or https URL). */
  href?: string
  /** Show only when another field has this answer (one level, no chains). */
  showIf?: { key: string; equals: string | boolean }
  /** Ask only on these entry types (e.g. team_name on `team`). */
  appliesTo?: FormEntryType[]
  /** Removed from the form; kept so old answers keep a label. */
  retired?: boolean
}

/** Limits that keep a form cheap to validate in the Worker. */
export const FORM_LIMITS = { maxFields: 60, maxOptions: 50, maxLabel: 200, maxHelp: 1000, maxAnswer: 4000 } as const

export const FORM_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/

/** The questions actually shown: everything not retired (display-only fields included). */
export const activeFields = (fields: readonly FormField[]): FormField[] => fields.filter((f) => !f.retired)
