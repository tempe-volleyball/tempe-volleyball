import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { GENDER_OPTIONS } from '../../lib/enrolment/forms'
import type { Directory, DirectoryPlayer } from '../api'
import { Button, Dialog, EmptyState, LoadError, Notice, Skeleton } from '../ui'
import {
  GENDER_SHORT,
  PICKER_TAB_LABELS,
  answerLabel,
  lastPlayed,
  moveActive,
  pickerCounts,
  pickerRows,
  pickerTabs,
  playerName,
  retiredMatching,
  type PickerTab,
  type Placed,
} from './roster-helpers'
import { inputClass } from './styles'

// The season builder's player picker (docs/interest.md "Season rosters"): tabs for New interest, Last season, Past
// players, Retired and All, an instant search, and "Add a new player". Adding picks several (checkboxes); replacing
// picks one. Keyboard: the search box drives the list (↑/↓, Home/End, Page Up/Down, Enter to tick or pick), the
// tabs are a tab list (←/→). A few hundred players render at once; past 150 rows the list asks before showing more.

export type NewPlayer = { firstName: string; lastName: string; email: string; phone: string; gender: string }

const SHOW = 150

export function PlayerPicker({
  mode,
  teams,
  teamId: initialTeam,
  replacing,
  directory,
  directoryError,
  onRetry,
  placed,
  initialTab,
  busy,
  error,
  onCancel,
  onAdd,
  onReplace,
}: {
  mode: 'add' | 'replace'
  /** The season's saved teams (where players can go). */
  teams: { id: string; name: string }[]
  teamId: string
  /** Replace mode: who's being replaced. */
  replacing?: { playerId: string; name: string }
  directory: Directory | null
  directoryError: string | null
  onRetry: () => void
  placed: Placed
  initialTab?: PickerTab
  busy: boolean
  error: string | null
  onCancel: () => void
  onAdd: (teamId: string, playerIds: string[], newPlayers: NewPlayer[]) => void
  onReplace: (pick: { playerId: string } | { newPlayer: NewPlayer }) => void
}) {
  const players = useMemo(() => directory?.players ?? [], [directory])
  const counts = useMemo(() => pickerCounts(players), [players])
  // Until a tab is picked, open on the first one with someone in it.
  const [chosenTab, setTab] = useState<PickerTab | null>(initialTab ?? null)
  const tab: PickerTab = chosenTab ?? (counts.interest > 0 ? 'interest' : counts.last > 0 ? 'last' : 'all')
  const [query, setQuery] = useState('')
  const [teamId, setTeamId] = useState(initialTeam)
  const [selected, setSelected] = useState<string[]>([])
  const [fresh, setFresh] = useState<NewPlayer[]>([])
  const [adding, setAdding] = useState(false)
  const [active, setActive] = useState(-1)
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  // After the Dialog's showModal() (a child's effect runs first): React's autoFocus fires before the dialog is open.
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => searchRef.current?.focus(), [])
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])
  const teamName = teams.find((t) => t.id === teamId)?.name ?? 'the team'

  const rows = useMemo(() => pickerRows(players, tab, query), [players, tab, query])
  const shown = showAll ? rows : rows.slice(0, SHOW)
  const hiddenRetired = tab === 'all' ? retiredMatching(players, query) : 0
  const changeTab = (t: PickerTab) => {
    setTab(t)
    setActive(-1)
    setShowAll(false)
  }
  const changeQuery = (q: string) => {
    setQuery(q)
    setActive(-1)
    setShowAll(false)
  }
  useEffect(() => {
    if (active < 0) return
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const isSelected = (id: string) => selected.includes(id)
  const inThisTeam = (id: string) => placed.get(id)?.teamId === teamId
  const pick = (p: DirectoryPlayer) => {
    if (mode === 'replace') {
      if (inThisTeam(p.id)) return
      setSelected([p.id])
      return
    }
    if (inThisTeam(p.id)) return
    setSelected((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))
  }

  const total = selected.length + fresh.length
  const submit = () => {
    if (mode === 'replace') {
      if (selected[0]) onReplace({ playerId: selected[0] })
      return
    }
    if (total > 0) onAdd(teamId, selected, fresh)
  }
  const chosen = selected.map((id) => players.find((p) => p.id === id)).filter((p): p is DirectoryPlayer => !!p)
  const title = mode === 'replace' ? `Replace ${replacing?.name ?? 'a player'} in ${teamName}` : `Add players to ${teamName}`

  const footer = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 text-sm text-black/70" aria-live="polite">
        {mode === 'replace'
          ? chosen[0]
            ? `${playerName(chosen[0])} takes ${replacing?.name ?? 'their'}’s place${placed.get(chosen[0].id) ? ` (moving from ${placed.get(chosen[0].id)!.teamName})` : ''}.`
            : 'Pick who takes their place.'
          : total === 0
            ? 'Tick the players to add.'
            : `${total} to add${movers(chosen, placed)}.`}
      </span>
      {total > 0 && mode === 'add' && (
        <Button
          variant="link"
          className="text-xs"
          onClick={() => {
            setSelected([])
            setFresh([])
          }}
        >
          Clear
        </Button>
      )}
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button busy={busy} disabled={mode === 'replace' ? !selected[0] : total === 0} onClick={submit}>
        {mode === 'replace' ? 'Replace' : total > 1 ? `Add ${total} players` : 'Add player'}
      </Button>
    </div>
  )

  return (
    <Dialog title={title} onCancel={onCancel} wide sheet footer={footer} dirty={total > 0 || adding}>
      <div className="space-y-3">
        {error && <Notice kind="error">{error}</Notice>}
        {mode === 'add' && teams.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="shrink-0 font-semibold">Add to</span>
            <select className={`${inputClass} w-auto`} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div role="tablist" aria-label="Players" className="-mx-1 flex overflow-x-auto border-b border-black/10 [scrollbar-width:none]">
          {pickerTabs.map((t, i) => (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[i] = el
              }}
              type="button"
              role="tab"
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              className={`border-b-4 px-2.5 py-2 text-sm font-semibold whitespace-nowrap ${
                tab === t ? 'border-accent text-ink' : 'border-transparent text-black/60 hover:text-black'
              }`}
              onClick={() => changeTab(t)}
              onKeyDown={(e) => {
                if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                e.preventDefault()
                const j = (i + (e.key === 'ArrowRight' ? 1 : pickerTabs.length - 1)) % pickerTabs.length
                changeTab(pickerTabs[j]!)
                tabRefs.current[j]?.focus()
              }}
            >
              {PICKER_TAB_LABELS[t]} <span className="text-xs font-normal text-black/60">{directory ? counts[t] : ''}</span>
            </button>
          ))}
        </div>

        <input
          className={inputClass}
          ref={searchRef}
          type="search"
          placeholder="Search by name, email or phone"
          aria-label="Search players"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={active >= 0 && shown[active] ? `${listId}-${shown[active]!.id}` : undefined}
          value={query}
          onChange={(e) => changeQuery(e.target.value)}
          onKeyDown={(e) => {
            if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(e.key)) {
              if ((e.key === 'Home' || e.key === 'End') && active < 0) return
              e.preventDefault()
              setActive((a) => moveActive(a, e.key, shown.length))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if ((e.metaKey || e.ctrlKey) && total > 0) submit()
              else if (active >= 0 && shown[active]) pick(shown[active]!)
            }
          }}
        />

        {directoryError ? (
          <LoadError message={directoryError} onRetry={onRetry} />
        ) : !directory ? (
          <Skeleton lines={6} label="Loading players…" />
        ) : rows.length === 0 ? (
          <EmptyState title={query ? 'Nobody matches that search.' : `No one in ${PICKER_TAB_LABELS[tab]}.`}>
            {hiddenRetired > 0
              ? `${hiddenRetired} retired player${hiddenRetired > 1 ? 's match' : ' matches'}: see the Retired tab.`
              : tab === 'interest'
                ? 'Expressions of interest sent since last season started show here.'
                : 'Try All, or add a new player below.'}
          </EmptyState>
        ) : (
          <>
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label={`${PICKER_TAB_LABELS[tab]} players`}
              aria-multiselectable={mode === 'add' || undefined}
              className="divide-y divide-black/10 rounded border border-black/10"
            >
              {shown.map((p, i) => (
                <PickerRow
                  key={p.id}
                  id={`${listId}-${p.id}`}
                  index={i}
                  player={p}
                  mode={mode}
                  active={i === active}
                  selected={isSelected(p.id)}
                  placedIn={placed.get(p.id)?.teamName ?? null}
                  inThisTeam={inThisTeam(p.id)}
                  onPick={() => {
                    setActive(i)
                    pick(p)
                  }}
                />
              ))}
            </ul>
            {rows.length > shown.length && (
              <Button variant="link" className="text-sm" onClick={() => setShowAll(true)}>
                Show all {rows.length} (or search to narrow it down)
              </Button>
            )}
            {hiddenRetired > 0 && (
              <p className="text-xs text-black/60">
                {hiddenRetired} retired player{hiddenRetired > 1 ? 's also match' : ' also matches'}: see the Retired tab.
              </p>
            )}
          </>
        )}

        {fresh.length > 0 && (
          <div className="rounded bg-black/5 px-3 py-2 text-sm">
            <p className="font-semibold">New players to add</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {fresh.map((f, i) => (
                <li key={i} className="flex items-center gap-1 rounded-full border border-black/15 bg-white py-0.5 pr-1 pl-2.5">
                  {f.firstName} {f.lastName}
                  <button
                    type="button"
                    aria-label={`Don’t add ${f.firstName} ${f.lastName}`}
                    className="h-6 w-6 rounded-full text-black/60 hover:bg-red-50 hover:text-red-700"
                    onClick={() => setFresh((x) => x.filter((_, j) => j !== i))}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {adding ? (
          <NewPlayerForm
            cta={mode === 'replace' ? `Replace with this player` : 'Add to the list'}
            onCancel={() => setAdding(false)}
            onDone={(np) => {
              setAdding(false)
              if (mode === 'replace') onReplace({ newPlayer: np })
              else setFresh((x) => [...x, np])
            }}
          />
        ) : (
          <Button variant="secondary" className="text-sm" onClick={() => setAdding(true)}>
            + Add a new player
          </Button>
        )}
      </div>
    </Dialog>
  )
}

function PickerRow({
  id,
  index,
  player: p,
  mode,
  active,
  selected,
  placedIn,
  inThisTeam,
  onPick,
}: {
  id: string
  index: number
  player: DirectoryPlayer
  mode: 'add' | 'replace'
  active: boolean
  selected: boolean
  placedIn: string | null
  inThisTeam: boolean
  onPick: () => void
}) {
  const level = answerLabel(p.interest?.level)
  const position = answerLabel(p.interest?.position)
  const last = lastPlayed(p)
  return (
    <li
      id={id}
      data-index={index}
      role="option"
      aria-selected={selected}
      aria-disabled={inThisTeam || undefined}
      className={`flex cursor-pointer items-start gap-3 px-3 py-2.5 text-sm ${active ? 'bg-brand/10 outline-brand outline-2 -outline-offset-2' : 'hover:bg-black/5'} ${
        inThisTeam ? 'cursor-default opacity-60' : ''
      }`}
      onClick={onPick}
    >
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border text-xs text-white ${mode === 'replace' ? 'rounded-full' : 'rounded'} ${
          selected ? 'bg-brand border-brand' : 'border-black/30 bg-white'
        }`}
      >
        {selected ? '✓' : ''}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold">{playerName(p)}</span>
          {p.gender && (
            <span className="text-xs text-black/60" title={p.gender.replaceAll('_', ' ')}>
              {GENDER_SHORT[p.gender]}
            </span>
          )}
          {level && <Badge>{level}</Badge>}
          {position && <Badge>{position}</Badge>}
          {inThisTeam ? <Badge tone="brand">In this team</Badge> : placedIn ? <Badge tone="accent">In {placedIn}</Badge> : null}
          {p.retiredAt && <Badge>Retired</Badge>}
        </span>
        <span className="mt-0.5 block truncate text-xs text-black/60">
          {[
            p.interest
              ? `${p.interest.reference}${p.interest.kind === 'team' && p.interest.teamName ? ` (team ${p.interest.teamName})` : ''}`
              : null,
            last ? `Last: ${last}` : 'No roster yet',
            p.email || null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
    </li>
  )
}

/** " (Sam Lee moves from Aces)" for the footer. */
const movers = (chosen: DirectoryPlayer[], placed: Placed) => {
  const m = chosen.filter((p) => placed.get(p.id))
  if (m.length === 0) return ''
  if (m.length === 1) return ` (${playerName(m[0]!)} moves from ${placed.get(m[0]!.id)!.teamName})`
  return ` (${m.length} move from other teams)`
}

export function Badge({ children, tone }: { children: React.ReactNode; tone?: 'brand' | 'accent' }) {
  const cls = tone === 'brand' ? 'bg-brand text-white' : tone === 'accent' ? 'bg-accent/40 text-ink' : 'bg-black/10 text-ink'
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[0.7rem] leading-tight font-semibold ${cls}`}>{children}</span>
}

function NewPlayerForm({ cta, onCancel, onDone }: { cta: string; onCancel: () => void; onDone: (p: NewPlayer) => void }) {
  const [p, setP] = useState<NewPlayer>({ firstName: '', lastName: '', email: '', phone: '', gender: '' })
  const set = (patch: Partial<NewPlayer>) => setP((x) => ({ ...x, ...patch }))
  return (
    <form
      className="space-y-3 rounded border border-black/10 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!p.firstName.trim()) return
        onDone({ ...p, firstName: p.firstName.trim(), lastName: p.lastName.trim(), email: p.email.trim(), phone: p.phone.trim() })
      }}
    >
      <p className="text-sm font-semibold">A new player</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-semibold">First name</span>
          <input
            className={inputClass}
            required
            autoFocus
            maxLength={80}
            value={p.firstName}
            onChange={(e) => set({ firstName: e.target.value })}
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-semibold">Last name</span>
          <input className={inputClass} maxLength={80} value={p.lastName} onChange={(e) => set({ lastName: e.target.value })} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-semibold">Email (optional)</span>
          <input className={inputClass} type="email" maxLength={254} value={p.email} onChange={(e) => set({ email: e.target.value })} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-semibold">Phone (optional)</span>
          <input className={inputClass} type="tel" maxLength={40} value={p.phone} onChange={(e) => set({ phone: e.target.value })} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-semibold">Gender (optional)</span>
          <select className={inputClass} value={p.gender} onChange={(e) => set({ gender: e.target.value })}>
            <option value="">Not given</option>
            {GENDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-black/60">
        Someone with the same email and name is matched to their existing record rather than added twice.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="secondary" disabled={!p.firstName.trim()}>
          {cta}
        </Button>
        <Button variant="link" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
