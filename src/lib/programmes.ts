import type { ProgrammeKind, ProgrammeStatus } from '../server/db/schema/enums'

// Small shared rules for programmes (docs/admin.md §3, docs/data-model-phase6.md), so every agent's code agrees on
// URLs, caps and when enrolment is open. Pure: no bindings, no time zone (instants are UTC ISO strings).

/** Programme pages are flat by kind, so re-categorising never changes a URL (docs/admin.md §3.6). */
export const PROGRAMME_PATH_PREFIX = {
  league: '/leagues',
  training: '/training',
  development: '/programs',
  event: '/events',
} as const satisfies Record<ProgrammeKind, string>

/**
 * Slugs no programme may take because a route lives there: /leagues/fixtures is the cross-league fixture list.
 * (Checked for every kind, so a programme can change kind-specific pages later without a clash.)
 */
export const RESERVED_PROGRAMME_SLUGS = ['fixtures'] as const

export const isReservedProgrammeSlug = (slug: string) => (RESERVED_PROGRAMME_SLUGS as readonly string[]).includes(slug)

export const programmePath = (kind: ProgrammeKind, slug: string) => `${PROGRAMME_PATH_PREFIX[kind]}/${slug}`

/** Category landing pages live at the root: /mixed-leagues. */
export const categoryPath = (slug: string) => `/${slug}`

/** Shown on the public site at all (its page, if not in lists). Draft programmes are hidden everywhere. */
export const isPublicStatus = (status: ProgrammeStatus) => status !== 'draft'

/** Listed in menus, category pages, lists and blocks. */
export const isListedStatus = (status: ProgrammeStatus) => status === 'active'

/**
 * The cap that applies to one instance: its product's override, else the programme default. Null = unlimited.
 * (Zero is a real cap: "no spots".)
 */
export const effectiveCap = (instanceCap: number | null | undefined, programmeCap: number | null | undefined): number | null =>
  instanceCap ?? programmeCap ?? null

/** First non-null of an instance override and the programme default (waitlist settings, team/free-agent switches). */
export const inherit = <T>(instanceValue: T | null | undefined, programmeValue: T): T => instanceValue ?? programmeValue

export type EnrolmentWindow = {
  /** leagues.enrolment_open (the switch). */
  open: boolean
  /** UTC ISO or null. */
  opensAt: string | null
  closesAt: string | null
}

/**
 * Whether enrolment is open at `nowIso`: the programme switch is on, the programme is active, now is inside the
 * programme's window and inside the product's own window where it sets one, and the product is active. Products
 * override only by narrowing: a product can't open enrolment on a closed programme.
 */
export function enrolmentOpen(
  programme: EnrolmentWindow & { status: ProgrammeStatus },
  product: { active: boolean; opensAt: string | null; closesAt: string | null } | null,
  nowIso: string,
): boolean {
  if (!programme.open || programme.status !== 'active') return false
  const inside = (opensAt: string | null, closesAt: string | null) => (!opensAt || nowIso >= opensAt) && (!closesAt || nowIso < closesAt)
  if (!inside(programme.opensAt, programme.closesAt)) return false
  if (product && (!product.active || !inside(product.opensAt, product.closesAt))) return false
  return true
}
