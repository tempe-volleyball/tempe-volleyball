import { useCallback, useEffect, useState } from 'react'
import { Link } from 'wouter'
import { formatLong } from '../../lib/fixtures'
import { slugify } from '../../lib/content/paths'
import { formatTimeRange } from '../../lib/programme-text'
import { sydneyDate } from '../../lib/time'
import {
  api,
  type EventRow,
  type InstanceProduct,
  type LeagueListItem,
  type Me,
  type OccurrenceStatus,
  type ProgrammeView,
  type PurgeResult,
  type SessionRow,
  type TermRow,
  type VenueRow,
} from '../api'
import { CreateSeasonDialog } from '../seasons/SeasonList'
import { Button, Card, Checkbox, Dialog, Field, Notice, Select, StatusBadge, TextArea, errorMessage, purgeNote } from '../ui'
import { WEEKDAY_NAMES, intOrNull } from './kinds'

// The instances tab of a programme: a league's seasons, a training programme's sessions, a development programme's
// terms (each with its sessions) or an event's dates. Sessions, terms and events each carry their own cap (their
// product); a blank cap means the programme's default.

export function InstancesTab({ me, view, onChanged }: { me: Me; view: ProgrammeView; onChanged: () => void }) {
  const p = view.programme
  if (p.kind === 'league') return <SeasonsPanel me={me} view={view} />
  if (p.kind === 'training') return <SessionsPanel me={me} view={view} termId={null} onChanged={onChanged} />
  if (p.kind === 'development') return <TermsPanel me={me} view={view} onChanged={onChanged} />
  return <EventsPanel me={me} view={view} onChanged={onChanged} />
}

const useVenues = () => {
  const [venues, setVenues] = useState<VenueRow[]>([])
  useEffect(() => {
    void api<{ venues: VenueRow[] }>('/api/admin/venues')
      .then((r) => setVenues(r.venues))
      .catch(() => setVenues([]))
  }, [])
  return venues
}

const capText = (product: InstanceProduct | null, programmeCap: number | null, teams = false) => {
  if (!product) return '—'
  const cap = (teams ? product.capacityTeams : product.capacity) ?? programmeCap
  const n = teams ? product.teams : product.enrolled
  return cap === null ? `${n}` : `${n} / ${cap}`
}

const cap = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v))

const OCCURRENCE: OccurrenceStatus[] = ['scheduled', 'postponed', 'cancelled']

// ── Leagues: seasons ──────────────────────────────────────────────────────────

