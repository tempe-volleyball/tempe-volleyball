import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import {
  byesForWeek,
  courtClashes,
  courtName,
  defaultCourt,
  dutyEnabled,
  flipGame,
  formatLong,
  isStale,
  isTeam,
  moveGame,
  refKey,
  refName,
  setCourt,
  setRef,
  settingsErrors,
  teamStats,
  validate,
  type CourtClash,
  type Game,
  type Issue,
  type Ref,
  type Settings,
  type Week,
} from '../../lib/fixtures'
import { api, type ClashDraws, type SeasonView } from '../api'
import { Button, Card, Notice } from '../ui'
import { CourtDialog } from './dialogs'
import type { Draft } from './draft'
import { ImportCsvButton } from './ImportCsv'

// The draw editor, ported from the demo's FixturesTab: drag games between slots (dropping on a game swaps them, even
// across weeks), change courts per slot, change teams and refs, flip home and away. validate() runs live, and the
// other leagues' draws at the same venue are fetched so cross-season court clashes show too. A published draw is
// locked except for courts (the server allows nothing else).

const PLACEHOLDERS = ['1st', '2nd', '3rd', '4th', 'Winner SF1', 'Winner SF2', 'Loser SF1', 'Loser SF2', 'Loser GF']

type Mode = 'edit' | 'courts' | 'view'

type FixturesProps = {
  view: SeasonView
  draft: Draft
  onChange: (d: Draft) => void
  readOnly: boolean
  generating: boolean
  /** Regenerate with a new seed. */
  onGenerate: () => void
}

/** The draw editor, or (a draft with no draw yet) the two ways to make one: generate it, or import it from a CSV. */
export function FixturesTab(props: FixturesProps) {
  if (props.draft.competition.weeks) return <DrawEditor {...props} />
  const { view, draft, onChange, readOnly, generating, onGenerate } = props
  const problems = settingsErrors(draft.competition.settings)
  return (
    <Card title="No draw yet">
      <div className="space-y-3 text-sm">
        <p>
          Make the draw with the generator, which works it out in your browser from the teams and settings on the Setup tab, or import it
          from a CSV file when you need one the generator can’t make.
        </p>
        {problems.length > 0 && (
          <Notice kind="warning">
            <p>
              Before generating, fix these on the{' '}
              <Link href={`/seasons/${view.season.id}/setup`} className="text-brand underline">
                Setup tab
              </Link>
              :
            </p>
            <ul className="mt-1 list-disc pl-5">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        )}
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button disabled={problems.length > 0 || generating} busy={generating} onClick={onGenerate}>
              Generate draw
            </Button>
            <ImportCsvButton view={view} draft={draft} onChange={onChange} />
          </div>
        )}
      </div>
    </Card>
  )
}

