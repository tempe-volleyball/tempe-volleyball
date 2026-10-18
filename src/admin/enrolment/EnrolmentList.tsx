import { useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { formatDate, TARGET_LABELS } from '../../lib/enrolment/targets'
import { api, type TargetSummary } from '../api'
import { Skeleton, Card, Notice, Select, errorMessage } from '../ui'

// Admin → Enrolments: every season, training session, development term and event that takes enrolments, with its
// counts against its caps. Admin and owner only (personal data behind every row).

const KIND_LABELS = { league: 'Leagues', training: 'Training', development: 'Development', event: 'Events' } as const

export const capText = (n: number, cap: number | null) => (cap === null ? String(n) : `${n} / ${cap}`)

export function Fill({ n, cap }: { n: number; cap: number | null }) {
  if (cap === null || cap === 0) return <span>{capText(n, cap)}</span>
  const pct = Math.min(100, Math.round((n / cap) * 100))
  return (
    <span className="inline-flex items-center gap-2">
      <span className="tabular-nums">{capText(n, cap)}</span>
      <span className="hidden h-1.5 w-12 overflow-hidden rounded bg-black/10 sm:inline-block" aria-hidden="true">
        <span className={`block h-full ${pct >= 100 ? 'bg-red-600' : pct >= 80 ? 'bg-accent' : 'bg-brand'}`} style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

export function OpenBadge({ open, status }: { open: boolean; status?: string }) {
  const closedText = status === 'archived' || status === 'past' ? 'Finished' : status === 'cancelled' ? 'Cancelled' : 'Closed'
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-bold uppercase ${open ? 'bg-green-100 text-green-900' : 'bg-black/10 text-black/70'}`}
    >
      {open ? 'Open' : closedText}
    </span>
  )
}

export function EnrolmentList() {
  const [targets, setTargets] = useState<TargetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [kind, setKind] = useState('')
  const [programme, setProgramme] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => {
    void api<{ targets: TargetSummary[] }>(`/api/admin/enrolment/targets${all ? '?all=1' : ''}`)
      .then((r) => setTargets(r.targets))
      .catch((e) => setError(errorMessage(e)))
  }, [all])

  const programmes = useMemo(() => {
    const m = new Map<string, TargetSummary['programme']>()
    for (const t of targets ?? []) m.set(t.programme.id, t.programme)
    return [...m.values()].toSorted((a, b) => a.name.localeCompare(b.name))
  }, [targets])

  const shown = (targets ?? []).filter(
    (t) =>
      (!kind || t.programme.kind === kind) &&
      (!programme || t.programme.id === programme) &&
      (!q || `${t.programme.name} ${t.programme.code} ${t.label}`.toLowerCase().includes(q.toLowerCase())),
  )
  const totals = shown.reduce(
    (acc, t) => ({
      players: acc.players + t.counts.players,
      waitlist: acc.waitlist + t.counts.waitlist + t.counts.teamsWaitlist,
      unpaid: acc.unpaid + t.counts.unpaid,
    }),
    { players: 0, waitlist: 0, unpaid: 0 },
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Enrolments</h1>
          <p className="mt-1 text-sm text-black/60">
            Who has enrolled in each season, session, term and event, against its caps. Open one to mark payments, manage the waitlist and
            export a list.
          </p>
        </div>
        <Link href="/forms" className="text-brand text-sm font-semibold underline">
          Enrolment forms
        </Link>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <Card>
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-semibold">Search</span>
            <input
              type="search"
              className="w-full rounded border border-black/20 px-3 py-2"
              placeholder="Programme, season, date…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
          <Select label="Programme" value={programme} onChange={(e) => setProgramme(e.target.value)}>
            <option value="">All programmes</option>
            {programmes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Include finished seasons and past sessions
        </label>
      </Card>

      {targets === null && !error && <Skeleton />}
      {targets && shown.length === 0 && (
        <Card>
          <p className="text-sm text-black/70">
            Nothing here yet. Seasons, sessions, terms and events appear here as soon as they're set up for a programme; each takes
            enrolments once its programme's enrolment is switched on.
          </p>
        </Card>
      )}
      {shown.length > 0 && (
        <div className="overflow-x-auto rounded border border-black/10 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="bg-black/5 text-xs uppercase">
              <tr>
                <th className="px-3 py-2">Programme</th>
                <th className="px-3 py-2">What</th>
                <th className="px-3 py-2">Starts</th>
                <th className="px-3 py-2">Enrolment</th>
                <th className="px-3 py-2">Players</th>
                <th className="px-3 py-2">Teams</th>
                <th className="px-3 py-2">Waitlist</th>
                <th className="px-3 py-2">Unpaid</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {shown.map((t) => (
                <tr key={`${t.ref.kind}:${t.ref.id}`} className="hover:bg-brand/5">
                  <td className="px-3 py-2">
                    <span className="font-semibold">{t.programme.code}</span> <span className="text-black/60">{t.programme.name}</span>
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/enrolments/${t.ref.kind}/${t.ref.id}`} className="text-brand font-semibold underline">
                      {t.label}
                    </Link>
                    <span className="ml-2 text-xs text-black/60">{TARGET_LABELS[t.ref.kind]}</span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{t.startsOn ? formatDate(t.startsOn) : ''}</td>
                  <td className="px-3 py-2">
                    <OpenBadge open={t.open} status={t.status} />
                  </td>
                  <td className="px-3 py-2">
                    <Fill n={t.counts.players} cap={t.caps.players} />
                  </td>
                  <td className="px-3 py-2">
                    {t.programme.kind === 'league' || t.programme.kind === 'event' ? <Fill n={t.counts.teams} cap={t.caps.teams} /> : '–'}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{t.counts.waitlist + t.counts.teamsWaitlist || ''}</td>
                  <td className="px-3 py-2 tabular-nums">{t.counts.unpaid || ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-black/5 text-xs">
              <tr>
                <td className="px-3 py-2 font-semibold" colSpan={4}>
                  {shown.length} shown
                </td>
                <td className="px-3 py-2">{totals.players}</td>
                <td />
                <td className="px-3 py-2">{totals.waitlist}</td>
                <td className="px-3 py-2">{totals.unpaid}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
