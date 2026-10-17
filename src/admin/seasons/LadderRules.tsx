import { TIE_BREAK_LABEL, TIE_BREAK_RULES, tieBreakOrder, withdrawnPolicy, type Settings, type WithdrawnPolicy } from '../../lib/fixtures'
import { Card } from '../ui'
import { inputClass } from './SetupTab'

// The season's ladder rules (Setup → Ladder rules): the tie-break order after ladder points, and how withdrawn teams
// show. Both are ladder-only settings, so they can change on a published season too; the ladder follows on save.

type Rule = (typeof TIE_BREAK_RULES)[number]

export function LadderRulesCard({ settings: s, set }: { settings: Settings; set: (p: Partial<Settings>) => void }) {
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
      </div>
    </Card>
  )
}