function DrawEditor({ view, draft, onChange, readOnly, generating, onGenerate }: FixturesProps) {
  const c = draft.competition
  const s = c.settings
  const weeks = c.weeks!
  const published = view.season.status !== 'draft'
  // Published: courts only. Archived or an editor: nothing.
  const mode: Mode = readOnly ? 'view' : published ? 'courts' : 'edit'
  const [highlight, setHighlight] = useState('')
  const [showIssues, setShowIssues] = useState(false)
  const [dragging, setDragging] = useState<{ week: Week; game: Game } | null>(null)

  const issues = useMemo(() => validate(s, weeks), [s, weeks])
  const clashes = useClashes(view, s, weeks)
  const clashGames = useMemo(
    () => new Set(clashes.flatMap((x) => x.bookings.filter((b) => b.seasonId === view.season.id).map((b) => b.gameId))),
    [clashes, view.season.id],
  )
  const errors = issues.filter((i) => i.level === 'error').length
  const warnings = issues.length - errors + clashes.length

  const edit = (next: Week[]) => onChange({ ...draft, competition: { ...c, weeks: next, edited: published ? c.edited : true } })

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor))

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(null)
    if (!e.over) return
    const [weekId = '', gameId = ''] = String(e.active.id).split('|')
    const [toWeek = '', session, court] = String(e.over.id).split('|')
    edit(moveGame(weeks, { weekId, gameId }, { weekId: toWeek, session: Number(session), court: Number(court) }))
  }

  return (
    <div className="space-y-5">
      {isStale(c) && (
        <div className="border-accent bg-accent/10 flex flex-wrap items-center gap-3 rounded border p-4 text-sm">
          <span>
            <strong>Settings changed.</strong> The teams, sessions or format no longer match this draw.
          </span>
          {published ? (
            <span className="ml-auto text-black/60">Unpublish the season to make a new draw.</span>
          ) : (
            mode === 'edit' && (
              <Button className="ml-auto" busy={generating} onClick={onGenerate}>
                Regenerate
              </Button>
            )
          )}
        </div>
      )}

      <div className="bg-paper/95 top-0 z-20 -mx-4 flex flex-wrap items-center gap-2 border-b border-black/10 px-4 py-3 backdrop-blur sm:sticky">
        <button
          type="button"
          onClick={() => setShowIssues((v) => !v)}
          aria-expanded={showIssues}
          className={`rounded px-3 py-2 text-sm font-semibold ${errors ? 'bg-red-700 text-white' : warnings ? 'bg-accent text-ink' : 'bg-brand text-white'}`}
        >
          {errors + warnings === 0
            ? '✓ No problems'
            : [errors && `${errors} problem${errors > 1 ? 's' : ''}`, warnings && `${warnings} warning${warnings > 1 ? 's' : ''}`]
                .filter(Boolean)
                .join(' · ')}
        </button>
        <div className="ml-auto flex flex-wrap gap-2">
          {published ? (
            <Link href={`/seasons/${view.season.id}/results`} className="bg-brand rounded px-4 py-2 text-sm font-semibold text-white">
              Enter results →
            </Link>
          ) : (
            mode === 'edit' && (
              <>
                <Button
                  variant="secondary"
                  busy={generating}
                  onClick={onGenerate}
                  title="Generate a different, equally fair draw with a new seed"
                >
                  ↻ Shuffle again
                </Button>
                <ImportCsvButton view={view} draft={draft} onChange={onChange} />
                <Link href={`/seasons/${view.season.id}/publish`} className="bg-brand rounded px-4 py-2 text-sm font-semibold text-white">
                  Publish →
                </Link>
              </>
            )
          )}
        </div>
      </div>

      {showIssues && (issues.length > 0 || clashes.length > 0) && <IssueList issues={issues} clashes={clashes} />}

      <FairnessTable settings={s} weeks={weeks} highlight={highlight} onToggle={(id) => setHighlight((h) => (h === id ? '' : id))} />

      <p className="text-sm text-black/60">
        {mode === 'edit'
          ? "Drag a game by its handle to move it. Dropping onto another game swaps them, even across weeks. Click a team or court to change it. Courts stay with the time slot, so a game moved into a slot plays on that slot's court."
          : mode === 'courts'
            ? 'The draw is published, so only courts can change. Pick a court on any game.'
            : 'Read only.'}
        {mode !== 'view' && ' Changes are kept until you press Save.'}
      </p>

      <DndContext
        sensors={sensors}
        onDragStart={(e) => {
          const [weekId, gameId] = String(e.active.id).split('|')
          const week = weeks.find((w) => w.id === weekId)
          const game = week?.games.find((g) => g.id === gameId)
          if (week && game) setDragging({ week, game })
        }}
        onDragCancel={() => setDragging(null)}
        onDragEnd={onDragEnd}
      >
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {weeks.map((w) => (
            <WeekCard
              key={w.id}
              week={w}
              view={view}
              settings={s}
              issues={issues.filter((i) => i.weekId === w.id)}
              clashes={clashes.filter((x) => x.bookings.some((b) => b.weekId === w.id))}
              clashGames={clashGames}
              highlight={highlight}
              mode={mode}
              onEdit={edit}
              weeks={weeks}
            />
          ))}
        </div>
        <DragOverlay>
          {dragging && (
            <div className="rotate-1 shadow-xl">
              <GameCard game={dragging.game} week={dragging.week} view={view} settings={s} highlight={highlight} mode="view" overlay />
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  )
}

/** Other seasons' draws at this venue over this draw's dates (refetched when the dates change), as court clashes. */
function useClashes(view: SeasonView, s: Settings, weeks: Week[]): CourtClash[] {
  const playing = weeks.filter((w) => w.kind !== 'skip')
  const from = playing[0]?.date ?? ''
  const to = playing.at(-1)?.date ?? ''
  const [others, setOthers] = useState<ClashDraws | null>(null)
  useEffect(() => {
    if (!from || !to) return
    let live = true
    void api<ClashDraws>(`/api/admin/seasons/${view.season.id}/clashes?from=${from}&to=${to}`)
      .then((r) => live && setOthers(r))
      .catch(() => live && setOthers(null))
    return () => {
      live = false
    }
  }, [view.season.id, from, to])
  return useMemo(
    () =>
      others && others.draws.length > 0
        ? courtClashes([
            { seasonId: view.season.id, label: s.name, venue: others.venue ?? '', settings: s, weeks },
            ...others.draws,
          ]).filter((x) => x.bookings.some((b) => b.seasonId === view.season.id))
        : [],
    [others, view.season.id, s, weeks],
  )
}

function scrollToWeek(id: string) {
  document.getElementById(`week-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

export function IssueList({ issues, clashes = [] }: { issues: Issue[]; clashes?: CourtClash[] }) {
  return (
    <ul className="space-y-1 rounded border border-black/10 bg-white p-4 text-sm">
      {issues.map((i, n) => (
        <li key={n} className="flex gap-2">
          <span
            className={`mt-0.5 h-4 shrink-0 rounded px-1.5 text-[10px] leading-4 font-bold uppercase ${i.level === 'error' ? 'bg-red-700 text-white' : 'bg-accent text-ink'}`}
          >
            {i.level === 'error' ? 'Fix' : 'Check'}
          </span>
          {i.weekId ? (
            <button type="button" onClick={() => scrollToWeek(i.weekId!)} className="text-left hover:underline">
              {i.message}
            </button>
          ) : (
            <span>{i.message}</span>
          )}
        </li>
      ))}
      {clashes.map((x, n) => (
        <li key={`c${n}`} className="flex gap-2">
          <span className="bg-accent text-ink mt-0.5 h-4 shrink-0 rounded px-1.5 text-[10px] leading-4 font-bold uppercase">Clash</span>
          <button type="button" onClick={() => scrollToWeek(x.bookings[0].weekId)} className="text-left hover:underline">
            {x.message}
          </button>
        </li>
      ))}
    </ul>
  )
}

const range = (xs: number[]) => [Math.min(...xs), Math.max(...xs)] as const
// flag anything outside the tightest possible spread
const off = (v: number, [lo, hi]: readonly [number, number], allowed: number) => hi - lo > allowed && (v === lo || v === hi)
const cell = (bad: boolean) => `px-3 py-1.5 text-center tabular-nums ${bad ? 'bg-red-50 font-semibold text-red-700' : ''}`

function FairnessTable({
  settings: s,
  weeks,
  highlight,
  onToggle,
}: {
  settings: Settings
  weeks: Week[]
  highlight: string
  onToggle: (teamId: string) => void
}) {
  const stats = teamStats(s, weeks)
  const duty = dutyEnabled(s)
  const games = range(stats.map((t) => t.games))
  const duties = range(stats.map((t) => t.duties))
  const byes = range(stats.map((t) => t.byes))
  const perSession = s.sessions.map((_, i) => range(stats.map((t) => t.perSession[i] ?? 0)))

  return (
    <div className="overflow-x-auto rounded border border-black/10 bg-white shadow-sm">
      <table className="w-full text-sm">
        <caption className="caption-bottom border-t border-black/10 px-3 py-1.5 text-left text-xs text-black/60">
          {highlight
            ? 'Click the team again to clear the highlight.'
            : `Click a team to highlight its games${duty ? ', duties' : ''} and byes below.`}
        </caption>
        <thead>
          <tr className="bg-header-row text-left text-white">
            <th className="px-3 py-2">Team</th>
            <th className="px-3 py-2 text-center">Games</th>
            {s.sessions.map((t, i) => (
              <th key={i} className="px-3 py-2 text-center whitespace-nowrap">
                At {t}
              </th>
            ))}
            {duty && <th className="px-3 py-2 text-center">Duties</th>}
            <th className="px-3 py-2 text-center">Byes</th>
            <th className="px-3 py-2 text-center" title="Most weeks in a row in the same time slot">
              Same slot streak
            </th>
          </tr>
        </thead>
        <tbody>
          {stats.map((t) => (
            <tr
              key={t.teamId}
              onClick={() => onToggle(t.teamId)}
              className={`cursor-pointer border-b border-black/10 last:border-0 ${t.teamId === highlight ? 'bg-accent/20 shadow-[inset_4px_0_0_var(--color-accent)]' : 'hover:bg-black/5'}`}
            >
              <td className="px-3 py-1.5 font-semibold">
                {/* the row handles the click; the button makes it reachable by keyboard */}
                <button
                  type="button"
                  aria-pressed={t.teamId === highlight}
                  onClick={(e) => (e.stopPropagation(), onToggle(t.teamId))}
                  className="text-left focus:underline focus:outline-none"
                >
                  {refName(s, { team: t.teamId })}
                </button>
              </td>
              <td className={cell(off(t.games, games, 0))}>{t.games}</td>
              {t.perSession.map((n, i) => (
                <td key={i} className={cell(off(n, perSession[i] ?? [0, 0], 2))}>
                  {n}
                </td>
              ))}
              {duty && <td className={cell(off(t.duties, duties, 1))}>{t.duties}</td>}
              <td className={cell(off(t.byes, byes, 1))}>{t.byes}</td>
              <td className={cell(t.longestSameSlot > 3)}>{t.longestSameSlot}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const WEEK_LABEL: Record<Week['kind'], string> = { regular: '', semi: 'Semi finals', final: 'Finals', skip: '' }

function WeekCard({
  week: w,
  view,
  settings: s,
  issues,
  clashes,
  clashGames,
  highlight,
  mode,
  onEdit,
  weeks,
}: {
  week: Week
  view: SeasonView
  settings: Settings
  issues: Issue[]
  clashes: CourtClash[]
  clashGames: Set<string>
  highlight: string
  mode: Mode
  onEdit: (weeks: Week[]) => void
  weeks: Week[]
}) {
  if (w.kind === 'skip')
    return (
      <div
        id={`week-${w.id}`}
        className="flex items-center gap-3 rounded border border-dashed border-black/20 px-5 py-3 text-sm text-black/60 xl:col-span-2"
      >
        <span className="font-semibold">{formatLong(w.date)}</span>
        <span>No games · {w.note || 'Week off'}</span>
      </div>
    )

  const byes = byesForWeek(s, w, weeks)
  // one column per default court, plus any extra positions games already use
  const positions = Math.max(1, s.courts.length, ...w.games.map((g) => g.court + 1))
  const hasError = issues.some((i) => i.level === 'error')
  const accent = w.kind === 'regular' ? 'border-black/10' : 'border-accent'

  return (
    <section id={`week-${w.id}`} className={`min-w-0 rounded border-2 bg-white shadow-sm ${hasError ? 'border-red-700' : accent}`}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-black/10 px-4 py-2.5">
        <h3 className="font-bold">
          Match day {w.matchDay}
          {WEEK_LABEL[w.kind] && <span className="bg-accent ml-2 rounded px-1.5 py-0.5 text-xs">{WEEK_LABEL[w.kind]}</span>}
        </h3>
        <span className="text-sm text-black/60">{formatLong(w.date)}</span>
        {byes.length > 0 && (
          <span className="ml-auto text-sm">
            Bye:{' '}
            {byes.map((t, i) => (
              <span key={t}>
                {i > 0 && ', '}
                <span className={`font-semibold ${t === highlight ? 'bg-accent rounded px-1' : ''}`}>{refName(s, { team: t })}</span>
              </span>
            ))}
          </span>
        )}
      </header>
      <div className="overflow-x-auto p-3">
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `3rem repeat(${positions}, minmax(10rem, 1fr))`, minWidth: `${3 + positions * 10.5}rem` }}
        >
          {s.sessions.map((time, si) => (
            <Row key={si}>
              <div className="pt-3 text-right text-sm font-semibold text-black/60">{time}</div>
              {Array.from({ length: positions }, (_, ci) => {
                const game = w.games.find((g) => g.session === si && g.court === ci)
                return (
                  <Slot key={ci} id={`${w.id}|${si}|${ci}`} disabled={mode !== 'edit'} empty={!game}>
                    {game && (
                      <DraggableGame
                        game={game}
                        week={w}
                        view={view}
                        settings={s}
                        highlight={highlight}
                        mode={mode}
                        flagged={issues.some((i) => i.gameIds?.includes(game.id)) || clashGames.has(game.id)}
                        onCourt={(name) => onEdit(setCourt(weeks, s, w.id, si, ci, name))}
                        onRef={(field, ref) => onEdit(setRef(weeks, w.id, game.id, field, ref))}
                        onFlip={() => onEdit(flipGame(weeks, w.id, game.id))}
                      />
                    )}
                  </Slot>
                )
              })}
            </Row>
          ))}
        </div>
      </div>
      {(issues.length > 0 || clashes.length > 0) && (
        <ul className="space-y-0.5 border-t border-black/10 px-4 py-2 text-xs">
          {issues.map((i, n) => (
            <li key={n} className={i.level === 'error' ? 'text-red-700' : 'text-black/70'}>
              {i.level === 'error' ? '✕' : '!'} {i.message.replace(/^Match day \d+: /, '')}
            </li>
          ))}
          {clashes.map((x, n) => (
            <li key={`c${n}`} className="text-black/70">
              ! Court clash: {x.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const Row = ({ children }: { children: React.ReactNode }) => <>{children}</>

function Slot({ id, disabled, empty, children }: { id: string; disabled: boolean; empty: boolean; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled })
  return (
    <div
      ref={setNodeRef}
      className={`min-h-[4.25rem] rounded transition ${isOver ? 'bg-accent/20 ring-accent ring-2' : empty ? 'border border-dashed border-black/20' : ''}`}
    >
      {children}
    </div>
  )
}

type GameProps = {
  game: Game
  week: Week
  view: SeasonView
  settings: Settings
  highlight: string
  mode: Mode
  flagged?: boolean
  overlay?: boolean
  onCourt?: (name: string) => void
  onRef?: (field: 'home' | 'away' | 'duty', ref: Ref | null) => void
  onFlip?: () => void
}

function DraggableGame(props: GameProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${props.week.id}|${props.game.id}`,
    disabled: props.mode !== 'edit',
  })
  return (
    <div ref={setNodeRef} className={isDragging ? 'opacity-30' : ''}>
      <GameCard {...props} handle={props.mode === 'edit' ? { ...attributes, ...listeners } : undefined} />
    </div>
  )
}

