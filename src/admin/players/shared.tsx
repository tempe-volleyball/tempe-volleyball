import type { ReactNode } from 'react'
import { GENDER_OPTIONS } from '../../lib/enrolment/forms'
import type { PlayerGroup } from '../../lib/players/groups'

// Bits shared by the Players screens (docs/admin.md §3.16).

export type Pool = 'competition' | 'training'

export const POOL_LABEL: Record<Pool, string> = { competition: 'Competition', training: 'Training' }

export const isPool = (v: string): v is Pool => v === 'competition' || v === 'training'

export const genderLabel = (g: string | null | undefined) => (g ? (GENDER_OPTIONS.find((o) => o.value === g)?.label ?? g) : '')

export const SOURCE_LABEL: Record<string, string> = {
  interest: 'Expression of interest',
  enrolment: 'Enrolment',
  admin: 'Added by hand',
  import: 'Imported',
}

/** The groups as the Players screen names them, most useful first. `all` is everyone. */
export const GROUP_CHIPS: { key: PlayerGroup | 'all'; label: string }[] = [
  { key: 'interest', label: 'New interest' },
  { key: 'last', label: 'Last season' },
  { key: 'past', label: 'Past players' },
  { key: 'retired', label: 'Retired' },
  { key: 'all', label: 'Everyone' },
]

export const GROUP_LABEL: Record<PlayerGroup, string> = {
  interest: 'New interest',
  last: 'Last season',
  past: 'Past player',
  retired: 'Retired',
  other: 'No history yet',
}

const GROUP_STYLE: Record<PlayerGroup, string> = {
  interest: 'bg-accent text-ink',
  last: 'bg-green-100 text-green-900',
  past: 'bg-brand/10 text-brand',
  retired: 'bg-black/10 text-black/70',
  other: 'bg-black/5 text-black/70',
}

export function GroupChip({ group }: { group: PlayerGroup }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${GROUP_STYLE[group]}`}>{GROUP_LABEL[group]}</span>
  )
}

export function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'accent' | 'good' | 'bad' }) {
  const cls = {
    muted: 'bg-black/5 text-black/70',
    accent: 'bg-accent text-ink',
    good: 'bg-green-100 text-green-900',
    bad: 'bg-red-100 text-red-900',
  }[tone]
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${cls}`}>{children}</span>
}

/** "Sam Lee". */
export const fullName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim()

/** "8 Oct 2026" from YYYY-MM-DD. */
export const shortDate = (date: string) =>
  new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${date.slice(0, 10)}T00:00:00Z`),
  )

export const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`

export const LEVEL_LABEL: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' }
export const POSITION_LABEL: Record<string, string> = {
  setter: 'Setter',
  middle: 'Middle',
  outside: 'Outside',
  opposite: 'Opposite',
  libero: 'Libero',
  not_sure: 'Not sure',
}
export const STATUS_LABEL: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  placed: 'Placed',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}
