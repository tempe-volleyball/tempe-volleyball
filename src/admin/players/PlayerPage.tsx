import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'wouter'
import { formatAud } from '../../lib/time'
import { api, formatWhen } from '../api'
import type { PlayerDetail } from '../../server/players/admin'
import { Breadcrumbs, Button, Card, EmailText, LoadError, Notice, Skeleton, confirmAction, errorMessage, toast } from '../ui'
import { MergeDialog } from './MergeDialog'
import { PlayerDialog } from './PlayerDialog'
import { Chip, POOL_LABEL, SOURCE_LABEL, STATUS_LABEL, fullName, genderLabel, isPool, shortDate, telHref, type Pool } from './shared'

// One player (docs/admin.md §3.16): their details, every expression of interest, enrolment and season roster
// they've been on, and the actions: edit, retire, merge a duplicate into them, delete (only with no history).

const ENROLMENT_STATUS: Record<string, string> = {
  pending_email: 'Awaiting email',
  pending_payment: 'Unpaid',
  paid: 'Paid',
  confirmed: 'Confirmed',
  waitlist: 'Waitlist',
  offered: 'Offered',
  cancelled: 'Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
}

const AUDIT_LABEL: Record<string, string> = {
  'player.create': 'Added',
  'player.update': 'Changed',
  'player.merge': 'Merged a duplicate in',
  'player.delete': 'Deleted',
}