function GameCard({
  game: g,
  week: w,
  view,
  settings: s,
  highlight,
  mode,
  flagged,
  overlay,
  handle,
  onCourt,
  onRef,
  onFlip,
}: GameProps & { handle?: object }) {
  const finals = w.kind !== 'regular'
  const involved = [g.home, g.away, g.duty].some((r) => isTeam(r) && r.team === highlight)
  const [askingCourt, setAskingCourt] = useState(false)
  const court = courtName(s, w, g.session, g.court)
  const fallback = defaultCourt(s, g.court)
  const teamsEditable = mode === 'edit'
  const vs = (x: Game) => `${refName(s, x.home)} v ${refName(s, x.away)}`
  const takenBy = (name: string) => {
    const other = w.games.find(
      (x) => x.id !== g.id && x.session === g.session && courtName(s, w, x.session, x.court).toLowerCase() === name.toLowerCase(),
    )
    return other ? vs(other) : null
  }
  return (
    <div
      className={`flex h-full rounded border bg-white ${flagged ? 'border-red-700 bg-red-50/60' : involved ? 'border-accent bg-accent/10' : 'border-black/15'} ${
        overlay ? 'w-64' : ''
      }`}
    >
      {handle ? (
        <button
          type="button"
          {...handle}
          aria-label={`Drag to move ${vs(g)}`}
          className="flex w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-l bg-black/5 text-black/40 hover:text-black active:cursor-grabbing"
        >
          ⋮⋮
        </button>
      ) : (
        <span className="w-1.5 shrink-0 rounded-l bg-black/5" />
      )}
      <div className="min-w-0 flex-1 px-2 py-1.5 text-sm">
        <div className="flex items-center gap-2">
          <CourtPick
            value={court}
            fallback={fallback}
            options={[...new Set([...s.courts, ...view.courts.map((c) => c.name)].filter(Boolean))]}
            disabled={mode === 'view' || !onCourt}
            onPick={onCourt}
            onOther={() => setAskingCourt(true)}
          />
          {g.title && <span className="text-brand shrink-0 text-[11px] font-bold tracking-wider uppercase">{g.title}</span>}
        </div>
        <div className="flex">
          <TeamPick
            value={g.home}
            settings={s}
            finals={finals}
            highlight={highlight}
            disabled={!teamsEditable}
            onPick={(r) => onRef?.('home', r)}
            strong
          />
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onFlip}
            disabled={!teamsEditable}
            title="Swap home and away"
            aria-label="Swap home and away"
            className="w-3 shrink-0 text-xs text-black/50 hover:text-black disabled:cursor-default disabled:hover:text-black/50"
          >
            v
          </button>
          <TeamPick
            value={g.away}
            settings={s}
            finals={finals}
            highlight={highlight}
            disabled={!teamsEditable}
            onPick={(r) => onRef?.('away', r)}
            strong
          />
        </div>
        {dutyEnabled(s) && (
          <div className="mt-0.5 flex items-center gap-1 border-t border-black/10 pt-0.5 text-xs text-black/60">
            <span className="shrink-0">Duty</span>
            <TeamPick
              value={g.duty}
              settings={s}
              finals={finals}
              highlight={highlight}
              disabled={!teamsEditable}
              onPick={(r) => onRef?.('duty', r)}
              allowNone
            />
          </div>
        )}
      </div>
      {askingCourt && onCourt && (
        <CourtDialog
          context={`Match day ${w.matchDay} · ${formatLong(w.date)} · ${s.sessions[g.session] ?? ''}`}
          matchup={g.title ? `${g.title}: ${vs(g)}` : vs(g)}
          current={court}
          fallback={fallback}
          seasonCourts={view.courts}
          takenBy={takenBy}
          onSave={(name) => {
            setAskingCourt(false)
            onCourt(name)
          }}
          onCancel={() => setAskingCourt(false)}
        />
      )}
    </div>
  )
}

