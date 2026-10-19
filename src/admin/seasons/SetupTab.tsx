import { Link } from 'wouter'
import {
  DEFAULT_POINTS,
  addDays,
  addMinutes,
  dutyEnabled,
  formatLong,
  holidaysOnGameNights,
  isStale,
  seasonShape,
  settingsErrors,
  weekdayName,
  withSettings,
  type Settings,
  type Team,
} from '../../lib/fixtures'
import type { SeasonView } from '../api'
import { Button, Card } from '../ui'
import type { Draft } from './draft'
import { ImportCsvButton } from './ImportCsv'
import { LadderRulesCard } from './LadderRules'
import { TeamsCard } from './SeasonTeams'
import { inputClass } from './styles'

// Season setup: name, dates, format, game night (sessions x courts), teams, weeks off and ladder points. Ported from
// the demo's SetupTab. Changes stay in the working copy until Save. A published season keeps its draw, so only
// what doesn't need a new one can change (the server enforces the same: draw_locked).

const LOCKED = 'Locked while the season is published.'
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function Label({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-black/60">{hint}</span>}
    </div>
  )
}

export function SetupTab({
  view,
  draft,
  onChange,
  readOnly,
  generating,
  onGenerate,
  onTeamRenamed,
  canEditRosters,
}: {
  view: SeasonView
  draft: Draft
  onChange: (d: Draft) => void
  /** Archived seasons, and editors: look, don't touch. */
  readOnly: boolean
  generating: boolean
  onGenerate: () => void
  onTeamRenamed: (team: Team) => void
  /** Admins and owners: rosters are personal data. */
  canEditRosters: boolean
}) {
  const c = draft.competition
  const s = c.settings
  // A published season keeps its draw: only changes that don't need a new one are allowed.
  const locked = view.season.status !== 'draft'
  const set = (patch: Partial<Settings>) => {
    const settings = { ...s, ...patch }
    // Drafts re-lay the draw's dates around the new start date and weeks off (withSettings); published draws can't move.
    onChange({ ...draft, competition: locked ? { ...c, settings } : withSettings(c, settings) })
  }
  /** The team list and where added teams' rosters come from, in one change of the working copy. */
  const setTeams = (teams: Team[], rosterFrom: Draft['rosterFrom']) => {
    const settings = { ...s, teams }
    onChange({ ...draft, rosterFrom, competition: locked ? { ...c, settings } : withSettings(c, settings) })
  }
  const points = s.points ?? DEFAULT_POINTS
  const duty = dutyEnabled(s)
  const courtNames = view.courts.map((ct) => ct.name)
  const wrongDay = s.startDate && new Date(`${s.startDate}T00:00:00Z`).getUTCDay() !== view.league.weekday

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0 space-y-5">
        <fieldset disabled={readOnly} className="min-w-0 space-y-5">
          <Card title="The season">
            <div className="grid gap-4 sm:grid-cols-2">
              <Label label="Name">
                <input className={inputClass} maxLength={80} value={s.name} onChange={(e) => set({ name: e.target.value })} />
              </Label>
              <Label
                label="First game night"
                hint={
                  locked
                    ? LOCKED
                    : wrongDay
                      ? `${view.league.code} plays on ${WEEKDAYS[view.league.weekday]}s, but this is a ${weekdayName(s.startDate)}.`
                      : s.startDate
                        ? `Games are on ${weekdayName(s.startDate)}s, every week from here.`
                        : 'The weekday of this date becomes the game night.'
                }
              >
                <input
                  type="date"
                  className={inputClass}
                  disabled={locked}
                  value={s.startDate}
                  onChange={(e) => set({ startDate: e.target.value })}
                />
              </Label>
              <Label label="Each pair of teams plays" hint={locked ? LOCKED : 'Use twice when there are only a few teams.'}>
                <div className="flex gap-1">
                  {[1, 2, 3].map((n) => (
                    <button
                      key={n}
                      type="button"
                      disabled={locked}
                      onClick={() => set({ meetings: n })}
                      aria-pressed={s.meetings === n}
                      className={`flex-1 rounded border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed ${
                        s.meetings === n
                          ? 'border-brand bg-brand text-white'
                          : 'hover:border-brand border-black/20 bg-white disabled:opacity-50'
                      }`}
                    >
                      {n === 1 ? 'Once' : n === 2 ? 'Twice' : '3 times'}
                    </button>
                  ))}
                </div>
              </Label>
              <Label label="Finals" hint={locked ? LOCKED : 'Top 4: a semi-finals week, then the grand final and 3rd place week.'}>
                <label className={`flex items-center gap-2 rounded border border-black/20 px-3 py-2 text-sm ${locked ? 'opacity-60' : ''}`}>
                  <input
                    type="checkbox"
                    className="accent-brand h-4 w-4"
                    disabled={locked}
                    checked={s.includeFinals}
                    onChange={(e) => set({ includeFinals: e.target.checked })}
                  />
                  Add semis and finals weeks
                </label>
              </Label>
            </div>
          </Card>

          <Card title="Format">
            <div className="grid gap-4 sm:grid-cols-2">
              <Label
                label="Referees"
                hint={
                  locked
                    ? LOCKED
                    : duty
                      ? 'Each game is refereed by a team playing in the next session.'
                      : 'Volleyball NSW referees, as in the Super League.'
                }
              >
                <select
                  className={inputClass}
                  disabled={locked}
                  value={duty ? 'duty' : 'none'}
                  onChange={(e) => set({ duty: e.target.value === 'duty' })}
                >
                  <option value="duty">Teams referee each other (duty)</option>
                  <option value="none">No team duty (Volleyball NSW referees)</option>
                </select>
              </Label>
              <Label
                label="Sets per match"
                hint={locked ? LOCKED : 'Social leagues play 2 sets (so draws happen). The Super League is best of 5.'}
              >
                <select
                  className={inputClass}
                  disabled={locked}
                  value={draft.setsPerMatch}
                  onChange={(e) => onChange({ ...draft, setsPerMatch: Number(e.target.value) })}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n === 5 ? 'Best of 5' : n === 3 ? '3 sets (or best of 3)' : `${n} set${n > 1 ? 's' : ''}`}
                    </option>
                  ))}
                </select>
              </Label>
              <Label label="Ladder points" hint="For a win, a draw and a loss. The ladder updates when you save.">
                <div className="grid grid-cols-3 gap-2">
                  {(['win', 'draw', 'loss'] as const).map((k) => (
                    <label key={k} className="flex items-center gap-1.5 text-sm">
                      <span className="w-9 text-black/60 capitalize">{k}</span>
                      <input
                        type="number"
                        min={0}
                        max={10}
                        className={inputClass}
                        value={points[k]}
                        onChange={(e) => set({ points: { ...points, [k]: Math.min(10, Math.max(0, Number(e.target.value) || 0)) } })}
                      />
                    </label>
                  ))}
                </div>
              </Label>
            </div>
          </Card>

          <LadderRulesCard
            settings={s}
            setsPerMatch={draft.setsPerMatch}
            imported={view.adjustments.some((a) => a.reason === 'wp-import reconciliation')}
            set={set}
          />

          <Card title="Game night">
            <p className="-mt-2 mb-4 text-sm text-black/60">Session times × courts = the game slots each night.</p>
            <div className="grid gap-6 sm:grid-cols-2">
              <ListEditor
                label="Session start times"
                hint={locked ? 'Times can change. Adding or removing a session is locked while the season is published.' : undefined}
                locked={locked}
                items={s.sessions}
                render={(value, onValue) => (
                  <input type="time" className={inputClass} value={value} onChange={(e) => onValue(e.target.value)} />
                )}
                addLabel="Add session"
                onAdd={() =>
                  set({ sessions: [...s.sessions, s.sessions.length ? addMinutes(s.sessions.at(-1)!, s.sessionMinutes) : '20:00'] })
                }
                onChange={(sessions) => set({ sessions })}
              />
              <ListEditor
                label="Default courts"
                hint={
                  locked
                    ? 'Courts can change. Adding or removing one is locked while the season is published.'
                    : 'Used for every match day. You can change the court for one game on the Fixtures tab.'
                }
                locked={locked}
                items={s.courts}
                render={(value, onValue) => (
                  <select className={inputClass} value={value} onChange={(e) => onValue(e.target.value)} aria-label="Court">
                    {!value && <option value="">Choose a court</option>}
                    {[...new Set([...courtNames, value].filter(Boolean))].map((n) => (
                      <option key={n} value={n}>
                        {n}
                        {view.courts.find((ct) => ct.name === n && !ct.atLeagueVenue)
                          ? ` (${view.courts.find((ct) => ct.name === n)!.venueName || 'other venue'})`
                          : ''}
                      </option>
                    ))}
                  </select>
                )}
                addLabel="Add court"
                onAdd={() => set({ courts: [...s.courts, courtNames.find((n) => !s.courts.includes(n)) ?? courtNames[0] ?? ''] })}
                onChange={(courts) => set({ courts })}
              />
              <Label label="Session length (minutes)" hint="When byes and the night finish, and for court clashes with other leagues.">
                <input
                  type="number"
                  min={15}
                  max={240}
                  step={5}
                  className={inputClass}
                  value={s.sessionMinutes}
                  onChange={(e) => set({ sessionMinutes: Math.min(240, Math.max(15, Number(e.target.value) || 60)) })}
                />
              </Label>
            </div>
          </Card>
        </fieldset>
        {/* Outside the read-only fieldset: rosters stay editable on published and archived seasons. */}
        <TeamsCard
          seasonId={view.season.id}
          savedToken={view.season.updatedAt}
          settings={s}
          rosterFrom={draft.rosterFrom}
          setTeams={setTeams}
          locked={locked}
          readOnly={readOnly}
          canEditRosters={canEditRosters}
          onRenamed={onTeamRenamed}
        />
        <fieldset disabled={readOnly} className="min-w-0">
          <SkipDatesCard settings={s} set={set} locked={locked} />
        </fieldset>
      </div>

      <aside className="min-w-0 lg:sticky lg:top-4 lg:self-start">
        <Summary view={view} draft={draft} readOnly={readOnly} generating={generating} onGenerate={onGenerate} onChange={onChange} />
      </aside>
    </div>
  )
}

