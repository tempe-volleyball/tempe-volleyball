import { Fragment, useMemo, useRef, useState } from 'react'
import {
  byesForWeek,
  courtName,
  dayPublishProblem,
  dayResultsState,
  formatLong,
  isTeam,
  makeResolver,
  outcome,
  refName,
  sameResult,
  type Game,
  type Ref,
  type Result,
  type Settings,
  type Week,
  type WeekResultsState,
} from '../../lib/fixtures'
import type { AdjustmentRow, SeasonView } from '../api'
import { Button, Card, Notice, errorMessage } from '../ui'
import { ConfirmDialog } from './dialogs'
import { formFromResult, resultFromForm, type ResultForm } from './results-form'
import { Ladder } from './Ladder'
import { inputClass } from './SetupTab'

// Results, one match day at a time (ported from the demo's ResultsTab, now set by set): type the scores, Save the
// day (a draft only the admin sees), then Publish it (the ladder and website change). A published day can be
// corrected and republished, or its unpublished changes undone. Games can be marked forfeit or cancelled.
// Built to work on a phone at the courts.

export type DayEdit = {
  /** The day as being edited (unsaved). */
  week: Week
  /** By game id: what's wrong with a half-typed score. */
  problems: Record<string, string>
}

export type GameStatus = 'played' | 'forfeit' | 'cancelled'

export type ResultsActions = {
  onResult: (weekId: string, gameId: string, result: Result | undefined, problem: string | null) => void
  onSave: (weekId: string) => void
  onPublish: (weekId: string) => void
  onDiscard: (weekId: string) => void
  onUndo: (weekId: string) => void
  onStatus: (weekId: string, gameId: string, status: GameStatus) => void
  onAddAdjustment: (a: { teamId: string; points: number; reason: string }) => Promise<void>
  onUpdateAdjustment: (id: string, a: { points: number; reason: string }) => Promise<void>
  onDeleteAdjustment: (id: string) => Promise<void>
}

export function ResultsTab({
  view,
  edits,
  busyDay,
  canEnter,
  isAdmin,
  resets,
  actions,
}: {
  view: SeasonView
  edits: Record<string, DayEdit>
  /** Bumped per match day (and `all` for every day) to reset the boxes to the results. */
  resets: Record<string, number> & { all: number }
  /** The match day being saved or published. */
  busyDay: string | null
  /** False for archived seasons. */
  canEnter: boolean
  isAdmin: boolean
  actions: ResultsActions
}) {
  const s = view.competition.settings
  const weeks = view.competition.weeks!
  const [highlight, setHighlight] = useState('')
  // Finals placeholders resolve from published results only.
  const resolve = useMemo(() => makeResolver(s, weeks), [s, weeks])
  const status = (id: string) => view.matches[id]?.status ?? 'scheduled'

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_32rem]">
      <div className="min-w-0 space-y-4">
        <p className="text-sm text-black/60">
          Enter each match day's set scores as results come in, Save, then Publish. The ladder and website only change when a match day is
          published, and a published day can be corrected and published again.
          {view.season.setsPerMatch === 5 ? ' Best of 5: leave the sets that weren’t played blank.' : ''}
        </p>
        {weeks.map((w) =>
          w.kind === 'skip' ? (
            <div key={w.id} className="rounded border border-dashed border-black/20 px-4 py-2.5 text-sm text-black/60">
              <span className="font-semibold">{formatLong(w.date)}</span> · No games · {w.note || 'Week off'}
            </div>
          ) : (
            <MatchDay
              key={w.id}
              saved={w}
              edit={edits[w.id]}
              settings={s}
              setsPerMatch={view.season.setsPerMatch}
              resolve={resolve}
              status={status}
              highlight={highlight}
              busy={busyDay === w.id}
              canEnter={canEnter}
              resetKey={`${resets.all}:${resets[w.id] ?? 0}`}
              actions={actions}
            />
          ),
        )}
      </div>

      <aside className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
        <Ladder
          settings={s}
          weeks={weeks}
          adjustments={view.adjustments}
          highlight={highlight}
          onToggle={(id) => setHighlight((h) => (h === id ? '' : id))}
        />
        <Adjustments view={view} canEdit={isAdmin && canEnter} actions={actions} />
      </aside>
    </div>
  )
}

const STAGE: Record<Week['kind'], string> = { regular: '', semi: 'Semi finals', final: 'Finals', skip: '' }

