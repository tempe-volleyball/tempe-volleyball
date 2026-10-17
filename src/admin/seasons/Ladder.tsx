import { ladderTitle, ladderUpdatedLabel, ladderWeekLabel, type Settings, type Week } from '../../lib/fixtures'
import { ladderRows } from '../../server/competition/adapter'

// The ladder from published results plus ladder adjustments: exactly what the public site shows (ladderRows is
// pure and shared with it). Pos / Team / Pts / P / W / D / L / S+ / S− / P+ / P− / Ratio.

const COLUMNS: { label: string; title: string }[] = [
  { label: 'Pos', title: 'Position' },
  { label: 'Team', title: 'Team' },
  { label: 'Pts', title: 'Ladder points (including adjustments)' },
  { label: 'P', title: 'Played' },
  { label: 'W', title: 'Won' },
  { label: 'D', title: 'Drawn' },
  { label: 'L', title: 'Lost' },
  { label: 'S+', title: 'Sets won' },
  { label: 'S−', title: 'Sets lost' },
  { label: 'P+', title: 'Points won' },
  { label: 'P−', title: 'Points lost' },
  { label: 'Ratio', title: 'P+ ÷ (P+ + P−)' },
]

export function Ladder({
  settings: s,
  weeks,
  adjustments,
  highlight,
  onToggle,
}: {
  settings: Settings
  weeks: Week[]
  adjustments: { teamId: string; points: number }[]
  highlight?: string
  onToggle?: (teamId: string) => void
}) {
  const rows = ladderRows({ settings: s, weeks }, adjustments)
  const adjusted = new Map<string, number>()
  for (const a of adjustments) adjusted.set(a.teamId, (adjusted.get(a.teamId) ?? 0) + a.points)
  const finalsLine = s.includeFinals && s.teams.length >= 4 ? 4 : 0
  const heading = [ladderWeekLabel(weeks), ladderUpdatedLabel(weeks)].filter(Boolean).join(' · ')
  const num = 'px-1.5 py-1.5 text-center tabular-nums'

  return (
    <section className="overflow-hidden rounded border border-black/10 bg-white shadow-sm">
      <div className="flex flex-wrap items-baseline gap-2 border-b border-black/10 px-4 py-2.5">
        <h2 className="text-brand text-lg font-bold">{ladderTitle(weeks)}</h2>
        <span className="ml-auto text-xs text-black/60">{heading || 'No results published yet'}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-header-row text-white">
              {COLUMNS.map((col) => (
                <th
                  key={col.label}
                  title={col.title}
                  className={`py-1.5 font-semibold whitespace-nowrap ${col.label === 'Team' ? 'px-2 text-left' : 'px-1.5 text-center'}`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.teamId}
                onClick={onToggle && (() => onToggle(t.teamId))}
                className={`border-b last:border-0 ${t.pos === finalsLine ? 'border-b-accent border-b-2' : 'border-black/10'} ${
                  t.teamId === highlight ? 'bg-accent/20' : onToggle ? 'cursor-pointer hover:bg-black/5' : ''
                }`}
              >
                <td className={`${num} text-black/60`}>{t.pos}</td>
                <td className="max-w-44 truncate px-2 py-1.5 font-semibold">{t.name}</td>
                <td
                  className={`${num} font-bold`}
                  title={
                    adjusted.get(t.teamId)
                      ? `Includes ${adjusted.get(t.teamId)! > 0 ? '+' : ''}${adjusted.get(t.teamId)} adjustment`
                      : undefined
                  }
                >
                  {t.points}
                  {adjusted.get(t.teamId) ? <span className="text-brand">*</span> : null}
                </td>
                <td className={num}>{t.played}</td>
                <td className={num}>{t.won}</td>
                <td className={num}>{t.drawn}</td>
                <td className={num}>{t.lost}</td>
                <td className={num}>{t.setsFor}</td>
                <td className={num}>{t.setsAgainst}</td>
                <td className={num}>{t.pointsFor}</td>
                <td className={num}>{t.pointsAgainst}</td>
                <td className={num}>{t.ratio}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adjusted.size > 0 && <p className="border-t border-black/10 px-4 py-1.5 text-xs text-black/60">* includes a ladder adjustment</p>}
    </section>
  )
}
