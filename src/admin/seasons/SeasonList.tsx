import { useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { formatLong } from '../../lib/fixtures'
import { sydneyDateTime } from '../../lib/time'
import { api, type LeagueListItem, type Me, type SeasonView } from '../api'
import { Button, Card, Dialog, Field, Notice, Select, StatusBadge, errorMessage } from '../ui'
import { nextQuarter } from './draft'

// The leagues and their seasons (the demo's Home). Admins create next quarter's season here, copying the teams and
// settings from the league's latest one. Editors only see published and archived seasons (they enter results).

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function SeasonList({ me }: { me: Me }) {
  const isAdmin = me.user.role !== 'editor'
  const [leagues, setLeagues] = useState<LeagueListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState<LeagueListItem | null>(null)
  useEffect(() => {
    void api<{ leagues: LeagueListItem[] }>('/api/admin/leagues')
      .then((r) => setLeagues(r.leagues))
      .catch((e) => setError(errorMessage(e)))
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Seasons</h1>
        <p className="mt-1 text-sm text-black/60">
          {isAdmin
            ? 'Each league runs a new season every quarter. Make the next one here, set it up, generate the draw and publish it.'
            : 'Pick a season to enter its results.'}
        </p>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {leagues === null && !error && <p className="text-sm text-black/60">Loading…</p>}
      <div className="grid gap-5 md:grid-cols-2">
        {leagues
          ?.filter((l) => l.active || l.seasons.length > 0)
          .map((l) => {
            const seasons = isAdmin ? l.seasons : l.seasons.filter((s) => s.status !== 'draft')
            return (
              <Card
                key={l.id}
                title={`${l.name} (${l.code})`}
                actions={
                  isAdmin ? (
                    <Button variant="secondary" className="px-3 py-1 text-xs" onClick={() => setCreating(l)}>
                      New season
                    </Button>
                  ) : undefined
                }
              >
                <p className="-mt-2 mb-3 text-sm text-black/60">
                  {WEEKDAYS[l.weekday]}s{l.venue ? ` · ${l.venue.name}` : ''}
                  {l.format === 'super' ? ' · best of 5, Volleyball NSW referees' : ''}
                </p>
                {seasons.length === 0 ? (
                  <p className="text-sm text-black/60">No seasons yet.</p>
                ) : (
                  <ul className="divide-y divide-black/10">
                    {seasons.slice(0, 6).map((s) => (
                      <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                        <Link href={`/seasons/${s.id}`} className="text-brand font-semibold underline">
                          {s.name}
                        </Link>
                        <StatusBadge status={s.status} />
                        <span className="ml-auto text-xs text-black/60">from {formatLong(s.startDate)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {seasons.length > 6 && <OlderSeasons seasons={seasons.slice(6)} />}
              </Card>
            )
          })}
      </div>
      {creating && <CreateSeasonDialog league={creating} onCancel={() => setCreating(null)} />}
    </div>
  )
}

function OlderSeasons({ seasons }: { seasons: LeagueListItem['seasons'] }) {
  const [open, setOpen] = useState(false)
  if (!open)
    return (
      <Button variant="link" className="mt-2 text-xs" onClick={() => setOpen(true)}>
        {seasons.length} older season{seasons.length > 1 ? 's' : ''}
      </Button>
    )
  return (
    <ul className="divide-y divide-black/10">
      {seasons.map((s) => (
        <li key={s.id} className="flex items-center gap-3 py-2 text-sm">
          <Link href={`/seasons/${s.id}`} className="text-brand underline">
            {s.name}
          </Link>
          <StatusBadge status={s.status} />
        </li>
      ))}
    </ul>
  )
}

function CreateSeasonDialog({ league, onCancel }: { league: LeagueListItem; onCancel: () => void }) {
  const [, navigate] = useLocation()
  const [next] = useState(() => nextQuarter(league.seasons, sydneyDateTime(new Date()).slice(0, 10)))
  const [year, setYear] = useState(String(next.year))
  const [quarter, setQuarter] = useState(String(next.quarter))
  const [startDate, setStartDate] = useState('')
  const latest = league.seasons[0]
  const [copy, setCopy] = useState(latest ? 'latest' : 'blank')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const v = await api<SeasonView>('/api/admin/seasons', {
        body: {
          leagueId: league.id,
          year: Number(year),
          quarter: Number(quarter),
          ...(startDate ? { startDate } : {}),
          copyFrom: copy === 'latest' ? 'latest' : null,
        },
      })
      // Unmount the dialog in the same handler that navigates (see ui.tsx Dialog).
      onCancel()
      navigate(`/seasons/${v.season.id}/setup`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Dialog title={`New ${league.code} season`} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Year" type="number" min={2020} max={2100} value={year} onChange={(e) => setYear(e.target.value)} required />
          <Select label="Quarter" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
            {[1, 2, 3, 4].map((q) => (
              <option key={q} value={q}>
                Q{q}
              </option>
            ))}
          </Select>
        </div>
        <p className="-mt-2 text-sm text-black/60">
          It'll be called “{league.code} Q{quarter} {year}”.
        </p>
        <Field
          label="First game night (optional)"
          type="date"
          value={startDate}
          onChange={(e) => setStartDate(e.target.value)}
          hint={`Leave blank for the first ${WEEKDAYS[league.weekday]} of the quarter. You can change it in the setup.`}
        />
        <Select label="Start from" value={copy} onChange={(e) => setCopy(e.target.value)}>
          {latest && <option value="latest">A copy of {latest.name}: its teams and settings</option>}
          <option value="blank">Blank: no teams, the league's default format</option>
        </Select>
        {copy === 'latest' && (
          <p className="-mt-2 text-xs text-black/60">
            The copy gets a new seed and no weeks off. You can add and remove teams before making the draw.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Create draft
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
