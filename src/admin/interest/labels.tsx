import { useState } from 'react'
import { Checkbox } from '../ui'

// Shared words and chips for Admin → Interest (docs/admin.md §3.16).

export const STATUS_LABEL: Record<string, string> = {
  new: 'New',
  contacted: 'Contacted',
  placed: 'Placed',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
}

export const STATUSES = ['new', 'contacted', 'placed', 'declined', 'withdrawn'] as const

const STATUS_CLASS: Record<string, string> = {
  new: 'bg-accent text-ink',
  contacted: 'bg-brand/10 text-brand',
  placed: 'bg-green-100 text-green-900',
  declined: 'bg-black/5 text-black/70',
  withdrawn: 'bg-black/5 text-black/70',
}

/** "TNL: New" as a small chip. */
export function StatusChip({ status, code }: { status: string; code?: string }) {
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${STATUS_CLASS[status] ?? ''}`}>
      {code ? `${code}: ` : ''}
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

export function KindChip({ kind }: { kind: string }) {
  return (
    <span className="inline-block rounded border border-black/20 px-1.5 py-0.5 text-xs font-semibold text-black/70">
      {kind === 'team' ? 'Team' : 'Player'}
    </span>
  )
}

export function PaidChip({ paid }: { paid: boolean }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${paid ? 'bg-green-100 text-green-900' : 'bg-red-50 text-red-800'}`}
    >
      {paid ? 'Deposit paid' : 'Deposit unpaid'}
    </span>
  )
}

/** "8 Oct 2026" from YYYY-MM-DD. */
export const shortDate = (date: string) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(`${date}T00:00:00Z`),
  )

export const LEVEL_LABEL: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' }
export const POSITION_LABEL: Record<string, string> = {
  setter: 'Setter',
  middle: 'Middle',
  outside: 'Outside',
  opposite: 'Opposite',
  libero: 'Libero',
  not_sure: 'Position not sure',
}

export const PAYMENT_METHODS: Record<string, string> = { payid: 'PayID', cash: 'Cash', bank: 'Bank transfer', card: 'Card', other: 'Other' }

export const personName = (p: { firstName: string; lastName: string } | null | undefined) =>
  p ? `${p.firstName} ${p.lastName}`.trim() : 'No name'

/** The "also delete the players it added" choice in the delete confirmation (default: delete them). */
export function KeepPlayersChoice({ onChange }: { onChange: (keep: boolean) => void }) {
  const [keep, setKeep] = useState(false)
  return (
    <Checkbox
      label="Keep the player records it added"
      hint="Left unticked, people this EOI added as new players are deleted too, unless they’ve since enrolled, played or sent another EOI. Players who were already on file are always kept."
      checked={keep}
      onChange={(v) => {
        setKeep(v)
        onChange(v)
      }}
    />
  )
}
