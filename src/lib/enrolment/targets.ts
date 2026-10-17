import type { ProductKind, ProgrammeKind } from '../../server/db/schema/enums'

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

/** "18:30" → "6:30pm", "20:00" → "8pm". */
export function formatTime(time: string | null | undefined): string {
  const m = /^(\d{2}):(\d{2})$/.exec(time ?? '')
  if (!m) return ''
  const h = Number(m[1])
  const suffix = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}${m[2] === '00' ? '' : `:${m[2]}`}${suffix}`
}

export const formatTimes = (start: string | null | undefined, end: string | null | undefined) => {
  const s = formatTime(start)
  const e = formatTime(end)
  return s && e ? `${s}–${e}` : s
}

/** "Wed 21 Oct 2026, 6:30–8pm: Serving" for a session. */
export function sessionLabel(s: { date: string; startTime: string | null; endTime: string | null; title: string | null }): string {
  const times = formatTimes(s.startTime, s.endTime)
  return `${formatDate(s.date)}${times ? `, ${times}` : ''}${s.title ? `: ${s.title}` : ''}`
}
