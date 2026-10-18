import type { ProductKind, ProgrammeKind } from '../../server/db/schema/enums'
import { formatTimeRange } from '../time'

// What someone enrols in: a league season, a training session, a development term or an event (docs/admin.md
// §3.7). Each has exactly one products row, which holds its caps and overrides. Shared by the server, the admin and
// the public form.

export const targetKinds = ['season', 'session', 'term', 'event'] as const
export type TargetKind = (typeof targetKinds)[number]

export type TargetRef = { kind: TargetKind; id: string }

export const isTargetKind = (v: unknown): v is TargetKind => typeof v === 'string' && (targetKinds as readonly string[]).includes(v)

/** The product kind for each target. */
export const PRODUCT_KIND: Record<TargetKind, ProductKind> = {
  season: 'season_entry',
  session: 'training_session',
  term: 'development_term',
  event: 'event_entry',
}

/** The target kind each programme kind enrols in. */
export const TARGET_FOR_PROGRAMME: Record<ProgrammeKind, TargetKind> = {
  league: 'season',
  training: 'session',
  development: 'term',
  event: 'event',
}

export const TARGET_LABELS: Record<TargetKind, string> = { season: 'Season', session: 'Session', term: 'Term', event: 'Event' }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-10-21" → "Wed 21 Oct 2026" (a Sydney calendar date; no time zone maths needed). */
export function formatDate(date: string, opts: { year?: boolean } = {}): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${opts.year === false ? '' : ` ${d.getUTCFullYear()}`}`
}

export { formatTime } from '../time'
/** "6–8pm", "11am–1pm" (the shared formatter in src/lib/time.ts). */
export const formatTimes = formatTimeRange

/** "Wed 21 Oct 2026, 6:30–8pm: Serving" for a session. */
export function sessionLabel(s: { date: string; startTime: string | null; endTime: string | null; title: string | null }): string {
  const times = formatTimeRange(s.startTime, s.endTime)
  return `${formatDate(s.date)}${times ? `, ${times}` : ''}${s.title ? `: ${s.title}` : ''}`
}

/** What a product's target row says about it (any of the four), as targetLabelColumns selects it. */
export type TargetLabelParts = {
  seasonName: string | null
  sessionDate: string | null
  sessionStart: string | null
  sessionEnd: string | null
  sessionTitle: string | null
  termName: string | null
  eventName: string | null
  /** products.name: the fallback for a product with no target row (a Phase 5 product). */
  productName: string
}

/**
 * The one label for an enrolment target, used by the form, the admin, the offer and confirm pages and every email:
 * "TNL Q4 2026", "Thu 22 Oct 2026, 6–8pm", "Term 4 2026", "Tempe Cup 2026". Built from the target row each time,
 * never from products.name, so an edited session time or title shows everywhere at once.
 */
export function targetLabel(p: TargetLabelParts): string {
  if (p.seasonName) return p.seasonName
  if (p.sessionDate) return sessionLabel({ date: p.sessionDate, startTime: p.sessionStart, endTime: p.sessionEnd, title: p.sessionTitle })
  return p.termName ?? p.eventName ?? p.productName
}
