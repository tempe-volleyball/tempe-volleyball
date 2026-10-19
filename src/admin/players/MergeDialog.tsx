import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { PlayerDetail, PlayerList, PlayerListItem } from '../../server/players/admin'
import { Button, Checkbox, Dialog, EmailText, Field, Notice, Skeleton, errorMessage, toast } from '../ui'
import { fullName, genderLabel } from './shared'

// Merge a duplicate into this player (docs/admin.md §3.16): pick the other record, compare the two, then merge.
// Everything the duplicate has (EOIs, enrolments, rosters, team captaincies) moves to the kept player and the
// duplicate is deleted; a duplicate enrolment for the same target is cancelled rather than lost.

type MergeSummary = {
  registrationsMoved: number
  registrationsCancelled: number
  interestsMoved: number
  captaincies: number
  rostersMoved: number
  rosterDuplicatesDropped: number
  filled: string[]
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function summaryText(m: MergeSummary): string {
  const moved = [
    m.registrationsMoved && plural(m.registrationsMoved, 'enrolment'),
    m.interestsMoved && plural(m.interestsMoved, 'EOI'),
    m.rostersMoved && plural(m.rostersMoved, 'roster spot'),
    m.captaincies && plural(m.captaincies, 'captaincy', 'captaincies'),
  ].filter(Boolean)
  const extra = [
    m.registrationsCancelled && `${plural(m.registrationsCancelled, 'duplicate enrolment')} cancelled`,
    m.rosterDuplicatesDropped && `${plural(m.rosterDuplicatesDropped, 'duplicate roster spot')} dropped`,
    m.filled.length && `${plural(m.filled.length, 'blank detail')} filled in`,
  ].filter(Boolean)
  return `Merged${moved.length ? `: ${moved.join(', ')} moved` : ''}${extra.length ? `; ${extra.join(', ')}` : ''}.`
}

const COMPARE: [string, (p: PlayerDetail['player']) => string][] = [
  ['Name', (p) => fullName(p)],
  ['Email', (p) => p.email],
  ['Phone', (p) => p.phone ?? ''],
  ['Gender', (p) => genderLabel(p.gender)],
  ['Year of birth', (p) => (p.birthYear ? String(p.birthYear) : '')],
  ['Suburb', (p) => p.suburb ?? ''],
  ['VNSW number', (p) => p.vnswNumber ?? ''],
  ['Emergency contact', (p) => p.emergencyContact ?? ''],
  ['Guardian', (p) => [p.guardianName, p.guardianEmail, p.guardianPhone].filter(Boolean).join(', ')],
  ['Notes', (p) => p.notes ?? ''],
]

const counts = (d: PlayerDetail) =>
  [
    plural(d.references.interests, 'EOI'),
    plural(d.references.registrations, 'enrolment'),
    plural(d.references.rosters, 'roster spot'),
    ...(d.references.captainOf ? [plural(d.references.captainOf, 'team captaincy', 'team captaincies')] : []),
  ].join(', ')

export function MergeDialog({
  keep,
  onCancel,
  onMerged,
}: {
  keep: PlayerDetail
  onCancel: () => void
  onMerged: (d: PlayerDetail) => void
}) {
  const pool = keep.player.pool
  const [q, setQ] = useState(`${keep.player.firstName} ${keep.player.lastName}`)
  const [results, setResults] = useState<PlayerListItem[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [chosen, setChosen] = useState<PlayerDetail | null>(null)
  const [loadingChosen, setLoadingChosen] = useState(false)
  const [fillBlanks, setFillBlanks] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  useEffect(() => {
    const term = q.trim()
    const n = ++seq.current
    const t = setTimeout(() => {
      const p = new URLSearchParams({ pool, retired: 'any', sort: 'name' })
      if (term) p.set('q', term)
      api<PlayerList>(`/api/admin/players?${p}`).then(
        (r) => {
          if (n !== seq.current) return
          setSearchError(null)
          setResults(r.rows.filter((x) => x.id !== keep.player.id))
        },
        (e: unknown) => n === seq.current && setSearchError(errorMessage(e)),
      )
    }, 300)
    return () => clearTimeout(t)
  }, [q, pool, keep.player.id])

  const choose = async (id: string) => {
    setLoadingChosen(true)
    setError(null)
    setConfirming(false)
    try {
      setChosen(await api<PlayerDetail>(`/api/admin/players/${encodeURIComponent(id)}`))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoadingChosen(false)
    }
  }

  const merge = async () => {
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      const r = await api<PlayerDetail & { merge: MergeSummary }>(`/api/admin/players/${encodeURIComponent(keep.player.id)}`, {
        body: { action: 'merge', mergeId: chosen.player.id, fillBlanks },
      })
      toast(summaryText(r.merge))
      onMerged(r)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Dialog title={`Merge a duplicate into ${fullName(keep.player)}`} onCancel={onCancel} wide dirty={!!chosen}>
      <div className="space-y-4">
        <p className="text-sm text-black/70">
          Pick the other record for the same person. Everything on it (EOIs, enrolments, rosters) moves to{' '}
          <strong>{fullName(keep.player)}</strong>, and the duplicate is deleted.
        </p>
        {error && <Notice kind="error">{error}</Notice>}

        {!chosen && (
          <>
            <Field
              label="Find the duplicate"
              type="search"
              value={q}
              placeholder="Name, email or phone"
              onChange={(e) => setQ(e.target.value)}
            />
            {searchError && <Notice kind="error">{searchError}</Notice>}
            {!results && !searchError && <Skeleton lines={3} label="Searching…" />}
            {results && results.length === 0 && <p className="text-sm text-black/70">No other {pool} players match.</p>}
            {results && results.length > 0 && (
              <ul className="max-h-72 divide-y divide-black/10 overflow-y-auto rounded border border-black/10">
                {results.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="hover:bg-brand/5 w-full px-3 py-2.5 text-left text-sm"
                      disabled={loadingChosen}
                      onClick={() => void choose(r.id)}
                    >
                      <span className="text-brand block font-semibold">
                        {fullName(r)}
                        {r.retiredAt ? ' (retired)' : ''}
                      </span>
                      <span className="block text-xs text-black/70">
                        {r.email ? <EmailText email={r.email} /> : 'No email'}
                        {r.phone ? ` · ${r.phone}` : ''}
                        {r.lastSpot ? ` · ${r.lastSpot.teamName}, ${r.lastSpot.seasonName}` : ''}
                        {r.lastEnrolment ? ` · ${r.lastEnrolment.programmeName}: ${r.lastEnrolment.label}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {loadingChosen && <Skeleton lines={2} label="Loading that player…" />}
          </>
        )}

        {chosen && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-black/10 text-left">
                    <th className="py-2 pr-3" />
                    <th className="py-2 pr-3 font-semibold">Keep</th>
                    <th className="py-2 pr-3 font-semibold">Duplicate (deleted)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {COMPARE.map(([label, f]) => {
                    const a = f(keep.player)
                    const b = f(chosen.player)
                    if (!a && !b) return null
                    const fills = fillBlanks && !a && !!b && label !== 'Name'
                    return (
                      <tr key={label} className="align-top">
                        <th scope="row" className="py-1.5 pr-3 text-left font-semibold whitespace-nowrap">
                          {label}
                        </th>
                        <td className={`py-1.5 pr-3 [overflow-wrap:anywhere] ${fills ? 'text-green-800' : ''}`}>
                          {fills ? `${b} (from the duplicate)` : a || <span className="text-black/50">—</span>}
                        </td>
                        <td className={`py-1.5 pr-3 [overflow-wrap:anywhere] ${a && b && a !== b ? 'text-black/60 line-through' : ''}`}>
                          {b || <span className="text-black/50">—</span>}
                        </td>
                      </tr>
                    )
                  })}
                  <tr className="align-top">
                    <th scope="row" className="py-1.5 pr-3 text-left font-semibold">
                      History
                    </th>
                    <td className="py-1.5 pr-3">{counts(keep)}</td>
                    <td className="py-1.5 pr-3">{counts(chosen)} (moves over)</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <Checkbox
              label="Fill the kept player’s blank details from the duplicate"
              hint="Only empty details are filled; the kept player’s own details always stay. Notes are joined."
              checked={fillBlanks}
              onChange={setFillBlanks}
            />
            {!confirming ? (
              <div className="flex flex-wrap justify-between gap-2">
                <Button variant="link" onClick={() => setChosen(null)}>
                  Pick someone else
                </Button>
                <Button variant="danger" onClick={() => setConfirming(true)}>
                  Merge…
                </Button>
              </div>
            ) : (
              <Notice kind="warning">
                <p>
                  Merge <strong>{fullName(chosen.player)}</strong> into <strong>{fullName(keep.player)}</strong> and delete the duplicate?
                  This can’t be undone. If both have an enrolment for the same thing, the duplicate’s is cancelled.
                </p>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Button variant="secondary" autoFocus onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                  <Button variant="dangerSolid" busy={busy} onClick={() => void merge()}>
                    Merge and delete the duplicate
                  </Button>
                </div>
              </Notice>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
