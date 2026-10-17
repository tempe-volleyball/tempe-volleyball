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