function ListEditor({
  label,
  hint,
  locked,
  items,
  render,
  addLabel,
  onAdd,
  onChange,
}: {
  label: string
  hint?: string
  locked: boolean
  items: string[]
  render: (value: string, onValue: (v: string) => void) => React.ReactNode
  addLabel: string
  onAdd: () => void
  onChange: (items: string[]) => void
}) {
  return (
    <div>
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="w-6 pt-2 text-right text-xs text-black/60">{i + 1}</span>
            {render(item, (v) => onChange(items.map((x, j) => (j === i ? v : x))))}
            {!locked && (
              <button
                type="button"
                aria-label={`Remove ${label.toLowerCase()} ${i + 1}`}
                className="rounded px-2 text-black/60 hover:bg-red-50 hover:text-red-700 disabled:opacity-30"
                disabled={items.length <= 1}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      {!locked && (
        <button type="button" className="text-brand mt-2 ml-7 text-sm font-semibold hover:underline" onClick={onAdd}>
          + {addLabel}
        </button>
      )}
      {hint && <p className="mt-1 ml-7 text-xs text-black/60">{hint}</p>}
    </div>
  )
}

/** Weeks off, with NSW public holidays on game nights suggested one at a time; the organiser adds each one. */
function SkipDatesCard({ settings: s, set, locked }: { settings: Settings; set: (p: Partial<Settings>) => void; locked: boolean }) {
  const shape = seasonShape(s)
  const skipped = new Set(s.skipDates.map((d) => d.date))
  // Look far enough ahead to cover the season plus any weeks already skipped.
  const suggestions = locked
    ? []
    : holidaysOnGameNights(s.startDate, shape.playingWeeks + s.skipDates.length + 4).filter((h) => !skipped.has(h.date))
  const sorted = s.skipDates.toSorted((a, b) => a.date.localeCompare(b.date))
  const update = (date: string, patch: Partial<{ date: string; reason: string }>) =>
    set({ skipDates: s.skipDates.map((x) => (x.date === date ? { ...x, ...patch } : x)) })

  return (
    <Card title="Weeks off">
      <p className="-mt-2 mb-4 text-sm text-black/60">{locked ? LOCKED : 'Later rounds move back a week.'}</p>
      {suggestions.length > 0 && (
        <div className="border-accent bg-accent/10 mb-4 rounded border p-3 text-sm">
          <div className="mb-2 font-semibold">Public holidays on your game nights. Add the ones with no games:</div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((h) => (
              <button
                type="button"
                key={h.date}
                className="hover:border-brand rounded-full border border-black/20 bg-white px-3 py-1"
                onClick={() => set({ skipDates: [...s.skipDates, h] })}
              >
                + {h.reason} · {formatLong(h.date)}
              </button>
            ))}
          </div>
        </div>
      )}
      {sorted.length === 0 ? (
        <p className="text-sm text-black/60">No weeks off. The season runs every week.</p>
      ) : (
        <ul className="space-y-1.5">
          {sorted.map((d) => (
            <li key={d.date} className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                className={`${inputClass} w-44`}
                disabled={locked}
                value={d.date}
                onChange={(e) => update(d.date, { date: e.target.value })}
                aria-label="Date off"
              />
              <input
                className={`${inputClass} min-w-40 flex-1`}
                disabled={locked}
                value={d.reason}
                maxLength={100}
                placeholder="Reason, e.g. Easter"
                onChange={(e) => update(d.date, { reason: e.target.value })}
                aria-label="Reason"
              />
              {s.startDate && weekdayName(d.date) !== weekdayName(s.startDate) && (
                <span className="text-xs text-red-700">Not a {weekdayName(s.startDate)}</span>
              )}
              {!locked && (
                <button
                  type="button"
                  aria-label="Remove week off"
                  className="rounded px-2 py-1 text-black/60 hover:bg-red-50 hover:text-red-700"
                  onClick={() => set({ skipDates: s.skipDates.filter((x) => x.date !== d.date) })}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!locked && (
        <button
          type="button"
          className="text-brand mt-3 text-sm font-semibold hover:underline disabled:opacity-40"
          disabled={!s.startDate}
          onClick={() => {
            let date = addDays(s.startDate, 7)
            while (skipped.has(date)) date = addDays(date, 7)
            set({ skipDates: [...s.skipDates, { date, reason: '' }] })
          }}
        >
          + Add a week off
        </button>
      )}
    </Card>
  )
}

function Summary({
  view,
  draft,
  readOnly,
  generating,
  onGenerate,
  onChange,
}: {
  view: SeasonView
  draft: Draft
  readOnly: boolean
  generating: boolean
  onGenerate: () => void
  onChange: (d: Draft) => void
}) {
  const c = draft.competition
  const s = c.settings
  const shape = seasonShape(s)
  const errors = settingsErrors(s)
  const weeksSpan = shape.playingWeeks + s.skipDates.filter((d) => d.date >= s.startDate).length
  const stale = isStale(c)
  const published = view.season.status !== 'draft'
  const base = `/seasons/${view.season.id}`

  const rows: [string, string][] = [
    ['Games a night', `${shape.gamesPerNight} of ${shape.slotsPerNight} slots`],
    ['Byes a night', shape.byesPerNight ? `${shape.byesPerNight} team${shape.byesPerNight === 1 ? '' : 's'}` : 'None'],
    ['Games per team', String(shape.gamesPerTeam)],
    ['Round robin', `${shape.regularRounds} week${shape.regularRounds === 1 ? '' : 's'}`],
    ['Finals', shape.finalsWeeks ? 'Semis + finals (2 weeks)' : s.includeFinals ? 'Needs 4+ teams' : 'None'],
    ['Duty', dutyEnabled(s) ? 'Teams' : 'None (referees)'],
    ['Sets per match', String(draft.setsPerMatch)],
    ['Seed', String(s.seed)],
  ]

  return (
    <div className="border-brand rounded border-2 bg-white p-5 shadow-sm">
      <h2 className="text-brand text-lg font-bold">Summary</h2>
      {s.startDate && shape.playingWeeks > 0 && (
        <p className="mt-1 text-sm text-black/60">
          {formatLong(s.startDate)} → {formatLong(addDays(s.startDate, (weeksSpan - 1) * 7))}
        </p>
      )}
      <dl className="mt-4 divide-y divide-black/10 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between py-1.5">
            <dt className="text-black/60">{k}</dt>
            <dd className="font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      {errors.length > 0 && (
        <ul className="mt-4 space-y-1 rounded bg-red-50 p-3 text-sm text-red-800">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {stale && (
        <p className="bg-accent/20 mt-4 rounded p-3 text-sm">
          Teams, sessions or format have changed since the draw was made.{' '}
          {published ? 'Unpublish the season to make a new draw.' : 'Regenerate to update it.'}
        </p>
      )}
      {published ? (
        <>
          <p className="bg-brand/5 mt-4 rounded p-3 text-sm">
            <strong>The season is published.</strong> Names, session times, courts and ladder points can still change; saving keeps the draw
            and its results.
          </p>
          <Link href={`${base}/results`} className="text-brand mt-3 block text-center text-sm font-semibold hover:underline">
            Enter results →
          </Link>
        </>
      ) : (
        !readOnly && (
          <>
            <Button
              className="mt-4 w-full py-3 text-base"
              disabled={errors.length > 0 || generating}
              busy={generating}
              onClick={onGenerate}
            >
              {c.weeks ? 'Regenerate draw' : 'Generate draw'}
            </Button>
            <p className="mt-2 text-xs text-black/60">
              The draw is worked out in your browser. The same teams, settings and seed always give the same draw.
            </p>
            <ImportCsvButton view={view} draft={draft} onChange={onChange} className="mt-3 w-full" />
            {c.weeks && !stale && (
              <Link href={`${base}/fixtures`} className="text-brand mt-3 block text-center text-sm font-semibold hover:underline">
                View the current draw →
              </Link>
            )}
          </>
        )
      )}
    </div>
  )
}
