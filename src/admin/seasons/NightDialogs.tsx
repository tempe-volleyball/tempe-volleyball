import { useMemo, useState } from 'react'
import { formatLong, nightNote, pushBack, pushBackProblem, type Settings, type Team, type Week } from '../../lib/fixtures'
import { sydneyDate } from '../../lib/time'
import { Button, Dialog, Notice } from '../ui'
import { inputClass } from './SetupTab'

// Dialogs for running a published season: a whole night postponed or cancelled (optionally pushing the rest of the
// season back a week, previewed with the same lib code the server runs), one game's status with a public note, and
// withdrawing a team.

export type NightChoice = { action: 'postpone' | 'cancel'; pushBack: boolean; note: string }

export function NightDialog({
  week,
  weeks,
  settings,
  busy,
  onConfirm,
  onCancel,
}: {
  week: Week
  weeks: Week[]
  settings: Settings
  busy: boolean
  onConfirm: (c: NightChoice) => void
  onCancel: () => void
}) {
  const blocked = pushBackProblem(weeks, week.id)
  const [choice, setChoice] = useState<'push' | 'postpone' | 'cancel'>(blocked ? 'postpone' : 'push')
  const [note, setNote] = useState('')
  const plan = useMemo(
    () =>
      blocked
        ? null
        : pushBack(weeks, week.id, {
            skipId: 'preview',
            note: nightNote('postponed', note),
            status: 'postponed',
            skipDates: settings.skipDates,
          }),
    [blocked, weeks, week.id, note, settings.skipDates],
  )
  const options = [
    {
      id: 'push' as const,
      label: 'Play these games a week later, and push the rest of the season back a week',
      hint: blocked ?? 'Every night from this one moves a week later. Weeks off and public holidays stay where they are.',
    },
    {
      id: 'postpone' as const,
      label: 'Postpone these games (new date to be decided)',
      hint: 'The night stays on the fixtures as “Postponed”.',
    },
    { id: 'cancel' as const, label: 'Cancel these games (they won’t be played)', hint: 'Any results typed in for them are cleared.' },
  ]
  const byId = new Map(weeks.map((w) => [w.id, w]))

  return (
    <Dialog title={`Match day ${week.matchDay}, ${formatLong(week.date)}`} onCancel={onCancel} wide>
      <div className="space-y-4 text-sm">
        <fieldset className="space-y-2">
          <legend className="mb-1 font-semibold">What happens to this night’s {week.games.length} games?</legend>
          {options.map((o) => (
            <label
              key={o.id}
              className={`flex gap-2 rounded border px-3 py-2 ${choice === o.id ? 'border-brand bg-brand/5' : 'border-black/15'} ${
                o.id === 'push' && blocked ? 'opacity-60' : ''
              }`}
            >
              <input
                type="radio"
                name="night"
                className="accent-brand mt-0.5"
                disabled={o.id === 'push' && !!blocked}
                checked={choice === o.id}
                onChange={() => setChoice(o.id)}
              />
              <span>
                <span className="block font-semibold">{o.label}</span>
                <span className="block text-xs text-black/60">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="block">
          <span className="mb-1 block font-semibold">Reason (shown on the website)</span>
          <input
            className={inputClass}
            maxLength={200}
            value={note}
            placeholder="e.g. Venue unavailable"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {choice === 'push' && plan && (
          <div>
            <p className="mb-1 font-semibold">The new dates</p>
            <div className="max-h-56 overflow-y-auto rounded border border-black/10">
              <table className="w-full text-xs">
                <tbody className="divide-y divide-black/10">
                  <tr className="bg-accent/10">
                    <td className="px-2 py-1">{formatLong(plan.skipDate)}</td>
                    <td className="px-2 py-1" colSpan={2}>
                      Week off: {nightNote('postponed', note)}
                    </td>
                  </tr>
                  {plan.moves.map((m) => (
                    <tr key={m.weekId}>
                      <td className="px-2 py-1">
                        Match day {byId.get(m.weekId)?.matchDay}
                        {byId.get(m.weekId)?.kind !== 'regular' ? ' (finals)' : ''}
                      </td>
                      <td className="px-2 py-1 text-black/60 line-through">{formatLong(m.from)}</td>
                      <td className="px-2 py-1 font-semibold">{formatLong(m.to)}</td>
                    </tr>
                  ))}
                  {plan.newSkipWeeks.map((s) => (
                    <tr key={s.date}>
                      <td className="px-2 py-1">{formatLong(s.date)}</td>
                      <td className="px-2 py-1" colSpan={2}>
                        Week off: {s.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1 text-xs text-black/60">
              The season now ends on {formatLong(plan.moves.at(-1)?.to ?? week.date)}. Check the venue is free on the new last night. You
              can undo this from the week off.
            </p>
          </div>
        )}
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Keep the night
        </Button>
        <Button
          variant={choice === 'cancel' ? 'danger' : 'primary'}
          busy={busy}
          onClick={() => onConfirm({ action: choice === 'cancel' ? 'cancel' : 'postpone', pushBack: choice === 'push', note: note.trim() })}
        >
          {choice === 'push' ? 'Postpone and push back' : choice === 'cancel' ? 'Cancel the night' : 'Postpone the night'}
        </Button>
      </div>
    </Dialog>
  )
}

const STATUS_COPY = {
  cancelled: {
    title: 'Mark this game cancelled?',
    body: 'It won’t be played: it needs no result to publish the match day, and any result typed in is cleared.',
  },
  postponed: {
    title: 'Postpone this game?',
    body: 'It keeps any result typed in for when it’s played; until then it needs no result to publish the match day.',
  },
  tbd: {
    title: 'Mark this game TBD?',
    body: 'For a game whose date or time isn’t settled yet. It needs no result to publish the match day.',
  },
} as const

/** A game's status that needs a reason: cancelled, postponed or TBD. */
export function GameStatusDialog({
  status,
  current,
  onConfirm,
  onCancel,
}: {
  status: keyof typeof STATUS_COPY
  current: string
  onConfirm: (note: string) => void
  onCancel: () => void
}) {
  const [note, setNote] = useState(current)
  const copy = STATUS_COPY[status]
  return (
    <Dialog title={copy.title} onCancel={onCancel}>
      <div className="space-y-3 text-sm">
        <p>{copy.body}</p>
        <p>The website shows it straight away. You can set it back to played later.</p>
        <label className="block">
          <span className="mb-1 block font-semibold">Reason (optional, shown on the website)</span>
          <input
            className={inputClass}
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Team short of players"
          />
        </label>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" autoFocus onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={status === 'cancelled' ? 'danger' : 'primary'} onClick={() => onConfirm(note.trim())}>
          {status === 'cancelled' ? 'Mark cancelled' : status === 'postponed' ? 'Postpone' : 'Mark TBD'}
        </Button>
      </div>
    </Dialog>
  )
}

export type WithdrawChoice = { teamId: string; reason: string; cancelFixtures: boolean; from: string }

export function WithdrawDialog({
  teams,
  busy,
  onConfirm,
  onCancel,
}: {
  teams: Team[]
  busy: boolean
  onConfirm: (c: WithdrawChoice) => void
  onCancel: () => void
}) {
  const [teamId, setTeamId] = useState(teams[0]?.id ?? '')
  const [reason, setReason] = useState('')
  const [cancelFixtures, setCancelFixtures] = useState(true)
  const [from, setFrom] = useState(() => sydneyDate(new Date()))
  return (
    <Dialog title="Withdraw a team" onCancel={onCancel}>
      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="mb-1 block font-semibold">Team</span>
          <select className={inputClass} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block font-semibold">Reason</span>
          <input
            className={inputClass}
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Not enough players"
          />
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="accent-brand mt-0.5"
            checked={cancelFixtures}
            onChange={(e) => setCancelFixtures(e.target.checked)}
          />
          <span>
            Cancel their games from{' '}
            <input
              type="date"
              className="rounded border border-black/20 px-1"
              value={from}
              disabled={!cancelFixtures}
              onChange={(e) => setFrom(e.target.value)}
            />{' '}
            on (games with published results stay)
          </span>
        </label>
        <Notice>
          The ladder and fixtures follow the season’s ladder rules (Settings → Ladder rules): marked or hidden, results kept or not, and
          their cancelled games shown as cancelled or as byes. You can reinstate the team later.
        </Notice>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="danger"
          busy={busy}
          disabled={!teamId || !reason.trim() || (cancelFixtures && !from)}
          onClick={() => onConfirm({ teamId, reason: reason.trim(), cancelFixtures, from })}
        >
          Withdraw team
        </Button>
      </div>
    </Dialog>
  )
}
