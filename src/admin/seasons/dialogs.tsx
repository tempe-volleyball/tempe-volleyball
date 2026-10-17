import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type LeagueListItem } from '../api'
import { Button, Dialog } from '../ui'

// Dialogs for the season screens, on the admin's native <dialog> (ui.tsx). The parent unmounts a dialog to close it
// and clears its own state in the action handlers (a dialog's close event can fire after React has unmounted it).

/** A yes/no question. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Dialog title={title} onCancel={onCancel}>
      <div className="space-y-3 text-sm">{children}</div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" autoFocus onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}

/** "Save changes before leaving?" Escape, the × and "Keep editing" stay. */
export function LeaveDialog({
  name,
  busy,
  onSave,
  onDiscard,
  onStay,
}: {
  name: string
  busy?: boolean
  onSave: () => void
  onDiscard: () => void
  onStay: () => void
}) {
  return (
    <Dialog title={`Save changes to ${name || 'this season'}?`} onCancel={onStay}>
      <p className="text-sm">You have unsaved changes. If you leave without saving, they'll be lost.</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="danger" className="mr-auto" onClick={onDiscard}>
          Discard changes
        </Button>
        <Button variant="secondary" onClick={onStay}>
          Keep editing
        </Button>
        <Button autoFocus busy={busy} onClick={onSave}>
          Save
        </Button>
      </div>
    </Dialog>
  )
}

type CourtChoice = { name: string; where: string }

/**
 * Pick the court for one game's slot on one match day. The server only knows real courts (the venues' courts), so
 * this offers those: the season's own first, then the rest of its venue, then other venues.
 */
export function CourtDialog({
  context,
  matchup,
  current,
  fallback,
  seasonCourts,
  takenBy,
  onSave,
  onCancel,
}: {
  /** e.g. "Match day 3 · Thu, 18 Feb 2027 · 21:00" */
  context: string
  matchup: string
  current: string
  fallback: string
  /** The courts this season's settings can name (SeasonView.courts). */
  seasonCourts: { name: string; venueName: string; atLeagueVenue: boolean }[]
  /** The game already on this court at this time, if any. */
  takenBy: (court: string) => string | null
  onSave: (court: string) => void
  onCancel: () => void
}) {
  const [others, setOthers] = useState<CourtChoice[]>([])
  const [name, setName] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    // Other venues' courts, for the odd game played elsewhere.
    void api<{ leagues: LeagueListItem[] }>('/api/admin/leagues')
      .then((r) => {
        const seen = new Set(seasonCourts.map((c) => c.name.toLowerCase()))
        const list: CourtChoice[] = []
        for (const l of r.leagues)
          for (const c of l.courts)
            if (!seen.has(c.name.toLowerCase())) {
              seen.add(c.name.toLowerCase())
              list.push({ name: c.name, where: l.venue?.name ?? '' })
            }
        setOthers(list)
      })
      .catch(() => setOthers([]))
  }, [seasonCourts])

  const choices: CourtChoice[] = [
    ...seasonCourts.map((c) => ({ name: c.name, where: c.atLeagueVenue ? '' : c.venueName })),
    ...others,
  ].filter((c, i, all) => all.findIndex((x) => x.name.toLowerCase() === c.name.toLowerCase()) === i)
  const q = name.trim().toLowerCase()
  const shown = q ? choices.filter((c) => c.name.toLowerCase().includes(q) || c.where.toLowerCase().includes(q)) : choices

  return (
    <Dialog title="Choose a court" onCancel={onCancel}>
      <p className="text-sm text-black/60">{context}</p>
      <p className="text-sm font-semibold">{matchup}</p>
      <label className="mt-4 block">
        <span className="mb-1 block text-sm font-semibold">Find a court</span>
        <input
          ref={input}
          className="focus:border-brand focus:ring-brand/30 w-full rounded border border-black/20 px-3 py-2 outline-none focus:ring-2"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Court 2 or MLC"
          autoComplete="off"
        />
      </label>
      <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
        {shown.map((c) => {
          const clash = c.name.toLowerCase() !== current.toLowerCase() ? takenBy(c.name) : null
          return (
            <li key={c.name}>
              <button
                type="button"
                onClick={() => onSave(c.name)}
                className={`hover:border-brand flex w-full flex-wrap items-baseline gap-x-2 rounded border px-3 py-2 text-left text-sm ${
                  c.name === current ? 'border-brand bg-brand/5' : 'border-black/10'
                }`}
              >
                <span className="font-semibold">{c.name}</span>
                {c.where && <span className="text-black/60">{c.where}</span>}
                {c.name === fallback && <span className="text-xs text-black/60">(season default)</span>}
                {c.name === current && <span className="text-xs text-black/60">(current)</span>}
                {clash && <span className="w-full text-xs text-red-700">In use at this time by {clash}</span>}
              </button>
            </li>
          )
        })}
        {shown.length === 0 && <li className="text-sm text-black/60">No court matches.</li>}
      </ul>
      <p className="mt-3 text-xs text-black/60">
        This only changes this time slot on this match day. To change the court for every week, change the default courts in the settings.
      </p>
    </Dialog>
  )
}
