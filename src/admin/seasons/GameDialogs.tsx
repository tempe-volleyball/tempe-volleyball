import { useEffect, useMemo, useState } from 'react'
import {
  courtClashes,
  courtName,
  forfeitResult,
  forfeitRule,
  forfeitScoreText,
  formatLong,
  makeResolver,
  moveToNight,
  suggestCatchUpDate,
  refName,
  type Game,
  type MoveTarget,
} from '../../lib/fixtures'
import { api, type ClashDraws, type SeasonView } from '../api'
import { Button, Dialog, Notice, errorMessage } from '../ui'
import { inputClass } from './styles'

// Dialogs for one game on the Results tab: marking it a forfeit (which team forfeited, so the season's forfeit score
// goes in as its result), and moving it to another night (previewed with the lib's moveToNight(), the same check the
// server runs, plus court clashes with the other leagues at the venue that night).

export type ForfeitChoice = { forfeitedBy: 'home' | 'away'; note: string }

export function ForfeitDialog({
  view,
  game,
  current,
  onConfirm,
  onCancel,
}: {
  view: SeasonView
  game: Game
  current: string
  onConfirm: (c: ForfeitChoice) => void
  onCancel: () => void
}) {
  const s = view.competition.settings
  const resolve = makeResolver(s, view.competition.weeks ?? [])
  const names = { home: refName(s, resolve(game.home)), away: refName(s, resolve(game.away)) }
  const [side, setSide] = useState<'home' | 'away' | ''>('')
  const [note, setNote] = useState(current)
  const rule = forfeitRule(s, view.season.setsPerMatch)
  const score = side ? forfeitResult(rule, side) : null
  return (
    <Dialog title="Mark this game a forfeit" onCancel={onCancel}>
      <div className="space-y-3 text-sm">
        <fieldset className="space-y-2">
          <legend className="mb-1 font-semibold">Which team forfeited?</legend>
          {(['home', 'away'] as const).map((k) => (
            <label key={k} className={`flex gap-2 rounded border px-3 py-2 ${side === k ? 'border-brand bg-brand/5' : 'border-black/15'}`}>
              <input type="radio" name="forfeit" className="accent-brand" checked={side === k} onChange={() => setSide(k)} />
              <span>{names[k]}</span>
            </label>
          ))}
        </fieldset>
        {score ? (
          <p>
            {names[side === 'home' ? 'away' : 'home']} win {forfeitScoreText(rule)}
            {rule.lossPoints ? '' : `, and ${names[side as 'home' | 'away']} get no ladder points`}. That goes in as the result (not yet
            published), and you can still change it. The season’s forfeit score is under Settings → Ladder rules.
          </p>
        ) : (
          <p className="text-black/60">Pick the team that forfeited to fill in the season’s forfeit score.</p>
        )}
        <label className="block">
          <span className="mb-1 block font-semibold">Note (optional, shown on the website)</span>
          <input
            className={inputClass}
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Not enough players"
          />
        </label>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!side} onClick={() => side && onConfirm({ forfeitedBy: side, note: note.trim() })}>
          Mark forfeit
        </Button>
      </div>
    </Dialog>
  )
}

export type MoveChoice = { toWeekId: string } | { date: string }

