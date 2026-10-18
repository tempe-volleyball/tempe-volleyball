import {
  forfeitRule,
  forfeitRuleProblem,
  forfeitScoreText,
  LEVEL_SETS_LABEL,
  levelSetsRule,
  TIE_BREAK_LABEL,
  TIE_BREAK_RULES,
  tieBreakOrder,
  withdrawnPolicy,
  type ForfeitRule,
  type LevelSetsRule,
  type Settings,
  type WithdrawnPolicy,
} from '../../lib/fixtures'
import { Card, Checkbox } from '../ui'
import { inputClass } from './styles'

// The season's ladder rules (Setup → Ladder rules): the tie-break order after ladder points, how withdrawn teams
// show, the 1–1 rule and what a forfeit counts as. All are ladder-only settings, so they can change on a published
// season too; the ladder follows on save.

type Rule = (typeof TIE_BREAK_RULES)[number]

export function LadderRulesCard({
  settings: s,
  setsPerMatch,
  imported = false,
  set,
}: {
  settings: Settings
  setsPerMatch: number
  /** The season has the importer's reconciliation adjustments (its ladder already matches SportsPress's). */
  imported?: boolean
  set: (p: Partial<Settings>) => void
}) {
  const forfeit = forfeitRule(s, setsPerMatch)
  const forfeitProblem = forfeitRuleProblem(forfeit, setsPerMatch)
  const setForfeit = (p: Partial<ForfeitRule>) => set({ forfeit: { ...forfeit, ...p } })
  const num = (v: string, max: number) => Math.min(max, Math.max(0, Math.floor(Number(v) || 0)))
  const order = tieBreakOrder(s)
  const rules = order.filter((r) => r !== 'name')
  const unused = TIE_BREAK_RULES.filter((r) => r !== 'name' && !rules.includes(r))
  const policy = withdrawnPolicy(s)
  const save = (next: Rule[]) => set({ tieBreaks: [...next, 'name'] })
  const move = (i: number, by: number) => {
    const next = [...rules]
    const [r] = next.splice(i, 1)
    next.splice(i + by, 0, r!)
    save(next)
  }
  const setPolicy = (p: Partial<WithdrawnPolicy>) => set({ withdrawn: { ...policy, ...p } })
  const btn = 'rounded border border-black/20 bg-white px-2 py-0.5 text-xs font-semibold hover:border-brand disabled:opacity-30'

  return (
    <Card title="Ladder rules">
      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <span className="mb-1 block text-sm font-semibold">When teams are level on points</span>
          <ol className="space-y-1.5 text-sm">
            {rules.map((r, i) => (
              <li key={r} className="flex items-center gap-2 rounded border border-black/10 px-2 py-1.5">
                <span className="w-5 text-right text-black/60 tabular-nums">{i + 1}.</span>
                <span className="min-w-0 flex-1">{TIE_BREAK_LABEL[r]}</span>
                <button
                  type="button"
                  className={btn}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  aria-label={`Move ${TIE_BREAK_LABEL[r]} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={i === rules.length - 1}
                  onClick={() => move(i, 1)}
                  aria-label={`Move ${TIE_BREAK_LABEL[r]} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={btn}
                  onClick={() => save(rules.filter((x) => x !== r))}
                  aria-label={`Remove ${TIE_BREAK_LABEL[r]}`}
                >
                  ×
                </button>
              </li>
            ))}
            <li className="flex items-center gap-2 px-2 py-1 text-black/60">
              <span className="w-5 text-right tabular-nums">{rules.length + 1}.</span>
              <span>{TIE_BREAK_LABEL.name} (always last)</span>
            </li>
          </ol>
          {unused.length > 0 && (
            <select
              className={`${inputClass} mt-2`}
              value=""
              aria-label="Add a tie-break"
              onChange={(e) => e.target.value && save([...rules, e.target.value as Rule])}
            >
              <option value="">Add a tie-break…</option>
              {unused.map((r) => (
                <option key={r} value={r}>
                  {TIE_BREAK_LABEL[r]}
                </option>
              ))}
            </select>
          )}
          <p className="mt-2 text-xs text-black/60">
            The default is set difference, points difference, then wins.{' '}
            {order.join() !== tieBreakOrder({}).join() && (
              <button type="button" className="text-brand underline" onClick={() => set({ tieBreaks: tieBreakOrder({}) })}>
                Back to the default
              </button>
            )}
          </p>
        </div>
        <div className="space-y-3">
          <span className="block text-sm font-semibold">Withdrawn teams</span>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-black/60">On the ladder</span>
            <select className={inputClass} value={policy.ladder} onChange={(e) => setPolicy({ ladder: e.target.value as 'mark' | 'hide' })}>
              <option value="mark">Show them last, marked “withdrawn”</option>
              <option value="hide">Leave them off the ladder</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-black/60">Games they already played</span>
            <select
              className={inputClass}
              value={policy.results}
              onChange={(e) => setPolicy({ results: e.target.value as 'keep' | 'void' })}
            >
              <option value="keep">Still count (for both teams)</option>
              <option value="void">Don’t count for anyone</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-black/60">Their cancelled games on the fixtures</span>
            <select
              className={inputClass}
              value={policy.fixtures}
              onChange={(e) => setPolicy({ fixtures: e.target.value as 'bye' | 'cancelled' })}
            >
              <option value="cancelled">Show as cancelled</option>
              <option value="bye">Show as a bye for the other team</option>
            </select>
          </label>
          <p className="text-xs text-black/60">Withdraw a team from the Results tab, under “Withdrawn teams”.</p>
        </div>
        <div className="space-y-2">
          <label className="block text-sm">
            <span className="mb-1 block font-semibold">A match level on sets (1–1)</span>
            <select
              className={inputClass}
              value={levelSetsRule(s)}
              onChange={(e) => set({ levelSets: e.target.value as LevelSetsRule })}
              aria-label="A match level on sets"
            >
              {(['draw', 'points'] as const).map((r) => (
                <option key={r} value={r}>
                  {LEVEL_SETS_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-black/60">
            {levelSetsRule(s) === 'points'
              ? 'The team with more rally points wins (win and loss ladder points); level on points too is a draw. The sets still show as 1–1.'
              : 'Both teams get the draw points. SportsPress decided these on points instead: switch if that’s the rule.'}{' '}
            In the finals a 1–1 needs a winner either way.
          </p>
          {imported && levelSetsRule(s) === 'points' && (
            <p className="rounded bg-red-50 p-2 text-xs text-red-800">
              This season was imported, and its “wp-import reconciliation” ladder adjustments already turn its 1–1 draws into SportsPress’s
              wins and losses. Deciding them on points as well counts them twice: keep imported seasons on “a draw”.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <span className="block text-sm font-semibold">Forfeits</span>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <label>
              <span className="mb-1 block text-xs text-black/60">Sets to the winner</span>
              <input
                type="number"
                min={1}
                max={setsPerMatch}
                className={inputClass}
                value={forfeit.winnerSets}
                onChange={(e) => setForfeit({ winnerSets: num(e.target.value, 5) })}
              />
            </label>
            <label>
              <span className="mb-1 block text-xs text-black/60">Sets to the forfeiting team</span>
              <input
                type="number"
                min={0}
                max={setsPerMatch - 1}
                className={inputClass}
                value={forfeit.loserSets}
                onChange={(e) => setForfeit({ loserSets: num(e.target.value, 4) })}
              />
            </label>
            <label>
              <span className="mb-1 block text-xs text-black/60">Winner’s points a set</span>
              <input
                type="number"
                min={0}
                max={99}
                className={inputClass}
                value={forfeit.winnerSetPoints}
                onChange={(e) => setForfeit({ winnerSetPoints: num(e.target.value, 99) })}
              />
            </label>
            <label>
              <span className="mb-1 block text-xs text-black/60">Forfeiting team’s points a set</span>
              <input
                type="number"
                min={0}
                max={99}
                className={inputClass}
                value={forfeit.loserSetPoints}
                onChange={(e) => setForfeit({ loserSetPoints: num(e.target.value, 99) })}
              />
            </label>
          </div>
          <Checkbox
            label="The forfeiting team still gets the points for a loss"
            hint={`${s.points?.loss ?? 1} ladder point${(s.points?.loss ?? 1) === 1 ? '' : 's'}, as for any loss. Untick for 0.`}
            checked={forfeit.lossPoints}
            onChange={(lossPoints) => setForfeit({ lossPoints })}
          />
          {forfeitProblem ? (
            <p className="text-xs text-red-700">{forfeitProblem}</p>
          ) : (
            <p className="text-xs text-black/60">
              A game marked forfeit on the Results tab is entered as {forfeitScoreText(forfeit)} to the other team, which you can still
              change before publishing. Points a set both 0 records the sets only.
              {JSON.stringify(forfeit) !== JSON.stringify(forfeitRule({}, setsPerMatch)) && (
                <>
                  {' '}
                  <button type="button" className="text-brand underline" onClick={() => set({ forfeit: forfeitRule({}, setsPerMatch) })}>
                    Back to the default
                  </button>
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}
