import type { ProgrammeKind } from '../../server/db/schema/enums'
import type { FormEntryType, FormField } from './forms'

// The starting questions for each programme kind (docs/admin.md §3.7). A programme with no form of its own uses
// these, and "New form" in the admin starts from them, so Michael edits a copy rather than a blank page. The
// person's name, email and phone are always asked (they aren't fields); Turnstile is always on.

const SKILL: FormField = {
  key: 'skill_level',
  type: 'radio',
  label: 'Skill level',
  required: true,
  options: [
    { value: 'beginner', label: 'Beginner: new to volleyball or just starting out' },
    { value: 'intermediate', label: 'Intermediate: comfortable passing, setting and serving' },
    { value: 'advanced', label: 'Advanced: plays competitively' },
  ],
}

const CONDUCT: FormField = {
  key: 'code_of_conduct',
  type: 'consent',
  label: 'I have read and agree to follow the rules and the code of conduct',
  required: true,
  href: '/rules',
}

const NOTES: FormField = { key: 'notes', type: 'textarea', label: 'Anything else we should know?', maxLength: 1000 }

export const DEFAULT_FORM_FIELDS: Record<ProgrammeKind, FormField[]> = {
  league: [
    { key: 'team_heading', type: 'heading', label: 'Your team', appliesTo: ['team'] },
    { key: 'team_name', type: 'team_name', label: 'Team name', required: true, appliesTo: ['team'] },
    {
      key: 'players',
      type: 'textarea',
      label: 'Players',
      help: 'One per line: name and email. You can add players later.',
      appliesTo: ['team'],
      maxLength: 2000,
    },
    { ...SKILL, appliesTo: ['free_agent'], help: "We'll use this to place you in a team." },
    {
      key: 'gender',
      type: 'select',
      label: 'Gender (for mixed team balance)',
      appliesTo: ['free_agent'],
      options: [
        { value: 'female', label: 'Female' },
        { value: 'male', label: 'Male' },
        { value: 'non_binary', label: 'Non-binary' },
        { value: 'prefer_not', label: 'Prefer not to say' },
      ],
    },
    NOTES,
    CONDUCT,
  ],
  training: [SKILL, { key: 'emergency_contact', type: 'emergency_contact', label: 'Emergency contact', required: true }, CONDUCT],
  development: [
    {
      key: 'junior_heading',
      type: 'paragraph',
      label: "Enter the junior player's name above. Use a parent or guardian's email and phone for contact.",
    },
    { key: 'birth_year', type: 'birth_year', label: 'Year of birth', required: true },
    {
      key: 'age_group',
      type: 'select',
      label: 'Age group',
      options: [
        { value: 'u11', label: 'Under 11' },
        { value: 'u13', label: 'Under 13' },
        { value: 'u15', label: 'Under 15' },
        { value: 'u17', label: 'Under 17' },
      ],
    },
    { key: 'guardian', type: 'guardian', label: 'Parent or guardian', required: true },
    { key: 'emergency_contact', type: 'emergency_contact', label: 'Emergency contact', required: true },
    {
      key: 'guardian_consent',
      type: 'consent',
      label: "I'm the junior's parent or guardian and I agree to them taking part",
      required: true,
    },
  ],
  event: [
    { key: 'team_name', type: 'team_name', label: 'Team name', required: true, appliesTo: ['team'] },
    {
      key: 'players',
      type: 'textarea',
      label: 'Players',
      help: 'One per line: name and email.',
      appliesTo: ['team'],
      maxLength: 2000,
    },
    NOTES,
    CONDUCT,
  ],
}

/** A fresh copy of a kind's default questions (callers may edit it). */
export const defaultFields = (kind: ProgrammeKind): FormField[] => structuredClone(DEFAULT_FORM_FIELDS[kind])

/** Labels for entry types, as the public form and the admin show them. */
export const ENTRY_TYPE_LABELS: Record<FormEntryType, string> = {
  player: 'Player',
  team: 'Team entry',
  free_agent: 'Individual (free agent)',
}

/**
 * Which entry types a programme takes. Leagues and events take team entries and/or individuals ("free agents",
 * whom the organiser places in teams); training and development take individual players.
 */