const OTHER_COURT = '\u0000other'

/**
 * The court for this game's slot, styled like the team pickers. Picking the season default clears the change;
 * "Other court…" opens a dialog listing every venue's courts.
 */
function CourtPick({
  value,
  fallback,
  options,
  disabled,
  onPick,
  onOther,
}: {
  value: string
  fallback: string
  options: string[]
  disabled: boolean
  onPick?: (name: string) => void
  onOther: () => void
}) {
  const changed = value !== fallback
  const list = [...new Set([...options, value].filter(Boolean))]
  return (
    <select
      aria-label="Court"
      value={value}
      disabled={disabled}
      onChange={(e) => {
        if (e.target.value === OTHER_COURT) onOther()
        else onPick?.(e.target.value)
      }}
      title={
        changed ? `Changed from the season default${fallback ? ` (${fallback}). Pick ${fallback} to undo.` : '.'}` : 'Court for this game'
      }
      className={`min-w-0 flex-1 cursor-pointer appearance-none truncate rounded bg-transparent px-0.5 text-xs font-semibold tracking-wider uppercase hover:bg-black/5 focus:ring-2 focus:ring-accent focus:outline-none disabled:cursor-default disabled:hover:bg-transparent ${
        !value ? 'text-red-700' : changed ? 'text-brand' : 'text-black/60'
      }`}
    >
      {!value && (
        <option value="" disabled>
          Court?
        </option>
      )}
      {list.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
      <option value={OTHER_COURT}>Other court…</option>
    </select>
  )
}

/** Looks like plain text; it's a native select so it works with keyboard and on phones. */
function TeamPick({
  value,
  settings: s,
  finals,
  highlight,
  disabled,
  onPick,
  strong,
  allowNone,
}: {
  value: Ref | null
  settings: Settings
  finals: boolean
  highlight: string
  disabled: boolean
  onPick: (r: Ref | null) => void
  strong?: boolean
  allowNone?: boolean
}) {
  const hl = isTeam(value) && value.team === highlight
  const label = value && !isTeam(value) ? value.label : null
  return (
    <select
      value={refKey(value)}
      disabled={disabled}
      aria-label={allowNone ? 'Duty team' : 'Team'}
      onChange={(e) => {
        const v = e.target.value
        onPick(v === '' ? null : v.startsWith('t:') ? { team: v.slice(2) } : { label: v.slice(2) })
      }}
      className={`min-w-0 flex-1 cursor-pointer appearance-none truncate rounded px-0.5 focus:ring-2 focus:ring-accent focus:outline-none disabled:cursor-default disabled:opacity-100 ${
        strong ? 'text-ink font-semibold' : ''
      } ${hl ? 'bg-accent text-ink' : 'bg-transparent hover:bg-black/5 disabled:hover:bg-transparent'}`}
    >
      {allowNone && <option value="">— none —</option>}
      {(finals || (label && !PLACEHOLDERS.includes(label))) && (
        <optgroup label="Placeholders">
          {[...new Set([...(finals ? PLACEHOLDERS : []), ...(label ? [label] : [])])].map((p) => (
            <option key={p} value={`l:${p}`}>
              ({p.toUpperCase()})
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Teams">
        {s.teams.map((t) => (
          <option key={t.id} value={`t:${t.id}`}>
            {t.name}
          </option>
        ))}
      </optgroup>
    </select>
  )
}