export function MoveGameDialog({
  view,
  weekId,
  gameId,
  busy,
  onConfirm,
  onCancel,
}: {
  view: SeasonView
  weekId: string
  gameId: string
  busy: boolean
  onConfirm: (c: MoveChoice & { session: number; position: number }) => void
  onCancel: () => void
}) {
  const s = view.competition.settings
  const weeks = useMemo(() => view.competition.weeks ?? [], [view.competition.weeks])
  const from = weeks.find((w) => w.id === weekId)
  const game = from?.games.find((g) => g.id === gameId)
  const resolve = useMemo(() => makeResolver(s, weeks), [s, weeks])
  const nights = weeks.filter((w) => w.kind !== 'skip' && w.id !== weekId && !w.status)
  const fromDate = from?.date
  const suggested = fromDate ? suggestCatchUpDate(weeks, fromDate) : null
  const [mode, setMode] = useState<'existing' | 'new'>(nights.some((w) => w.date > (from?.date ?? '')) ? 'existing' : 'new')
  const [toWeekId, setToWeekId] = useState(() => nights.find((w) => w.date > (from?.date ?? ''))?.id ?? nights[0]?.id ?? '')
  const [date, setDate] = useState(() => suggested?.date ?? '')
  const [slot, setSlot] = useState('')
  // The other leagues' courts on the target night, as last fetched (for which date).
  const [fetched, setFetched] = useState<{ date: string; data: ClashDraws | null; error: string | null }>({
    date: '',
    data: null,
    error: null,
  })

  const target = mode === 'existing' ? weeks.find((w) => w.id === toWeekId) : undefined
  const targetDate = mode === 'existing' ? target?.date : date
  // Slots on the target night: every session × court position, marked when taken.
  const slots = s.sessions.flatMap((time, session) =>
    s.courts.map((_, position) => {
      const taken = target?.games.find((g) => g.session === session && g.court === position)
      const court = target ? courtName(s, target, session, position) : (s.courts[position] ?? '')
      return { key: `${session}:${position}`, session, position, label: `${time} · ${court || 'no court'}`, taken }
    }),
  )
  const firstFree = slots.find((x) => !x.taken)?.key ?? ''
  const chosen = slots.find((x) => x.key === (slot || firstFree))
  const moveTarget: MoveTarget | null = chosen
    ? mode === 'existing'
      ? { weekId: toWeekId, session: chosen.session, position: chosen.position }
      : { date, newWeekId: 'preview', session: chosen.session, position: chosen.position }
    : null
  const result = moveTarget && game ? moveToNight(s, weeks, gameId, moveTarget) : null

  // The other leagues' courts that night, for clashes.
  useEffect(() => {
    if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return
    let live = true
    api<ClashDraws>(`/api/admin/seasons/${view.season.id}/clashes?from=${targetDate}&to=${targetDate}`)
      .then((r) => live && setFetched({ date: targetDate, data: r, error: null }))
      .catch((e: unknown) => live && setFetched({ date: targetDate, data: null, error: errorMessage(e) }))
    return () => {
      live = false
    }
  }, [targetDate, view.season.id])
  const others = fetched.date === targetDate ? fetched.data : null
  const clashError = fetched.date === targetDate ? fetched.error : null
  const clash =
    result?.plan && others
      ? courtClashes([
          { seasonId: view.season.id, label: view.season.name, venue: others.venue ?? '', settings: s, weeks: [result.plan.to] },
          ...others.draws,
        ]).find((x) => x.bookings.some((b) => b.gameId === gameId))
      : undefined

  if (!from || !game) return null
  const vs = `${refName(s, resolve(game.home))} v ${refName(s, resolve(game.away))}`
  const problem = result?.problem ?? (clash ? `That court is taken: ${clash.message}` : null)
  return (
    <Dialog title={`Move ${vs}`} onCancel={onCancel} wide>
      <div className="space-y-4 text-sm">
        <p>
          It’s on match day {from.matchDay}, {formatLong(from.date)}
          {game.status === 'postponed' || game.status === 'tbd' ? ` (${game.status === 'tbd' ? 'TBD' : 'postponed'})` : ''}. It keeps any
          result typed in and its duty team; that night lists it as “moved to …”, the new one as “moved from …”. You can undo it.
        </p>
        <fieldset className="space-y-2">
          <legend className="mb-1 font-semibold">Move it to</legend>
          <label
            className={`flex flex-wrap items-center gap-2 rounded border px-3 py-2 ${mode === 'existing' ? 'border-brand bg-brand/5' : 'border-black/15'}`}
          >
            <input
              type="radio"
              name="move"
              className="accent-brand"
              checked={mode === 'existing'}
              onChange={() => setMode('existing')}
              disabled={!nights.length}
            />
            <span>Another night this season</span>
            <select
              className={`${inputClass} w-auto`}
              value={toWeekId}
              disabled={mode !== 'existing'}
              aria-label="Night"
              onChange={(e) => {
                setToWeekId(e.target.value)
                setSlot('')
              }}
            >
              {nights.map((w) => (
                <option key={w.id} value={w.id}>
                  {formatLong(w.date)} · match day {w.matchDay}
                  {w.kind !== 'regular' ? ' (finals)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label
            className={`flex flex-wrap items-center gap-2 rounded border px-3 py-2 ${mode === 'new' ? 'border-brand bg-brand/5' : 'border-black/15'}`}
          >
            <input type="radio" name="move" className="accent-brand" checked={mode === 'new'} onChange={() => setMode('new')} />
            <span>A new catch-up night on</span>
            <input
              type="date"
              className={`${inputClass} w-auto`}
              value={date}
              disabled={mode !== 'new'}
              aria-label="Date of the new night"
              onChange={(e) => {
                setDate(e.target.value)
                setSlot('')
              }}
            />
            {mode === 'new' && suggested && date === suggested.date && !suggested.beforeFinals && (
              <span className="basis-full text-xs text-black/70">
                No week before the finals is free, so this is after them. If it has to count before the finals are seeded, pick another day
                of the week.
              </span>
            )}
          </label>
        </fieldset>
        <label className="block">
          <span className="mb-1 block font-semibold">Time and court</span>
          <select className={inputClass} value={slot || firstFree} onChange={(e) => setSlot(e.target.value)} aria-label="Time and court">
            {slots.map((x) => (
              <option key={x.key} value={x.key} disabled={!!x.taken}>
                {x.label}
                {x.taken ? ` (taken: ${refName(s, resolve(x.taken.home))} v ${refName(s, resolve(x.taken.away))})` : ''}
              </option>
            ))}
          </select>
        </label>
        {!chosen && <Notice kind="error">Every slot that night is taken. Pick another night.</Notice>}
        {problem && <Notice kind="error">{problem}</Notice>}
        {clashError && (
          <Notice kind="warning">Couldn’t check the other leagues’ courts: {clashError}. The server checks again on save.</Notice>
        )}
        {!problem && result?.plan && result.plan.warnings.length > 0 && (
          <Notice kind="warning">
            <ul className="list-disc pl-5">
              {result.plan.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Notice>
        )}
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          busy={busy}
          disabled={!result?.plan || !!problem || !chosen}
          onClick={() =>
            chosen &&
            onConfirm({
              ...(mode === 'existing' ? { toWeekId } : { date }),
              session: chosen.session,
              position: chosen.position,
            })
          }
        >
          Move the game
        </Button>
      </div>
    </Dialog>
  )
}