export function entryTypesFor(kind: ProgrammeKind, settings: { allowTeamEntries: boolean; allowFreeAgents: boolean }): FormEntryType[] {
  if (kind === 'training' || kind === 'development') return ['player']
  const types: FormEntryType[] = []
  if (settings.allowTeamEntries) types.push('team')
  if (settings.allowFreeAgents) types.push('free_agent')
  return types
}

/**
 * The EOI form's questions when Settings → Interest names no form (docs/interest.md), from the old site's two Google
 * Forms ("Individual Player - New Entry", "New Team Entry - Social League"). On an EOI an individual answers as
 * `free_agent` and a team as `team` (the contact is the captain); name, email and phone are always asked, and team
 * members are their own section of the EOI form, not fields.
 */
export const DEFAULT_INTEREST_FIELDS: FormField[] = [
  {
    key: 'birth_year',
    type: 'birth_year',
    label: 'Year of birth',
    required: true,
    help: 'Players under 18 need a parent or guardian’s OK.',
  },
  { key: 'gender', type: 'gender', label: 'Gender', required: true, help: 'Our social leagues are mixed, so this helps us balance teams.' },
  { key: 'suburb', type: 'suburb', label: 'Which suburb do you live in?' },
  { key: 'vnsw_number', type: 'vnsw_number', label: 'Volleyball NSW membership (rego) number', help: 'If you have one already.' },
  {
    key: 'playing_level',
    type: 'radio',
    label: 'Playing level',
    required: true,
    help: 'For a team, the general level of your players.',
    options: [
      { value: 'beginner', label: 'Beginner' },
      { value: 'intermediate', label: 'Intermediate' },
      { value: 'advanced', label: 'Advanced' },
    ],
  },
  {
    key: 'position',
    type: 'radio',
    label: 'What position do you play, or would you like to play?',
    help: "We can't promise the position will be free.",
    appliesTo: ['free_agent'],
    options: [
      { value: 'setter', label: 'Setter' },
      { value: 'middle', label: 'Middle hitter' },
      { value: 'outside', label: 'Outside hitter' },
      { value: 'opposite', label: 'Opposite' },
      { value: 'libero', label: 'Libero' },
      { value: 'not_sure', label: 'Not sure' },
    ],
  },
  {
    key: 'captain',
    type: 'radio',
    label: 'Would you be willing to captain a team?',
    help: 'The captain is the team’s point of contact. That’s the only extra job.',
    appliesTo: ['free_agent'],
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
  {
    key: 'usyd_student',
    type: 'text',
    label: 'USYD students: your student ID',
    help: 'For a team, the names and IDs of any USYD students.',
    maxLength: 500,
  },
  { key: 'experience', type: 'textarea', label: 'Your playing experience, and any questions or feedback', maxLength: 2000 },
  {
    key: 'heard_from',
    type: 'checkboxes',
    label: 'Where did you hear about Tempe Volleyball?',
    options: [
      { value: 'facebook', label: 'Facebook' },
      { value: 'instagram', label: 'Instagram' },
      { value: 'website', label: 'This website' },
      { value: 'friends', label: 'Friends' },
      { value: 'other', label: 'Somewhere else' },
    ],
  },
  { key: 'guardian', type: 'guardian', label: 'If you’re under 18: your parent or carer' },
  {
    key: 'share_details',
    type: 'consent',
    label:
      'I understand my details will be shared with my team-mates to form a team, and I’ll join a WhatsApp group for team and fixture news.',
    required: true,
  },
  {
    key: 'placed_randomly',
    type: 'consent',
    label: 'I understand that as an individual I’ll be placed in a team with other players.',
    required: true,
    appliesTo: ['free_agent'],
  },
  {
    key: 'waiver',
    type: 'consent',
    label: 'I agree to the disclaimer and liability waiver',
    help: 'I accept the risks of taking part in Tempe Volleyball (SUVC) activities, where accidents may cause injury or damage to or loss of property, and that injuries are my own responsibility, not Tempe Volleyball’s. I consent to photos and videos taken at Tempe Volleyball events being published on social media and Tempe Volleyball’s websites. If I’m under 18, my parent or guardian has agreed to me playing with adults.',
    required: true,
  },
]

export const defaultInterestFields = (): FormField[] => structuredClone(DEFAULT_INTEREST_FIELDS)