export function PlayerPage({ pool: rawPool, id }: { pool: string; id: string }) {
  const [, navigate] = useLocation()
  const [d, setD] = useState<PlayerDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'edit' | 'merge' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const fetchPlayer = useCallback(() => {
    api<PlayerDetail>(`/api/admin/players/${encodeURIComponent(id)}`).then(
      (r) => {
        setError(null)
        setD(r)
      },
      (e: unknown) => setError(errorMessage(e)),
    )
  }, [id])
  useEffect(() => fetchPlayer(), [fetchPlayer])

  const pool: Pool = d ? d.player.pool : isPool(rawPool) ? rawPool : 'competition'
  const listHref = `/players/${pool}`
  const crumbs = [
    { label: 'Players', href: '/players/competition' },
    { label: POOL_LABEL[pool], href: listHref },
    { label: d ? fullName(d.player) : 'Player' },
  ]

  if (error)
    return (
      <div className="space-y-4">
        <Breadcrumbs items={crumbs} />
        <LoadError
          message={error}
          onRetry={() => {
            setError(null)
            fetchPlayer()
          }}
        />
      </div>
    )
  if (!d)
    return (
      <div className="space-y-4">
        <Breadcrumbs items={crumbs} />
        <Card>
          <Skeleton lines={6} label="Loading the player…" />
        </Card>
      </div>
    )

  const p = d.player
  const refs = d.references
  const inUse = refs.registrations + refs.interests + refs.rosters + refs.captainOf > 0
  const history = [
    refs.registrations && `${refs.registrations} enrolment${refs.registrations === 1 ? '' : 's'}`,
    refs.interests && `${refs.interests} expression${refs.interests === 1 ? '' : 's'} of interest`,
    refs.rosters && `${refs.rosters} season roster${refs.rosters === 1 ? '' : 's'}`,
    refs.captainOf && `captain of ${refs.captainOf} team entr${refs.captainOf === 1 ? 'y' : 'ies'}`,
  ].filter(Boolean)

  const retire = async (on: boolean) => {
    if (
      on &&
      !(await confirmAction({
        title: `Retire ${fullName(p)}?`,
        body: (
          <p>
            Retired players are hidden from the season builder’s player picker and the other groups; they show only under Retired. Their
            history stays, and you can un-retire them any time.
          </p>
        ),
        confirmLabel: 'Retire player',
      }))
    )
      return
    setBusy('retire')
    try {
      setD(await api<PlayerDetail>(`/api/admin/players/${encodeURIComponent(id)}`, { body: { action: on ? 'retire' : 'unretire' } }))
      toast(on ? 'Retired.' : 'Back from retirement.')
    } catch (e) {
      toast(errorMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (
      !(await confirmAction({
        title: `Delete ${fullName(p)} for good?`,
        body: 'Their player record is removed. It can’t be brought back.',
        confirmLabel: 'Delete player',
        danger: true,
      }))
    )
      return
    setBusy('delete')
    try {
      await api(`/api/admin/players/${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast('Player deleted.')
      navigate(listHref)
    } catch (e) {
      toast(errorMessage(e), 'error')
      setBusy(null)
      fetchPlayer()
    }
  }

  const details: [string, ReactNode][] = [
    [
      'Email',
      p.email ? (
        <EmailText key="email" email={p.email} />
      ) : (
        <span key="none" className="text-black/60">
          None
        </span>
      ),
    ],
    [
      'Phone',
      p.phone ? (
        <a key="phone" href={telHref(p.phone)} className="text-brand underline">
          {p.phone}
        </a>
      ) : (
        ''
      ),
    ],
    ['Gender', genderLabel(p.gender)],
    ['Year of birth', p.birthYear ?? ''],
    ['Suburb', p.suburb ?? ''],
    ['VNSW number', p.vnswNumber ?? ''],
    ['Emergency contact', p.emergencyContact ?? ''],
    ['Guardian', [p.guardianName, p.guardianEmail, p.guardianPhone].filter(Boolean).join(', ')],
    ['Added', `${formatWhen(p.createdAt)}${p.source ? ` (${SOURCE_LABEL[p.source] ?? p.source})` : ''}`],
    ['Last changed', `${formatWhen(p.updatedAt)}${p.updatedByName ? ` by ${p.updatedByName}` : ''}`],
  ]

  return (
    <div className="space-y-5">
      <Breadcrumbs items={crumbs} />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{fullName(p)}</h1>
        <Chip>{POOL_LABEL[pool]}</Chip>
        {p.retiredAt && <Chip>Retired {shortDate(p.retiredAt)}</Chip>}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card
            title="Details"
            actions={
              <Button variant="secondary" className="px-3 py-1.5" onClick={() => setDialog('edit')}>
                Edit
              </Button>
            }
          >
            <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
              {details
                .filter(([, v]) => v !== '' && v !== null)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="font-semibold">{k}</dt>
                    <dd className="mb-1 [overflow-wrap:anywhere] sm:mb-0">{v}</dd>
                  </div>
                ))}
            </dl>
            {p.notes && (
              <div className="border-accent mt-4 rounded border-l-4 bg-black/[0.02] px-4 py-3 text-sm whitespace-pre-wrap">{p.notes}</div>
            )}
          </Card>

          <Card title="Expressions of interest">
            {d.interests.length === 0 ? (
              <p className="text-sm text-black/70">None.</p>
            ) : (
              <ul className="divide-y divide-black/10">
                {d.interests.map((e) => (
                  <li key={e.interestId} className="py-2.5 text-sm">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Link href={`/interest/${e.interestId}`} className="text-brand font-semibold underline">
                        {e.reference}
                      </Link>
                      <span>
                        {e.kind === 'team'
                          ? `Team${e.teamName ? ` ${e.teamName}` : ''} (${e.role === 'captain' ? 'captain' : 'member'})`
                          : 'As a player'}
                      </span>
                      {e.archivedAt && <Chip>Archived</Chip>}
                    </span>
                    <span className="mt-1 flex flex-wrap gap-1">
                      {e.programmes.map((pr) => (
                        <Chip key={pr.programmeId} tone={pr.status === 'new' ? 'accent' : pr.status === 'placed' ? 'good' : 'muted'}>
                          {pr.code}: {STATUS_LABEL[pr.status] ?? pr.status}
                        </Chip>
                      ))}
                    </span>
                    <span className="mt-0.5 block text-xs text-black/60">Sent {formatWhen(e.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {(pool === 'competition' || d.rosters.length > 0) && (
            <Card title="Season rosters">
              {d.rosters.length === 0 ? (
                <p className="text-sm text-black/70">Not on a season roster yet.</p>
              ) : (
                <ul className="divide-y divide-black/10">
                  {d.rosters.map((s) => (
                    <li key={`${s.seasonId}-${s.teamId}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2.5 text-sm">
                      <Link href={`/seasons/${s.seasonId}`} className="text-brand font-semibold underline">
                        {s.seasonName}
                      </Link>
                      <span>{s.teamName}</span>
                      {s.role === 'captain' && <Chip tone="accent">Captain</Chip>}
                      <span className="text-xs text-black/60">
                        {s.leagueName} · from {shortDate(s.startDate)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {(pool === 'training' || d.enrolments.length > 0) && (
            <Card title="Enrolments">
              {d.enrolments.length === 0 ? (
                <p className="text-sm text-black/70">None.</p>
              ) : (
                <ul className="divide-y divide-black/10">
                  {d.enrolments.map((r) => (
                    <li key={r.id} className="py-2.5 text-sm">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {r.target ? (
                          <Link href={`/enrolments/${r.target.kind}/${r.target.id}`} className="text-brand font-semibold underline">
                            {r.programmeName ? `${r.programmeName}: ${r.label}` : r.label}
                          </Link>
                        ) : (
                          <span className="font-semibold">{r.programmeName ? `${r.programmeName}: ${r.label}` : r.label}</span>
                        )}
                        <Chip
                          tone={r.status === 'cancelled' || r.status === 'expired' ? 'muted' : r.status === 'confirmed' ? 'good' : 'accent'}
                        >
                          {ENROLMENT_STATUS[r.status] ?? r.status}
                        </Chip>
                      </span>
                      <span className="mt-0.5 block text-xs text-black/60">
                        {r.reference}
                        {r.teamName
                          ? ` · ${r.freeAgent ? 'free agent placed in' : 'team'} ${r.teamName}`
                          : r.freeAgent
                            ? ' · free agent'
                            : ''}
                        {r.amountCents !== null ? ` · ${formatAud(r.amountCents)} ${r.paidAt ? 'paid' : 'unpaid'}` : ''}
                        {` · ${formatWhen(r.createdAt)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}

          {d.captainOf.length > 0 && (
            <Card title="Captain of">
              <ul className="list-disc pl-5 text-sm">
                {d.captainOf.map((g) => (
                  <li key={g.groupId}>{g.name}</li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card title="Actions">
            <div className="flex flex-col items-start gap-3">
              <Button variant="secondary" onClick={() => setDialog('merge')}>
                Merge a duplicate in…
              </Button>
              <p className="-mt-1 text-xs text-black/60">Two records for one person? Merge the other into this one.</p>
              {p.retiredAt ? (
                <Button variant="secondary" busy={busy === 'retire'} onClick={() => void retire(false)}>
                  Un-retire
                </Button>
              ) : (
                <Button variant="secondary" busy={busy === 'retire'} onClick={() => void retire(true)}>
                  Retire
                </Button>
              )}
            </div>
          </Card>
          <Card title="Delete">
            {inUse ? (
              <Notice kind="info">
                This player has history ({history.join(', ')}), so they can’t be deleted. Retire them, or merge them into another record.
              </Notice>
            ) : (
              <p className="mb-3 text-sm text-black/70">No history yet, so this record can be deleted.</p>
            )}
            {!inUse && (
              <Button variant="danger" busy={busy === 'delete'} onClick={() => void remove()}>
                Delete for good
              </Button>
            )}
          </Card>
          {d.history.length > 0 && (
            <Card title="History">
              <ul className="space-y-1.5 text-sm">
                {d.history.map((h, i) => (
                  <li key={i}>
                    <span className="font-semibold">{AUDIT_LABEL[h.action] ?? h.action}</span>
                    <span className="block text-xs text-black/60">
                      {formatWhen(h.at)}
                      {h.actorEmail ? ` · ${h.actorEmail}` : ''}
                      {fieldsOf(h.after)}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {dialog === 'edit' && (
        <PlayerDialog
          pool={pool}
          player={p}
          onCancel={() => setDialog(null)}
          onSaved={(r) => {
            setDialog(null)
            setD(r)
            toast('Saved.')
          }}
        />
      )}
      {dialog === 'merge' && (
        <MergeDialog
          keep={d}
          onCancel={() => setDialog(null)}
          onMerged={(r) => {
            setDialog(null)
            setD(r)
          }}
        />
      )}
    </div>
  )
}

const FIELD_NAMES: Record<string, string> = {
  firstName: 'first name',
  lastName: 'last name',
  email: 'email',
  phone: 'phone',
  gender: 'gender',
  birthYear: 'year of birth',
  suburb: 'suburb',
  vnswNumber: 'VNSW number',
  guardianName: 'guardian',
  guardianEmail: 'guardian email',
  guardianPhone: 'guardian phone',
  emergencyContact: 'emergency contact',
  notes: 'notes',
  retiredAt: 'retired',
}

/** " · phone, suburb" from an audit row's { fields } (values are never in the log). */
function fieldsOf(after: unknown): string {
  const o = after && typeof after === 'object' ? (after as Record<string, unknown>) : {}
  const fields = Array.isArray(o.fields) ? o.fields : 'retiredAt' in o ? ['retiredAt'] : []
  return fields.length ? ` · ${fields.map((f) => FIELD_NAMES[String(f)] ?? String(f)).join(', ')}` : ''
}