function SeasonsPanel({ me, view }: { me: Me; view: ProgrammeView }) {
  const isAdmin = me.user.role !== 'editor'
  const [league, setLeague] = useState<LeagueListItem | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    void api<{ leagues: LeagueListItem[] }>('/api/admin/leagues')
      .then((r) => setLeague(r.leagues.find((l) => l.id === view.programme.id) ?? null))
      .catch((e) => setError(errorMessage(e)))
  }, [view.programme.id])
  const seasons = league ? (isAdmin ? league.seasons : league.seasons.filter((s) => s.status !== 'draft')) : []
  return (
    <Card
      title="Seasons"
      actions={
        isAdmin && league && view.programme.status !== 'retired' ? (
          <Button variant="secondary" onClick={() => setCreating(true)}>
            New season
          </Button>
        ) : undefined
      }
    >
      {error && <Notice kind="error">{error}</Notice>}
      {!league && !error && <p className="text-sm text-black/60">Loading…</p>}
      {league && seasons.length === 0 && <p className="text-sm text-black/60">No seasons yet.</p>}
      {seasons.length > 0 && (
        <ul className="divide-y divide-black/10">
          {seasons.map((s) => (
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
      {creating && league && <CreateSeasonDialog league={league} onCancel={() => setCreating(false)} />}
    </Card>
  )
}

// ── Sessions (training, and a development term's) ─────────────────────────────

function SessionsPanel({
  me,
  view,
  termId,
  onChanged,
  term,
}: {
  me: Me
  view: ProgrammeView
  termId: string | null
  onChanged: () => void
  term?: TermRow
}) {
  const isAdmin = me.user.role !== 'editor'
  const p = view.programme
  const venues = useVenues()
  const [rows, setRows] = useState<SessionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<SessionRow | null>(null)
  const [showPast, setShowPast] = useState(false)
  const load = useCallback(
    () =>
      api<{ sessions: SessionRow[] }>(`/api/admin/programmes/${p.id}/sessions?termId=${termId ?? ''}`)
        .then((r) => setRows(r.sessions))
        .catch((e) => setError(errorMessage(e))),
    [p.id, termId],
  )
  useEffect(() => {
    void load()
  }, [load])
  const [today] = useState(() => sydneyDate(new Date()))
  const visible = rows?.filter((s) => showPast || s.date >= today) ?? []
  const past = (rows?.length ?? 0) - (rows?.filter((s) => s.date >= today).length ?? 0)
  const venueName = (id: string | null) => venues.find((v) => v.id === id)?.name
  const courtName = (id: string | null) => venues.flatMap((v) => v.courts).find((c) => c.id === id)?.name

  const done = (text: string) => {
    setMessage(text)
    void load()
    onChanged()
  }

  return (
    <Card
      title={term ? `${term.name}: sessions` : 'Sessions'}
      actions={
        isAdmin ? (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add sessions
          </Button>
        ) : undefined
      }
    >
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      {rows === null && !error && <p className="text-sm text-black/60">Loading…</p>}
      {rows?.length === 0 && <p className="text-sm text-black/60">No sessions yet.</p>}
      {past > 0 && (
        <Button variant="link" className="mb-2 text-xs" onClick={() => setShowPast((v) => !v)}>
          {showPast ? 'Hide' : 'Show'} {past} past session{past > 1 ? 's' : ''}
        </Button>
      )}
      {visible.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-black/60 uppercase">
                <th className="pr-3 pb-2 font-semibold">Date</th>
                <th className="pr-3 pb-2 font-semibold">Time</th>
                <th className="pr-3 pb-2 font-semibold">Where</th>
                <th className="pr-3 pb-2 font-semibold">Title</th>
                {!termId && <th className="pr-3 pb-2 font-semibold">Enrolled</th>}
                <th className="pb-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr key={s.id} className="border-t border-black/10">
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {isAdmin ? (
                      <Button variant="link" onClick={() => setEditing(s)}>
                        {formatLong(s.date)}
                      </Button>
                    ) : (
                      formatLong(s.date)
                    )}
                    {s.originalDate && <div className="text-xs text-black/60">was {formatLong(s.originalDate)}</div>}
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">{formatTimeRange(s.startTime, s.endTime) || '—'}</td>
                  <td className="py-2 pr-3">
                    {[venueName(s.venueId) ?? (s.venueId ? '' : view.venue?.name), courtName(s.courtId)].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="py-2 pr-3">{s.title ?? ''}</td>
                  {!termId && <td className="py-2 pr-3">{capText(s.product, p.capPlayers)}</td>}
                  <td className="py-2">
                    <StatusBadge status={s.status} />
                    {s.note && <div className="text-xs text-black/60">{s.note}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <AddSessionsDialog
          view={view}
          venues={venues}
          term={term ?? null}
          onCancel={() => setAdding(false)}
          onDone={(text) => {
            setAdding(false)
            done(text)
          }}
        />
      )}
      {editing && (
        <SessionDialog
          session={editing}
          view={view}
          venues={venues}
          inTerm={!!termId}
          onCancel={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null)
            done(text)
          }}
        />
      )}
    </Card>
  )
}

function PlaceFields({
  venues,
  venueId,
  courtId,
  onVenue,
  onCourt,
  venueHint,
}: {
  venues: VenueRow[]
  venueId: string
  courtId: string
  onVenue: (v: string) => void
  onCourt: (v: string) => void
  venueHint?: string
}) {
  const courts = venues.find((v) => v.id === venueId)?.courts ?? []
  return (
    <div className="grid grid-cols-2 gap-3">
      <Select
        label="Venue"
        value={venueId}
        onChange={(e) => {
          onVenue(e.target.value)
          onCourt('')
        }}
        hint={venueHint}
      >
        <option value="">Usual venue</option>
        {venues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </Select>
      <Select label="Court" value={courtId} onChange={(e) => onCourt(e.target.value)} disabled={!venueId}>
        <option value="">Any</option>
        {courts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
    </div>
  )
}

function AddSessionsDialog({
  view,
  venues,
  term,
  onCancel,
  onDone,
}: {
  view: ProgrammeView
  venues: VenueRow[]
  term: TermRow | null
  onCancel: () => void
  onDone: (message: string) => void
}) {
  const p = view.programme
  const [mode, setMode] = useState<'weekly' | 'one'>('weekly')
  const [date, setDate] = useState(term?.startDate ?? '')
  const [from, setFrom] = useState(term?.startDate ?? '')
  const [to, setTo] = useState(term?.endDate ?? '')
  const [weekday, setWeekday] = useState(String(term?.weekday ?? p.weekday))
  const [every, setEvery] = useState('1')
  const [skip, setSkip] = useState('')
  const [startTime, setStartTime] = useState(term?.startTime ?? p.startTime ?? '')
  const [endTime, setEndTime] = useState(term?.endTime ?? p.endTime ?? '')
  const [venueId, setVenueId] = useState(term?.venueId ?? '')
  const [courtId, setCourtId] = useState(term?.courtId ?? '')
  const [title, setTitle] = useState('')
  const [capacity, setCapacity] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const skipDates = skip
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const r = await api<{ added: SessionRow[]; skipped: string[]; cache: PurgeResult }>(`/api/admin/programmes/${p.id}/sessions`, {
        body: {
          ...(mode === 'one' ? { date } : { from, to, weekday: Number(weekday), everyWeeks: Number(every), skip: skipDates }),
          ...(term ? { termId: term.id } : {}),
          startTime: startTime || null,
          endTime: endTime || null,
          venueId: venueId || null,
          courtId: courtId || null,
          title: title || null,
          ...(term ? {} : { capacity: intOrNull(capacity) }),
        },
      })
      onDone(
        `Added ${r.added.length} session${r.added.length === 1 ? '' : 's'}${r.skipped.length ? ` (${r.skipped.length} already there, skipped)` : ''}.${purgeNote(r.cache)}`,
      )
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Dialog title={term ? `Add sessions to ${term.name}` : 'Add sessions'} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'weekly'} onChange={() => setMode('weekly')} /> Every week between two dates
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={mode === 'one'} onChange={() => setMode('one')} /> One date
          </label>
        </div>
        {mode === 'one' ? (
          <Field label="Date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From" type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
              <Field label="To" type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Select label="On" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
                {WEEKDAY_NAMES.map((d, i) => (
                  <option key={d} value={i}>
                    {d}s
                  </option>
                ))}
              </Select>
              <Select label="Every" value={every} onChange={(e) => setEvery(e.target.value)}>
                <option value="1">week</option>
                <option value="2">2 weeks</option>
                <option value="3">3 weeks</option>
                <option value="4">4 weeks</option>
              </Select>
            </div>
            <Field
              label="Leave out (optional)"
              value={skip}
              placeholder="2026-12-24, 2026-12-31"
              onChange={(e) => setSkip(e.target.value)}
              hint="Dates to skip, such as public holidays. Dates that already have a session are skipped anyway."
            />
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          <Field label="Finish" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>
        <PlaceFields
          venues={venues}
          venueId={venueId}
          courtId={courtId}
          onVenue={setVenueId}
          onCourt={setCourtId}
          venueHint={view.venue ? `Usual: ${view.venue.name}` : undefined}
        />
        <Field
          label="Title (optional)"
          maxLength={120}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Coached: serving"
        />
        {!term && (
          <Field
            label="Cap per session (optional)"
            type="number"
            min={0}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            hint={p.capPlayers === null ? 'Blank = no limit.' : `Blank = the programme's ${p.capPlayers}.`}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Add
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function SessionDialog({
  session,
  view,
  venues,
  inTerm,
  onCancel,
  onDone,
}: {
  session: SessionRow
  view: ProgrammeView
  venues: VenueRow[]
  inTerm: boolean
  onCancel: () => void
  onDone: (message: string) => void
}) {
  const [date, setDate] = useState(session.date)
  const [startTime, setStartTime] = useState(session.startTime ?? '')
  const [endTime, setEndTime] = useState(session.endTime ?? '')
  const [venueId, setVenueId] = useState(session.venueId ?? '')
  const [courtId, setCourtId] = useState(session.courtId ?? '')
  const [title, setTitle] = useState(session.title ?? '')
  const [status, setStatus] = useState<OccurrenceStatus>(session.status)
  const [note, setNote] = useState(session.note ?? '')
  const [capacity, setCapacity] = useState(session.product?.capacity === null || !session.product ? '' : String(session.product.capacity))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      const r = await api<{ cache: PurgeResult }>(`/api/admin/sessions/${session.id}`, {
        method: 'PATCH',
        body: {
          baseUpdatedAt: session.updatedAt,
          date,
          startTime: startTime || null,
          endTime: endTime || null,
          venueId: venueId || null,
          courtId: courtId || null,
          title: title || null,
          status,
          note: note || null,
          ...(inTerm ? {} : { capacity: intOrNull(capacity) }),
        },
      })
      onDone(`Saved the session.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }
  const remove = async () => {
    if (!window.confirm(`Delete the session on ${formatLong(session.date)}?`)) return
    setBusy('delete')
    try {
      const r = await api<{ cache: PurgeResult }>(`/api/admin/sessions/${session.id}`, { method: 'DELETE' })
      onDone(`Deleted the session.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  return (
    <Dialog title={`Session on ${formatLong(session.date)}`} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Date"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
            hint={date !== session.date ? `Moving it keeps ${session.originalDate ?? session.date} as the original date.` : undefined}
          />
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as OccurrenceStatus)}>
            {OCCURRENCE.map((s) => (
              <option key={s} value={s}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          <Field label="Finish" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>
        <PlaceFields venues={venues} venueId={venueId} courtId={courtId} onVenue={setVenueId} onCourt={setCourtId} />
        <Field label="Title" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
        <TextArea
          label="Note"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          hint="Shown publicly, e.g. why it's postponed."
        />
        {!inTerm && (
          <Field
            label="Cap"
            type="number"
            min={0}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            hint={`${session.product?.enrolled ?? 0} enrolled. Blank = ${view.programme.capPlayers ?? 'no limit'}.`}
          />
        )}
        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="danger" busy={busy === 'delete'} disabled={!!busy} onClick={() => void remove()}>
            Delete
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" busy={busy === 'save'} disabled={!!busy}>
              Save
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}

// ── Development: terms ────────────────────────────────────────────────────────

function TermsPanel({ me, view, onChanged }: { me: Me; view: ProgrammeView; onChanged: () => void }) {
  const isAdmin = me.user.role !== 'editor'
  const p = view.programme
  const venues = useVenues()
  const [rows, setRows] = useState<TermRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [editing, setEditing] = useState<TermRow | 'new' | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const load = useCallback(
    () =>
      api<{ terms: TermRow[] }>(`/api/admin/programmes/${p.id}/terms`)
        .then((r) => setRows(r.terms))
        .catch((e) => setError(errorMessage(e))),
    [p.id],
  )
  useEffect(() => {
    void load()
  }, [load])
  const openTerm = rows?.find((t) => t.id === open)

  return (
    <div className="space-y-6">
      <Card
        title="Terms"
        actions={
          isAdmin ? (
            <Button variant="secondary" onClick={() => setEditing('new')}>
              New term
            </Button>
          ) : undefined
        }
      >
        {error && <Notice kind="error">{error}</Notice>}
        {message && <Notice kind="success">{message}</Notice>}
        {rows === null && !error && <p className="text-sm text-black/60">Loading…</p>}
        {rows?.length === 0 && <p className="text-sm text-black/60">No terms yet.</p>}
        {rows && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-black/60 uppercase">
                  <th className="pr-3 pb-2 font-semibold">Term</th>
                  <th className="pr-3 pb-2 font-semibold">Dates</th>
                  <th className="pr-3 pb-2 font-semibold">Ages</th>
                  <th className="pr-3 pb-2 font-semibold">Sessions</th>
                  <th className="pr-3 pb-2 font-semibold">Enrolled</th>
                  <th className="pb-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-t border-black/10">
                    <td className="py-2 pr-3">
                      {isAdmin ? (
                        <Button variant="link" onClick={() => setEditing(t)}>
                          {t.name}
                        </Button>
                      ) : (
                        t.name
                      )}
                      <div className="font-mono text-xs text-black/50">{t.path}</div>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {formatLong(t.startDate)}
                      {t.endDate && ` – ${formatLong(t.endDate)}`}
                    </td>
                    <td className="py-2 pr-3">{t.ageGroup ?? ''}</td>
                    <td className="py-2 pr-3">
                      <Button variant="link" onClick={() => setOpen(open === t.id ? null : t.id)}>
                        {t.sessions} {open === t.id ? '▴' : '▾'}
                      </Button>
                    </td>
                    <td className="py-2 pr-3">{capText(t.product, p.capPlayers)}</td>
                    <td className="py-2">
                      <StatusBadge status={t.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {openTerm && (
        <SessionsPanel
          key={openTerm.id}
          me={me}
          view={view}
          termId={openTerm.id}
          term={openTerm}
          onChanged={() => {
            void load()
            onChanged()
          }}
        />
      )}
      {editing && (
        <TermDialog
          view={view}
          venues={venues}
          term={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null)
            setMessage(text)
            void load()
            onChanged()
          }}
        />
      )}
    </div>
  )
}

function TermDialog({
  view,
  venues,
  term,
  onCancel,
  onDone,
}: {
  view: ProgrammeView
  venues: VenueRow[]
  term: TermRow | null
  onCancel: () => void
  onDone: (message: string) => void
}) {
  const p = view.programme
  const [name, setName] = useState(term?.name ?? '')
  const [slug, setSlug] = useState(term?.slug ?? '')
  const [startDate, setStartDate] = useState(term?.startDate ?? '')
  const [endDate, setEndDate] = useState(term?.endDate ?? '')
  const [weekday, setWeekday] = useState(term?.weekday === null || term?.weekday === undefined ? '' : String(term.weekday))
  const [startTime, setStartTime] = useState(term?.startTime ?? p.startTime ?? '')
  const [endTime, setEndTime] = useState(term?.endTime ?? p.endTime ?? '')
  const [venueId, setVenueId] = useState(term?.venueId ?? '')
  const [courtId, setCourtId] = useState(term?.courtId ?? '')
  const [ageGroup, setAgeGroup] = useState(term?.ageGroup ?? '')
  const [status, setStatus] = useState<OccurrenceStatus>(term?.status ?? 'scheduled')
  const [note, setNote] = useState(term?.note ?? '')
  const [capacity, setCapacity] = useState(term?.product?.capacity === null || !term?.product ? '' : String(term.product.capacity))
  const [addSessions, setAddSessions] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy('save')
    setError(null)
    const body = {
      name,
      ...(term || slug ? { slug: slug || slugify(name) } : {}),
      startDate,
      endDate: endDate || null,
      weekday: weekday === '' ? null : Number(weekday),
      startTime: startTime || null,
      endTime: endTime || null,
      venueId: venueId || null,
      courtId: courtId || null,
      ageGroup: ageGroup || null,
      status,
      note: note || null,
      capacity: intOrNull(capacity),
    }
    try {
      const r = term
        ? await api<{ cache: PurgeResult }>(`/api/admin/terms/${term.id}`, {
            method: 'PATCH',
            body: { ...body, baseUpdatedAt: term.updatedAt },
          })
        : await api<{ cache: PurgeResult }>(`/api/admin/programmes/${p.id}/terms`, { body: { ...body, addSessions } })
      onDone(`${term ? 'Saved' : 'Added'} ${name}.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }
  const remove = async () => {
    if (!term || !window.confirm(`Delete ${term.name} and its ${term.sessions} sessions?`)) return
    setBusy('delete')
    try {
      const r = await api<{ cache: PurgeResult }>(`/api/admin/terms/${term.id}`, { method: 'DELETE' })
      onDone(`Deleted ${term.name}.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  return (
    <Dialog title={term ? term.name : 'New term'} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Term 4 2026" />
          <Field label="URL name" value={slug} placeholder={slugify(name)} onChange={(e) => setSlug(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <Field label="Ends" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Select label="Day" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
            <option value="">{WEEKDAY_NAMES[p.weekday]} (usual)</option>
            {WEEKDAY_NAMES.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </Select>
          <Field label="Start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          <Field label="Finish" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>
        <PlaceFields venues={venues} venueId={venueId} courtId={courtId} onVenue={setVenueId} onCourt={setCourtId} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Age group" maxLength={60} value={ageGroup} placeholder="Ages 8–12" onChange={(e) => setAgeGroup(e.target.value)} />
          <Field
            label="Cap"
            type="number"
            min={0}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            hint={`Blank = ${p.capPlayers ?? 'no limit'}.`}
          />
        </div>
        {term && (
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as OccurrenceStatus)}>
            {OCCURRENCE.map((s) => (
              <option key={s} value={s}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        )}
        <TextArea label="Note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        {!term && (
          <Checkbox
            label="Add its weekly sessions now"
            hint="One session a week from the start to the end date (needs an end date)."
            checked={addSessions && !!endDate}
            disabled={!endDate}
            onChange={setAddSessions}
          />
        )}
        <div className="flex flex-wrap justify-between gap-2">
          {term ? (
            <Button variant="danger" busy={busy === 'delete'} disabled={!!busy} onClick={() => void remove()}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" busy={busy === 'save'} disabled={!!busy}>
              {term ? 'Save' : 'Add term'}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}

// ── Events: dates ─────────────────────────────────────────────────────────────

function EventsPanel({ me, view, onChanged }: { me: Me; view: ProgrammeView; onChanged: () => void }) {
  const isAdmin = me.user.role !== 'editor'
  const p = view.programme
  const venues = useVenues()
  const [rows, setRows] = useState<EventRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [editing, setEditing] = useState<EventRow | 'new' | null>(null)
  const load = useCallback(
    () =>
      api<{ events: EventRow[] }>(`/api/admin/programmes/${p.id}/events`)
        .then((r) => setRows(r.events))
        .catch((e) => setError(errorMessage(e))),
    [p.id],
  )
  useEffect(() => {
    void load()
  }, [load])

  return (
    <Card
      title="Dates"
      actions={
        isAdmin ? (
          <Button variant="secondary" onClick={() => setEditing('new')}>
            Add a date
          </Button>
        ) : undefined
      }
    >
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      {rows === null && !error && <p className="text-sm text-black/60">Loading…</p>}
      {rows?.length === 0 && <p className="text-sm text-black/60">No dates yet.</p>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-black/60 uppercase">
                <th className="pr-3 pb-2 font-semibold">Name</th>
                <th className="pr-3 pb-2 font-semibold">When</th>
                <th className="pr-3 pb-2 font-semibold">Where</th>
                <th className="pr-3 pb-2 font-semibold">Players</th>
                <th className="pr-3 pb-2 font-semibold">Teams</th>
                <th className="pb-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((ev) => (
                <tr key={ev.id} className="border-t border-black/10">
                  <td className="py-2 pr-3">
                    {isAdmin ? (
                      <Button variant="link" onClick={() => setEditing(ev)}>
                        {ev.name}
                      </Button>
                    ) : (
                      ev.name
                    )}
                    <div className="font-mono text-xs text-black/50">{ev.path}</div>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    {formatLong(ev.startDate)}
                    {ev.endDate && ` – ${formatLong(ev.endDate)}`}
                    <div className="text-xs text-black/60">{formatTimeRange(ev.startTime, ev.endTime)}</div>
                    {ev.originalStartDate && <div className="text-xs text-black/60">was {formatLong(ev.originalStartDate)}</div>}
                  </td>
                  <td className="py-2 pr-3">{venues.find((v) => v.id === ev.venueId)?.name ?? view.venue?.name ?? '—'}</td>
                  <td className="py-2 pr-3">{capText(ev.product, p.capPlayers)}</td>
                  <td className="py-2 pr-3">{capText(ev.product, p.capTeams, true)}</td>
                  <td className="py-2">
                    <StatusBadge status={ev.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <EventDialog
          view={view}
          venues={venues}
          event={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null)
            setMessage(text)
            void load()
            onChanged()
          }}
        />
      )}
    </Card>
  )
}

function EventDialog({
  view,
  venues,
  event,
  onCancel,
  onDone,
}: {
  view: ProgrammeView
  venues: VenueRow[]
  event: EventRow | null
  onCancel: () => void
  onDone: (message: string) => void
}) {
  const p = view.programme
  const [name, setName] = useState(event?.name ?? '')
  const [slug, setSlug] = useState(event?.slug ?? '')
  const [startDate, setStartDate] = useState(event?.startDate ?? '')
  const [endDate, setEndDate] = useState(event?.endDate ?? '')
  const [startTime, setStartTime] = useState(event?.startTime ?? p.startTime ?? '')
  const [endTime, setEndTime] = useState(event?.endTime ?? p.endTime ?? '')
  const [venueId, setVenueId] = useState(event?.venueId ?? '')
  const [status, setStatus] = useState<OccurrenceStatus>(event?.status ?? 'scheduled')
  const [note, setNote] = useState(event?.note ?? '')
  const [capacity, setCapacity] = useState(cap(event?.product?.capacity))
  const [capacityTeams, setCapacityTeams] = useState(cap(event?.product?.capacityTeams))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const defaultName = startDate ? `${p.name} ${startDate.slice(0, 4)}` : p.name

  const save = async () => {
    setBusy('save')
    setError(null)
    const body = {
      name: name || defaultName,
      ...(event || slug ? { slug: slug || slugify(name || defaultName) } : {}),
      startDate,
      endDate: endDate || null,
      startTime: startTime || null,
      endTime: endTime || null,
      venueId: venueId || null,
      status,
      note: note || null,
      capacity: intOrNull(capacity),
      capacityTeams: intOrNull(capacityTeams),
    }
    try {
      const r = event
        ? await api<{ cache: PurgeResult }>(`/api/admin/events/${event.id}`, {
            method: 'PATCH',
            body: { ...body, baseUpdatedAt: event.updatedAt },
          })
        : await api<{ cache: PurgeResult }>(`/api/admin/programmes/${p.id}/events`, { body })
      onDone(`${event ? 'Saved' : 'Added'} ${body.name}.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }
  const remove = async () => {
    if (!event || !window.confirm(`Delete ${event.name}?`)) return
    setBusy('delete')
    try {
      const r = await api<{ cache: PurgeResult }>(`/api/admin/events/${event.id}`, { method: 'DELETE' })
      onDone(`Deleted ${event.name}.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  return (
    <Dialog title={event ? event.name : 'Add a date'} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" maxLength={120} value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} />
          <Field label="URL name" value={slug} placeholder={slugify(name || defaultName)} onChange={(e) => setSlug(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Starts"
            type="date"
            required
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            hint={
              event && startDate !== event.startDate
                ? `Keeps ${event.originalStartDate ?? event.startDate} as the original date.`
                : undefined
            }
          />
          <Field label="Ends (if more than a day)" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          <Field label="Finish" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>
        <Select label="Venue" value={venueId} onChange={(e) => setVenueId(e.target.value)}>
          <option value="">{view.venue ? `${view.venue.name} (usual)` : 'None'}</option>
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Player cap"
            type="number"
            min={0}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            hint={`Blank = ${p.capPlayers ?? 'no limit'}.`}
          />
          <Field
            label="Team cap"
            type="number"
            min={0}
            value={capacityTeams}
            onChange={(e) => setCapacityTeams(e.target.value)}
            hint={`Blank = ${p.capTeams ?? 'no limit'}.`}
          />
        </div>
        {event && (
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as OccurrenceStatus)}>
            {OCCURRENCE.map((s) => (
              <option key={s} value={s}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        )}
        <TextArea label="Note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="flex flex-wrap justify-between gap-2">
          {event ? (
            <Button variant="danger" busy={busy === 'delete'} disabled={!!busy} onClick={() => void remove()}>
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" busy={busy === 'save'} disabled={!!busy}>
              {event ? 'Save' : 'Add'}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
