import { useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import { formatLong, importFixturesCsv, refName, settingsErrors, shapeKey, validate, type Settings } from '../../lib/fixtures'
import type { SeasonView } from '../api'
import { Button, Dialog, Notice } from '../ui'
import type { Draft } from './draft'

// CSV fixture import (draft seasons): the fallback when the generator can't make the draw the organiser wants. Paste
// or pick a file, see every problem with its line and a preview of the draw, then use it as the working copy. Saving
// is the ordinary Save (PUT /draw, audited as fixtures.import). Parsing is the lib's importFixturesCsv().

const EXAMPLE = `Date,Time,Court,Home,Away,Duty,Stage
2027-01-07,20:00,Court 1,Aces,Blockers,Chaos,
2027-01-07,21:00,Court 1,Chaos,Diggers,Aces,
2027-01-14,,,,,,No games: Australia Day
2027-03-04,20:00,Court 1,(2ND),(3RD),(4TH),Semi Final 1`

export function ImportCsvButton({
  view,
  draft,
  onChange,
  className = '',
}: {
  view: SeasonView
  draft: Draft
  onChange: (d: Draft) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [, navigate] = useLocation()
  return (
    <>
      <Button variant="secondary" className={className} onClick={() => setOpen(true)}>
        Import fixtures from CSV
      </Button>
      {open && (
        <ImportCsvDialog
          view={view}
          draft={draft}
          onUse={(d) => {
            setOpen(false)
            onChange(d)
            navigate(`/seasons/${view.season.id}/fixtures`)
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  )
}

function ImportCsvDialog({
  view,
  draft,
  onUse,
  onCancel,
}: {
  view: SeasonView
  draft: Draft
  onUse: (d: Draft) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)
  const c = draft.competition
  const result = useMemo(
    () => (text.trim() ? importFixturesCsv(text, { teams: c.settings.teams, courtNames: view.courts.map((ct) => ct.name) }) : null),
    [text, c.settings.teams, view.courts],
  )
  const settings: Settings | null = useMemo(() => (result ? { ...c.settings, ...result.settings } : null), [result, c.settings])
  const drawIssues = useMemo(() => (result && settings && result.weeks.length ? validate(settings, result.weeks) : []), [result, settings])
  const errors = [
    ...(result?.issues.filter((i) => i.level === 'error').map((i) => (i.line ? `Line ${i.line}: ${i.message}` : i.message)) ?? []),
    ...drawIssues.filter((i) => i.level === 'error').map((i) => i.message),
    ...(settings && result?.weeks.length ? settingsErrors(settings) : []),
  ]
  const warnings = [
    ...(result?.issues.filter((i) => i.level === 'warning').map((i) => i.message) ?? []),
    ...drawIssues.filter((i) => i.level === 'warning').map((i) => i.message),
  ]

  const readFile = async (f: File | undefined) => {
    setFileError(null)
    if (!f) return
    if (f.size > 512 * 1024) return setFileError('That file is too big for a season’s fixtures (over 512 KB).')
    setText(await f.text())
  }

  const use = () => {
    if (!result || !settings) return
    onUse({
      ...draft,
      source: 'csv',
      competition: { ...c, settings, weeks: result.weeks, edited: true, generatedFrom: shapeKey(settings), updatedAt: Date.now() },
    })
  }

  return (
    <Dialog title="Import fixtures from CSV" onCancel={onCancel} wide>
      <div className="space-y-4 text-sm">
        <p>
          One row per game, with headings: <strong>Date, Time, Court, Home, Away</strong>, and optionally <strong>Duty, Stage, Note</strong>
          . A row with a date and no teams is a week off. Team and court names must match this season’s (add teams on the Setup tab first).
          Finals placeholders go in brackets, like <code>(2ND)</code> or <code>(Winner SF1)</code>. The season’s own CSV download imports as
          is.
        </p>
        {c.weeks && <Notice kind="warning">This replaces the current draw (only once you press Save).</Notice>}
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => void readFile(e.target.files?.[0])} aria-label="CSV file" />
          <Button variant="link" onClick={() => setText(EXAMPLE)}>
            Show an example
          </Button>
        </div>
        {fileError && <Notice kind="error">{fileError}</Notice>}
        <textarea
          className="focus:border-brand h-40 w-full rounded border border-black/20 px-3 py-2 font-mono text-xs outline-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="…or paste the CSV here"
          aria-label="CSV text"
          spellCheck={false}
        />
        {result && (
          <>
            {errors.length > 0 ? (
              <Notice kind="error">
                <p className="font-semibold">
                  {errors.length} problem{errors.length > 1 ? 's' : ''} to fix before this can be used:
                </p>
                <ul className="mt-1 list-disc pl-5">
                  {errors.slice(0, 30).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                  {errors.length > 30 && <li>…and {errors.length - 30} more.</li>}
                </ul>
              </Notice>
            ) : (
              <Notice kind="success">
                {result.games} games over {result.weeks.filter((w) => w.kind !== 'skip').length} nights
                {result.weeks.some((w) => w.kind === 'skip')
                  ? `, with ${result.weeks.filter((w) => w.kind === 'skip').length} weeks off`
                  : ''}
                . Sessions {result.settings.sessions.join(', ')}; courts {result.settings.courts.join(', ')}.
              </Notice>
            )}
            {warnings.length > 0 && (
              <Notice kind="warning">
                <ul className="list-disc pl-5">
                  {warnings.slice(0, 10).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {warnings.length > 10 && <li>…and {warnings.length - 10} more.</li>}
                </ul>
              </Notice>
            )}
            {settings && result.weeks.length > 0 && (
              <div className="max-h-72 overflow-y-auto rounded border border-black/10">
                <table className="w-full text-xs">
                  <thead className="bg-header-row sticky top-0 text-left text-white">
                    <tr>
                      <th className="px-2 py-1">Date</th>
                      <th className="px-2 py-1">Time</th>
                      <th className="px-2 py-1">Court</th>
                      <th className="px-2 py-1">Game</th>
                      <th className="px-2 py-1">Duty</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-black/10">
                    {result.weeks.flatMap((w) =>
                      w.kind === 'skip'
                        ? [
                            <tr key={w.id} className="bg-black/5 italic">
                              <td className="px-2 py-1">{formatLong(w.date)}</td>
                              <td className="px-2 py-1" colSpan={4}>
                                {w.note}
                              </td>
                            </tr>,
                          ]
                        : w.games.map((g, i) => (
                            <tr key={g.id}>
                              <td className="px-2 py-1 whitespace-nowrap">{i === 0 ? `${formatLong(w.date)} · MD${w.matchDay}` : ''}</td>
                              <td className="px-2 py-1">{settings.sessions[g.session]}</td>
                              <td className="px-2 py-1">{settings.courts[g.court]}</td>
                              <td className="px-2 py-1">
                                {g.title ? <span className="text-brand font-semibold">{g.title}: </span> : null}
                                {refName(settings, g.home)} v {refName(settings, g.away)}
                              </td>
                              <td className="px-2 py-1">{refName(settings, g.duty)}</td>
                            </tr>
                          )),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!result || errors.length > 0 || result.weeks.length === 0} onClick={use}>
          Use this draw
        </Button>
      </div>
    </Dialog>
  )
}
