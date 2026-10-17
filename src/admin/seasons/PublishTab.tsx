import { useState } from 'react'
import { Link } from 'wouter'
import {
  dutyEnabled,
  formatAU,
  formatLong,
  fullCsv,
  isStale,
  publicRows,
  settingsErrors,
  validate,
  type Settings,
  type Week,
} from '../../lib/fixtures'
import { leagueRoute, seasonRoute } from '../../lib/wp-import/routes'
import type { SeasonView } from '../api'
import { Button, Card } from '../ui'
import { download } from './browser'
import { ConfirmDialog } from './dialogs'
import type { Draft } from './draft'
import { Ladder } from './Ladder'

// Publish (drafts): the checks, the button, and a preview of the fixtures as the website will show them.
// Website (published): the same preview with results, the ladder, a link to the live page and the CSV export.

/** The fixtures in the website's shape (publicRows): Date, Match, Time, Results, Venue, Match Day, Duty. */
export function PublicTable({ settings: s, weeks, withResults }: { settings: Settings; weeks: Week[]; withResults: boolean }) {
  const rows = publicRows(s, weeks)
  const duty = dutyEnabled(s)
  const headers = ['Date', 'Match', 'Time', ...(withResults ? ['Results'] : []), 'Court', 'Match Day', ...(duty ? ['Duty'] : [])]
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-header-row text-left text-white">
            {headers.map((h) => (
              <th key={h} className="px-3 py-2 font-semibold whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const firstOfDay = i === 0 || rows[i - 1]!.date !== r.date
            return (
              <tr
                key={i}
                className={`${firstOfDay ? 'border-t-2 border-black/20' : ''} ${r.kind === 'bye' ? 'text-black/60' : ''} ${r.kind === 'skip' ? 'bg-black/5 text-black/60 italic' : ''}`}
              >
                <td className="px-3 py-1.5 whitespace-nowrap tabular-nums">{firstOfDay ? formatAU(r.date) : ''}</td>
                <td className={`px-3 py-1.5 ${r.kind === 'game' ? 'font-semibold' : ''}`}>{r.match}</td>
                <td className="px-3 py-1.5 tabular-nums">{r.kind === 'bye' ? 'Bye' : r.time}</td>
                {withResults && (
                  <td className="px-3 py-1.5 font-semibold whitespace-nowrap tabular-nums">{r.result || (r.kind === 'game' ? '' : '-')}</td>
                )}
                <td className="px-3 py-1.5 whitespace-nowrap">{r.venue || (r.kind === 'skip' ? '' : '–')}</td>
                <td className="px-3 py-1.5 text-center">{r.matchDay || ''}</td>
                {duty && <td className="px-3 py-1.5">{r.duty || (r.kind === 'game' ? '–' : '')}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const csvName = (view: SeasonView) => `${view.season.slug}-fixtures.csv`

export function PublishTab({
  view,
  draft,
  dirty,
  busy,
  readOnly,
  onPublish,
}: {
  view: SeasonView
  draft: Draft
  dirty: boolean
  busy: boolean
  readOnly: boolean
  /** Saves first if there are unsaved changes, then publishes. */
  onPublish: () => void
}) {
  const c = draft.competition
  const s = c.settings
  const weeks = c.weeks!
  const [confirming, setConfirming] = useState(false)
  const errors = [
    ...settingsErrors(s),
    ...validate(s, weeks)
      .filter((i) => i.level === 'error')
      .map((i) => i.message),
  ]
  const stale = isStale(c)
  const playing = weeks.filter((w) => w.kind !== 'skip')
  const first = playing[0]?.date
  const last = playing.at(-1)?.date
  const ok = errors.length === 0 && !stale

  const checks: { ok: boolean; text: string }[] = [
    {
      ok: errors.length === 0,
      text: errors.length === 0 ? 'No problems in the draw' : `${errors.length} problem${errors.length > 1 ? 's' : ''} to fix`,
    },
    { ok: !stale, text: stale ? 'The draw is out of date: regenerate it' : 'The draw matches the settings' },
    { ok: true, text: `${s.teams.length} teams, ${playing.length} match days` },
    { ok: true, text: first && last ? `${formatLong(first)} → ${formatLong(last)}` : 'Dates set' },
  ]

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
      <section className="min-w-0 overflow-hidden rounded border border-black/10 bg-white shadow-sm">
        <div className="border-b border-black/10 px-5 py-3">
          <div className="text-xs font-semibold tracking-wider text-black/60 uppercase">Preview · as it will appear on the website</div>
          <h2 className="text-brand text-lg font-bold">{s.name} fixtures</h2>
        </div>
        <PublicTable settings={s} weeks={weeks} withResults={false} />
      </section>

      <aside className="min-w-0 space-y-4">
        <section className="border-brand rounded border-2 bg-white p-5 shadow-sm">
          <h2 className="text-brand text-lg font-bold">Publish the season</h2>
          <p className="mt-1 text-sm text-black/60">Makes the fixtures live and lets you enter results as the season is played.</p>
          <ul className="mt-3 space-y-1 text-sm">
            {checks.map((ch) => (
              <li key={ch.text} className={`flex gap-2 ${ch.ok ? '' : 'font-semibold text-red-700'}`}>
                <span className={ch.ok ? 'text-brand' : ''}>{ch.ok ? '✓' : '✕'}</span>
                {ch.text}
              </li>
            ))}
          </ul>
          {errors.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-red-800">
              {errors.slice(0, 5).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          {!ok && (
            <Link
              href={`/seasons/${view.season.id}/${stale ? 'setup' : 'fixtures'}`}
              className="text-brand mt-2 inline-block text-sm font-semibold hover:underline"
            >
              {stale ? 'Go to the setup →' : 'Fix them on the Fixtures tab →'}
            </Link>
          )}
          {!readOnly && (
            <Button className="mt-4 w-full py-3 text-base" disabled={!ok || busy} busy={busy} onClick={() => setConfirming(true)}>
              {dirty ? 'Save and publish…' : 'Publish season…'}
            </Button>
          )}
        </section>
        <Card title="Export">
          <Button variant="secondary" className="w-full" onClick={() => download(csvName(view), fullCsv(s, weeks))}>
            Full fixtures (CSV)
          </Button>
          <p className="mt-1.5 text-sm text-black/60">
            Everything, including {dutyEnabled(s) ? 'duties, ' : ''}byes and finals: for Excel or Google Sheets.
          </p>
        </Card>
      </aside>

      {confirming && (
        <ConfirmDialog
          title={`Publish ${s.name || 'this season'}?`}
          confirmLabel={dirty ? 'Save and publish' : 'Publish season'}
          busy={busy}
          onConfirm={() => {
            setConfirming(false)
            onPublish()
          }}
          onCancel={() => setConfirming(false)}
        >
          <p>The fixtures go live on the website, and the league page shows this season.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>You'll enter results each week. The ladder updates as you publish them, and the semis and finals fill themselves in.</li>
            <li>Courts, session times, team names and ladder points stay editable.</li>
            <li>
              The draw itself is locked: teams, dates and the format can't change unless you unpublish (only possible before any results).
            </li>
          </ul>
        </ConfirmDialog>
      )}
    </div>
  )
}

export function WebsiteTab({ view, draft }: { view: SeasonView; draft: Draft }) {
  const s = draft.competition.settings
  const weeks = draft.competition.weeks!
  const seasonUrl = seasonRoute(view.league.slug, view.season.slug)
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0 space-y-5">
        <Ladder settings={s} weeks={weeks} adjustments={view.adjustments} />
        <section className="min-w-0 overflow-hidden rounded border border-black/10 bg-white shadow-sm">
          <div className="border-b border-black/10 px-5 py-3">
            <div className="text-xs font-semibold tracking-wider text-black/60 uppercase">
              As it appears on the website (published results only)
            </div>
            <h2 className="text-brand text-lg font-bold">{s.name} fixtures</h2>
          </div>
          <PublicTable settings={s} weeks={weeks} withResults />
        </section>
      </div>
      <aside className="min-w-0 space-y-4">
        <Card title="On the website">
          <ul className="space-y-2 text-sm">
            <li>
              <a href={leagueRoute(view.league.slug)} target="_blank" rel="noopener" className="text-brand font-semibold underline">
                {view.league.name} page
              </a>
              <span className="block text-xs text-black/60">Shows the league's newest published season.</span>
            </li>
            <li>
              <a href={seasonUrl} target="_blank" rel="noopener" className="text-brand font-semibold underline">
                {view.season.name} page
              </a>
              <span className="block text-xs text-black/60">{seasonUrl}</span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-black/60">Pages can take a few minutes to update if the cache couldn't be cleared.</p>
        </Card>
        <Card title="Export">
          <Button variant="secondary" className="w-full" onClick={() => download(csvName(view), fullCsv(s, weeks))}>
            Full fixtures (CSV)
          </Button>
          <p className="mt-1.5 text-sm text-black/60">
            Everything, including {dutyEnabled(s) ? 'duties, ' : ''}byes, finals, and published sets and points: for Excel or Google Sheets.
          </p>
        </Card>
      </aside>
    </div>
  )
}
