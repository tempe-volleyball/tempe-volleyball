import type { ProgrammeKind } from '../../server/db/schema/enums'

// How each programme kind looks in the admin (docs/admin.md §3.1): its own nav section, words and fields.

export type KindConfig = {
  kind: ProgrammeKind
  /** Admin route base, e.g. /training. */
  base: string
  /** "Training", for the nav and headings. */
  title: string
  /** "training programme", in sentences. */
  noun: string
  /** The instance tab: Seasons, Sessions, Terms or Dates. */
  instancesTab: { key: string; label: string }
  intro: string
  /** The category a new one starts in when no programme of this kind exists yet (a slug; ignored if missing). */
  categoryHint: string | null
  /** Fields only some kinds use. */
  fields: { format: boolean; teams: boolean; ages: boolean; weekday: boolean }
}

export const KINDS: Record<ProgrammeKind, KindConfig> = {
  league: {
    kind: 'league',
    categoryHint: 'mixed-leagues',
    base: '/leagues',
    title: 'Leagues',
    noun: 'league',
    instancesTab: { key: 'seasons', label: 'Seasons' },
    intro:
      'Each league runs a new season every quarter. Open a league to edit its details and enrolment, or a season to set it up and enter results.',
    fields: { format: true, teams: true, ages: false, weekday: true },
  },
  training: {
    kind: 'training',
    categoryHint: 'adult-training',
    base: '/training',
    title: 'Training',
    noun: 'training programme',
    instancesTab: { key: 'sessions', label: 'Sessions' },
    intro: 'Training runs as dated sessions, each with its own cap. Add a run of weekly sessions in one go.',
    fields: { format: false, teams: false, ages: true, weekday: true },
  },
  development: {
    kind: 'development',
    categoryHint: 'juniors',
    base: '/development',
    title: 'Development',
    noun: 'development programme',
    instancesTab: { key: 'terms', label: 'Terms' },
    intro: 'Development programmes (ADP, JDP) run in terms of weekly sessions. People enrol in a whole term.',
    fields: { format: false, teams: false, ages: true, weekday: true },
  },
  event: {
    kind: 'event',
    categoryHint: null,
    base: '/events',
    title: 'Events',
    noun: 'event',
    instancesTab: { key: 'dates', label: 'Dates' },
    intro: 'Events (Tempe Cup, trials, socials) run on a date or a few days, each with its own entries.',
    fields: { format: false, teams: true, ages: true, weekday: false },
  },
}

export const KIND_ORDER: ProgrammeKind[] = ['league', 'training', 'development', 'event']

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

export const statusLabel = { draft: 'Draft', active: 'Active', retired: 'Retired' } as const

/** Cents -> "150.00" for a dollars input; '' for null. */
export const centsToDollars = (c: number | null | undefined) => (c === null || c === undefined ? '' : (c / 100).toFixed(2))

/** "150", "150.5" -> cents; null for ''; NaN for junk (the server refuses it). */
export const dollarsToCents = (s: string): number | null => {
  const t = s.trim().replace(/^\$/, '')
  if (!t) return null
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : NaN
}

/** '' -> null, else the integer (NaN for junk). */
export const intOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s))