const STATUS: Record<WeekResultsState, { text: string; cls: string }> = {
  empty: { text: 'Not entered', cls: 'bg-black/5 text-black/60' },
  entering: { text: 'Entering', cls: 'bg-accent/20 text-ink' },
  ready: { text: 'Ready to publish', cls: 'bg-accent text-ink' },
  published: { text: '✓ Published', cls: 'bg-brand text-white' },
  changed: { text: 'Changed since publishing', cls: 'bg-accent text-ink' },
}

function MatchDay({
  saved,
  edit,
  settings: s,
  setsPerMatch,
  resolve,
  status,
  highlight,
  busy,
  canEnter,
  resetKey,
  actions,
}: {
  saved: Week
  edit: DayEdit | undefined
  /** Changes when the typed-in boxes should start again from the results (after discard, undo or a reload). */
  resetKey: string
  settings: Settings
  setsPerMatch: number
  resolve: (r: Ref | null) => Ref | null
  status: (gameId: string) => string
  highlight: string
  busy: boolean
  canEnter: boolean
  actions: ResultsActions
}) {
  const w = edit?.week ?? saved
  const cancelled = new Set(w.games.filter((g) => status(g.id) === 'cancelled').map((g) => g.id))
  const savedState = dayResultsState(saved, cancelled)
  const state = dayResultsState(w, cancelled)
  const problems = Object.values(edit?.problems ?? {})
  const problem = problems[0] ?? dayPublishProblem(w, cancelled)
  const waiting = w.games.some((g) => !cancelled.has(g.id) && (!isTeam(resolve(g.home)) || !isTeam(resolve(g.away))))
  const unsaved = !!edit
  const wasPublished = !!saved.resultsPublishedAt || savedState === 'published' || savedState === 'changed'
  // Published days are read-only until the pencil is pressed; unpublished edits (saved or not) reopen them.
  const [opened, setOpened] = useState(false)
  const editing = canEnter && (!wasPublished || opened || unsaved || savedState === 'changed')
  const label = unsaved
    ? { text: 'Unsaved changes', cls: 'bg-accent/30 text-ink' }
    : waiting && state === 'empty'
      ? { text: 'Waiting for earlier results', cls: 'bg-black/5 text-black/60' }
      : STATUS[state]
  const byes = byesForWeek(s, w)
  const canPublish = !problem && !waiting && (state === 'ready' || state === 'changed' || (unsaved && state === 'published'))

  return (
    <section
      id={`results-${w.id}`}
      className={`rounded border-2 bg-white shadow-sm ${unsaved || state === 'changed' ? 'border-accent' : state === 'published' ? 'border-brand/40' : 'border-black/10'}`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-black/10 px-3 py-2.5 sm:px-4">
        <h3 className="font-bold">
          Match day {w.matchDay}
          {STAGE[w.kind] && <span className="bg-accent ml-2 rounded px-1.5 py-0.5 text-xs">{STAGE[w.kind]}</span>}
        </h3>
        <span className="text-sm text-black/60">{formatLong(w.date)}</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${label.cls}`}>{label.text}</span>
          {canEnter && !editing && (
            <button
              type="button"
              onClick={() => setOpened(true)}
              aria-label={`Edit match day ${w.matchDay} results`}
              title="Edit results"
              className="rounded p-1.5 text-black/60 hover:bg-black/5 hover:text-black focus:ring-2 focus:ring-accent focus:outline-none"
            >
              <PencilIcon />
            </button>
          )}
        </span>
      </header>

      <ul className="divide-y divide-black/10">
        {w.games.map((g) => (
          <ResultRow
            key={`${g.id}:${resetKey}`}
            game={g}
            week={w}
            settings={s}
            setsPerMatch={setsPerMatch}
            resolve={resolve}
            status={status(g.id)}
            highlight={highlight}
            editing={editing && !busy}
            problem={edit?.problems[g.id]}
            onChange={(r, p) => actions.onResult(w.id, g.id, r, p)}
            onStatus={(st) => actions.onStatus(w.id, g.id, st)}
          />
        ))}
      </ul>

      <footer className="flex flex-wrap items-center gap-2 border-t border-black/10 px-3 py-2.5 sm:px-4">
        {byes.length > 0 && <span className="text-xs text-black/60">Bye: {byes.map((t) => refName(s, { team: t })).join(', ')}</span>}
        <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {editing && problem && state !== 'empty' && <span className="text-xs text-black/70">{problem}</span>}
          {unsaved && (
            <>
              <Button variant="secondary" className="py-1.5" disabled={busy} onClick={() => actions.onDiscard(w.id)}>
                Discard
              </Button>
              <Button
                variant="secondary"
                className="py-1.5"
                busy={busy}
                disabled={problems.length > 0}
                onClick={() => actions.onSave(w.id)}
              >
                Save
              </Button>
            </>
          )}
          {!unsaved && savedState === 'changed' && canEnter && (
            <Button
              variant="secondary"
              className="py-1.5"
              busy={busy}
              onClick={() => actions.onUndo(w.id)}
              title="Go back to the published results"
            >
              Undo changes
            </Button>
          )}
          {!unsaved && opened && savedState === 'published' && (
            <Button variant="secondary" className="py-1.5" onClick={() => setOpened(false)}>
              Done
            </Button>
          )}
          {editing && (
            <Button
              className="py-1.5"
              busy={busy}
              disabled={!canPublish}
              onClick={() => {
                setOpened(false)
                actions.onPublish(w.id)
              }}
            >
              {wasPublished ? (unsaved ? 'Save and publish changes' : 'Publish changes') : unsaved ? 'Save and publish' : 'Publish results'}
            </Button>
          )}
        </span>
      </footer>
    </section>
  )
}

function ResultRow({
  game: g,
  week: w,
  settings: s,
  setsPerMatch,
  resolve,
  status,
  highlight,
  editing,
  problem,
  onChange,
  onStatus,
}: {
  game: Game
  week: Week
  settings: Settings
  setsPerMatch: number
  resolve: (r: Ref | null) => Ref | null
  status: string
  highlight: string
  editing: boolean
  problem: string | undefined
  onChange: (r: Result | undefined, problem: string | null) => void
  onStatus: (s: GameStatus) => void
}) {
  const home = resolve(g.home)
  const away = resolve(g.away)
  const ready = isTeam(home) && isTeam(away)
  const cancelled = status === 'cancelled'
  const [form, setForm] = useState<ResultForm>(() => formFromResult(g.result, setsPerMatch))
  const o = outcome(g.result)
  const pub = g.publishedResult
  const changed = !!pub && !sameResult(pub, g.result)
  const disabled = !editing || !ready || cancelled

  const update = (next: ResultForm) => {
    setForm(next)
    const { result, problem: p } = resultFromForm(next)
    onChange(result, p)
  }

  const side = (r: Ref | null, original: Ref, won: boolean) => (
    <div className="min-w-0">
      <div
        className={`truncate ${!isTeam(r) ? 'text-black/60 italic' : won ? 'text-ink font-bold' : o ? 'text-black/60' : 'font-semibold'} ${
          isTeam(r) && r.team === highlight ? 'bg-accent inline rounded px-1' : ''
        }`}
      >
        {refName(s, r)}
      </div>
      {/* in the finals, keep showing where a team came from */}
      {!isTeam(original) && isTeam(r) && <div className="text-[11px] text-black/60">{original.label}</div>}
    </div>
  )

  const box = (id: string, value: string, label: string, onValue: (v: string) => void, next?: string, wide?: boolean) => (
    <input
      id={id}
      aria-label={label}
      inputMode="numeric"
      pattern="[0-9]*"
      maxLength={wide ? 3 : 2}
      disabled={disabled}
      value={value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        const v = e.target.value.replace(/\D/g, '').slice(0, wide ? 3 : 2)
        onValue(v)
        if (!wide && v.length === 2 && next) document.getElementById(next)?.focus()
      }}
      className={`h-10 w-11 rounded border text-center text-base font-bold tabular-nums outline-none focus:border-brand focus:ring-2 focus:ring-accent/60 disabled:border-transparent disabled:bg-transparent disabled:text-ink sm:h-9 ${
        changed ? 'border-accent bg-accent/10' : 'border-black/20 bg-white'
      }`}
    />
  )

  const setsMode = form.mode === 'sets'
  const homeName = refName(s, home)
  const awayName = refName(s, away)
  const totals = (i: 0 | 1) => {
    const r = g.result
    if (!r) return '–'
    return String((i === 0 ? r.home : r.away) ?? '–')
  }
  const cols = setsMode ? form.sets.length : 2
  const stacked = setsMode && cols > 3

  return (
    <li className={`px-3 py-2.5 sm:px-4 ${cancelled ? 'bg-black/5' : ''}`}>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs text-black/60">
        <span className="text-ink font-semibold">{s.sessions[g.session]}</span>
        <span>{courtName(s, w, g.session, g.court)}</span>
        {g.title && <span className="text-brand font-bold tracking-wider uppercase">{g.title}</span>}
        {status === 'forfeit' && <span className="rounded bg-red-50 px-1.5 font-semibold text-red-800">Forfeit</span>}
        {cancelled && <span className="rounded bg-black/10 px-1.5 font-semibold text-black/70">Cancelled</span>}
        {editing && ready && (
          <select
            aria-label={`Status of ${homeName} v ${awayName}`}
            value={status === 'forfeit' || status === 'cancelled' ? status : 'played'}
            onChange={(e) => onStatus(e.target.value as GameStatus)}
            className="ml-auto rounded border border-black/20 bg-white px-1.5 py-1 text-xs"
          >
            <option value="played">Played</option>
            <option value="forfeit">Forfeit</option>
            <option value="cancelled">Cancelled</option>
          </select>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] font-semibold tracking-wider text-black/60 uppercase">
              <th className={`text-left font-semibold ${stacked ? 'hidden sm:table-cell' : ''}`}>
                <span className="sr-only">Team</span>
              </th>
              {setsMode ? (
                form.sets.map((_, i) => (
                  <th key={i} className="w-12 text-center font-semibold">
                    Set {i + 1}
                  </th>
                ))
              ) : (
                <>
                  <th className="w-12 text-center font-semibold">Sets</th>
                  <th className="w-14 text-center font-semibold">Points</th>
                </>
              )}
              {setsMode && <th className="w-10 text-center font-semibold">Sets</th>}
            </tr>
          </thead>
          <tbody>
            {([0, 1] as const).map((side_) => {
              const team = side_ === 0 ? home : away
              const original = side_ === 0 ? g.home : g.away
              const won = o === (side_ === 0 ? 'home' : 'away')
              const name = side_ === 0 ? homeName : awayName
              return (
                <Fragment key={side_}>
                  {/* On a phone, a best of 5 has no room beside the boxes: the name goes on its own line. */}
                  {stacked && (
                    <tr className="sm:hidden">
                      <td colSpan={cols + 1} className="pt-1">
                        {side(team, original, won)}
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td className={`max-w-0 py-0.5 pr-2 ${stacked ? 'hidden sm:table-cell' : ''}`}>{side(team, original, won)}</td>
                    {setsMode
                      ? form.sets.map((pair, i) => (
                          <td key={i} className="py-0.5 text-center">
                            {box(
                              `${g.id}-s${i}-${side_}`,
                              pair[side_],
                              `${name}, set ${i + 1}`,
                              (v) =>
                                update({ ...form, sets: form.sets.map((p, j) => (j === i ? (side_ === 0 ? [v, p[1]] : [p[0], v]) : p)) }),
                              side_ === 0 ? `${g.id}-s${i}-1` : i + 1 < cols ? `${g.id}-s${i + 1}-0` : undefined,
                            )}
                          </td>
                        ))
                      : ([0, 2] as const).map((k) => (
                          <td key={k} className="py-0.5 text-center">
                            {box(
                              `${g.id}-t${k + side_}`,
                              form.totals[k + side_]!,
                              `${name} ${k === 0 ? 'sets' : 'points'}`,
                              (v) => {
                                const next = [...form.totals] as ResultForm['totals']
                                next[k + side_] = v
                                update({ ...form, totals: next })
                              },
                              undefined,
                              k === 2,
                            )}
                          </td>
                        ))}
                    {setsMode && <td className="text-center text-base font-bold tabular-nums">{totals(side_)}</td>}
                  </tr>
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {problem && editing && <p className="mt-1 text-xs text-red-700">{problem}</p>}
      {!ready && <p className="mt-1 text-xs text-black/60">Teams are decided once the earlier results are published.</p>}
      {editing && ready && !cancelled && (
        <div className="mt-1 flex gap-3 text-xs">
          <button
            type="button"
            className="text-brand hover:underline"
            onClick={() => update(setsMode ? { ...form, mode: 'totals' } : { ...form, mode: 'sets' })}
          >
            {setsMode ? 'Enter sets and points totals instead' : 'Enter set scores instead'}
          </button>
          {g.result && (
            <button
              type="button"
              className="text-black/60 hover:text-red-700 hover:underline"
              onClick={() => update(formFromResult(undefined, setsPerMatch))}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </li>
  )
}

function Adjustments({ view, canEdit, actions }: { view: SeasonView; canEdit: boolean; actions: ResultsActions }) {
  const teams = view.competition.settings.teams
  const name = (id: string) => teams.find((t) => t.id === id)?.name ?? 'Unknown team'
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<AdjustmentRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  if (!canEdit && view.adjustments.length === 0) return null
  return (
    <Card
      title="Ladder adjustments"
      actions={
        canEdit && !adding ? (
          <Button variant="link" onClick={() => setAdding(true)}>
            Add
          </Button>
        ) : undefined
      }
    >
      <p className="-mt-2 mb-3 text-xs text-black/60">
        Points added to (or taken off) a team's ladder total, e.g. a penalty. Saved straight away.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      {view.adjustments.length === 0 && !adding && <p className="text-sm text-black/60">None.</p>}
      <ul className="space-y-2 text-sm">
        {view.adjustments.map((a) =>
          editingId === a.id ? (
            <li key={a.id}>
              <AdjustmentForm
                teams={teams}
                initial={a}
                busy={busy}
                onCancel={() => setEditingId(null)}
                onSubmit={(v) =>
                  void run(() => actions.onUpdateAdjustment(a.id, { points: v.points, reason: v.reason })).then(
                    (ok) => ok && setEditingId(null),
                  )
                }
              />
            </li>
          ) : (
            <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-semibold">{name(a.teamId)}</span>
              <span className={`font-bold tabular-nums ${a.points < 0 ? 'text-red-700' : 'text-brand'}`}>
                {a.points > 0 ? '+' : ''}
                {a.points}
              </span>
              <span className="text-black/60">{a.reason}</span>
              {canEdit && (
                <span className="ml-auto flex gap-2">
                  <Button variant="link" onClick={() => setEditingId(a.id)}>
                    Edit
                  </Button>
                  <Button variant="link" className="text-red-700" onClick={() => setRemoving(a)}>
                    Remove
                  </Button>
                </span>
              )}
            </li>
          ),
        )}
      </ul>
      {removing && (
        <ConfirmDialog
          title="Remove this adjustment?"
          confirmLabel="Remove"
          danger
          onConfirm={() => {
            const adjId = removing.id
            setRemoving(null)
            void run(() => actions.onDeleteAdjustment(adjId))
          }}
          onCancel={() => setRemoving(null)}
        >
          <p>
            {removing.points > 0 ? '+' : ''}
            {removing.points} for {name(removing.teamId)} ({removing.reason}). The ladder changes straight away.
          </p>
        </ConfirmDialog>
      )}
      {adding && (
        <div className="mt-3">
          <AdjustmentForm
            teams={teams}
            busy={busy}
            onCancel={() => setAdding(false)}
            onSubmit={(v) => void run(() => actions.onAddAdjustment(v)).then((ok) => ok && setAdding(false))}
          />
        </div>
      )}
    </Card>
  )
}

function AdjustmentForm({
  teams,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  teams: { id: string; name: string }[]
  initial?: AdjustmentRow
  busy: boolean
  onSubmit: (v: { teamId: string; points: number; reason: string }) => void
  onCancel: () => void
}) {
  const [teamId, setTeamId] = useState(initial?.teamId ?? teams[0]?.id ?? '')
  const [points, setPoints] = useState(String(initial?.points ?? -1))
  const [reason, setReason] = useState(initial?.reason ?? '')
  const ref = useRef<HTMLFormElement>(null)
  const n = Number(points)
  const valid = teamId && Number.isInteger(n) && n !== 0 && Math.abs(n) <= 100 && reason.trim()
  return (
    <form
      ref={ref}
      className="space-y-2 rounded bg-black/5 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSubmit({ teamId, points: n, reason: reason.trim() })
      }}
    >
      <div className="grid grid-cols-[1fr_5rem] gap-2">
        <select className={inputClass} value={teamId} disabled={!!initial} onChange={(e) => setTeamId(e.target.value)} aria-label="Team">
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <input
          className={inputClass}
          type="number"
          min={-100}
          max={100}
          value={points}
          onChange={(e) => setPoints(e.target.value)}
          aria-label="Points (negative for a penalty)"
        />
      </div>
      <input
        className={inputClass}
        value={reason}
        maxLength={200}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason, e.g. forfeit penalty"
        aria-label="Reason"
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" busy={busy} disabled={!valid}>
          {initial ? 'Save' : 'Add'}
        </Button>
      </div>
    </form>
  )
}

function PencilIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden
    >
      <path d="M13.5 3.5l3 3L7 16H4v-3z" />
      <path d="M11.5 5.5l3 3" />
    </svg>
  )
}
