import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { api, formatWhen } from '../api'
import type { InterestDetail, InterestMemberView, InterestOptions, InterestProgrammeRow } from '../../server/interest/admin'
import type { LeagueListItem, TeamListItem } from '../api'
import { GENDER_OPTIONS } from '../../lib/enrolment/forms'
import { formatAud } from '../../lib/time'
import { useUnsavedWarning } from '../unsaved'
import {
  Breadcrumbs,
  Button,
  Card,
  Dialog,
  EmailText,
  Field,
  LoadError,
  Notice,
  Select,
  Skeleton,
  TextArea,
  confirmAction,
  errorMessage,
  toast,
} from '../ui'
import { interestChanged } from './events'
import { KeepPlayersChoice, KindChip, PAYMENT_METHODS, PaidChip, STATUSES, STATUS_LABEL, StatusChip, personName } from './labels'

// One expression of interest (docs/admin.md §3.16): its people (with their player records and what they sent that
// differs, to copy over with "Use these details"), a status per programme (placed with the season and team), the
// form's answers, the deposit (marked paid or unpaid by hand), a note, archive and delete for good, and its history.

const DETAIL_LABELS: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  email: 'Email',
  phone: 'Phone',
  gender: 'Gender',
  birthYear: 'Year of birth',
  suburb: 'Suburb',
  vnswNumber: 'VNSW number',
  guardianName: 'Guardian name',
  guardianEmail: 'Guardian email',
  guardianPhone: 'Guardian phone',
  emergencyContact: 'Emergency contact',
}
const genderLabel = (v: unknown) => GENDER_OPTIONS.find((o) => o.value === v)?.label ?? String(v)
const show = (field: string, v: unknown) =>
  v === null || v === undefined || v === '' ? '—' : field === 'gender' ? genderLabel(v) : String(v)

const HISTORY_LABEL: Record<string, string> = {
  note: 'Note changed',
  mark_paid: 'Marked paid',
  mark_unpaid: 'Marked unpaid',
  status: 'Status changed',
  archive: 'Archived',
  unarchive: 'Unarchived',
  team_name: 'Team name changed',
  add_programme: 'Programme added',
  remove_programme: 'Programme removed',
  apply_details: 'Details copied to a player',
}
function historyText(h: InterestDetail['history'][number], progs: InterestProgrammeRow[]) {
  if (h.action === 'interest.create') return 'Added by hand'
  const a = (h.after ?? {}) as Record<string, unknown>
  const label = HISTORY_LABEL[String(a.action)] ?? h.action
  const code = typeof a.programmeId === 'string' ? progs.find((p) => p.programmeId === a.programmeId)?.code : undefined
  if (a.action === 'status') return `${code ?? 'A programme'}: ${STATUS_LABEL[String(a.status)] ?? a.status}`
  if (a.action === 'apply_details' && Array.isArray(a.fields))
    return `${label} (${a.fields.map((f) => DETAIL_LABELS[String(f)] ?? f).join(', ')})`
  return code ? `${label}: ${code}` : label
}

export function InterestPage({ id }: { id: string }) {
  const [, navigate] = useLocation()
  const [d, setD] = useState<InterestDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [dialog, setDialog] = useState<
    null | { kind: 'paid' } | { kind: 'unpaid' } | { kind: 'place'; row: InterestProgrammeRow } | { kind: 'team' } | { kind: 'add' }
  >(null)
  const dirty = !!d && note.trim() !== (d.interest.note ?? '')
  useUnsavedWarning(dirty)
  const url = `/api/admin/interest/${encodeURIComponent(id)}`

  const fetchIt = useCallback(() => {
    api<InterestDetail>(url).then(
      (r) => {
        setError(null)
        setD(r)
        setNote(r.interest.note ?? '')
      },
      (e: unknown) => setError(errorMessage(e)),
    )
  }, [url])
  useEffect(() => fetchIt(), [fetchIt])

  /** Runs one action; the answer is the EOI as it is now. Returns false on failure (and toasts it). */
  const act = async (body: Record<string, unknown>, what: string, done: string) => {
    setBusy(what)
    try {
      const r = await api<InterestDetail>(url, { body })
      setD(r)
      if (body.action === 'note') setNote(r.interest.note ?? '')
      toast(done)
      interestChanged()
      return true
    } catch (e) {
      toast(errorMessage(e), 'error')
      return false
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    let keepPlayers = false
    if (
      !(await confirmAction({
        title: 'Delete this EOI for good?',
        body: (
          <>
            <p>It can’t be brought back. Archive it instead if you might want it later.</p>
            <KeepPlayersChoice onChange={(v) => (keepPlayers = v)} />
          </>
        ),
        confirmLabel: 'Delete EOI',
        danger: true,
      }))
    )
      return
    setBusy('delete')
    try {
      await api(`${url}${keepPlayers ? '?keepPlayers=1' : ''}`, { method: 'DELETE' })
      toast('EOI deleted.')
      interestChanged()
      navigate('/interest')
    } catch (e) {
      toast(errorMessage(e), 'error')
      setBusy(null)
    }
  }

  const contact = d?.members[0]
  const title = d ? (d.interest.kind === 'team' ? (d.interest.teamName ?? 'Team') : personName(contact?.details)) : 'Expression of interest'
  const crumbs = [{ label: 'Interest', href: '/interest' }, { label: title }]
  if (error)
    return (
      <div className="space-y-4">
        <Breadcrumbs items={crumbs} />
        <LoadError message={error} onRetry={fetchIt} />
      </div>
    )
  if (!d)
    return (
      <div className="space-y-4">
        <Breadcrumbs items={crumbs} />
        <Card>
          <Skeleton lines={6} label="Loading the expression of interest…" />
        </Card>
      </div>
    )

  const i = d.interest
  return (
    <div className="space-y-5">
      <Breadcrumbs items={crumbs} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-2xl font-bold [overflow-wrap:anywhere]">{title}</h1>
        <KindChip kind={i.kind} />
        {i.archivedAt && <span className="rounded bg-black/10 px-2 py-0.5 text-xs font-bold text-black/70 uppercase">Archived</span>}
      </div>
      <p className="-mt-3 text-sm text-black/70">
        {i.reference} · sent {formatWhen(i.createdAt)}
        {i.source === 'admin' ? ' · added by hand' : i.source === 'import' ? ' · imported' : ' · from the website'}
      </p>
      {contact && (contact.details.email || contact.details.phone) && (
        <div className="flex flex-wrap gap-2">
          {contact.details.email && (
            <a
              href={`mailto:${contact.details.email}?subject=${encodeURIComponent(`Tempe Volleyball (${i.reference})`)}`}
              className="bg-brand hover:bg-brand-dark inline-flex items-center rounded px-4 py-2 text-sm font-semibold text-white"
            >
              Email {contact.details.firstName}
            </a>
          )}
          {contact.details.phone && (
            <a
              href={`tel:${contact.details.phone.replace(/[^\d+]/g, '')}`}
              className="border-brand text-brand hover:bg-brand/5 inline-flex items-center rounded border bg-white px-4 py-2 text-sm font-semibold"
            >
              Call {contact.details.phone}
            </a>
          )}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
          <Card title="Programmes">
            <ul className="divide-y divide-black/10">
              {d.programmes.map((p) => (
                <li key={p.programmeId} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="font-semibold">
                      {p.code} <span className="font-normal text-black/70">· {p.name}</span>
                    </p>
                    <p className="text-sm text-black/70">
                      <StatusChip status={p.status} />
                      {p.status === 'placed' && (p.seasonName || p.teamName) && (
                        <span className="ml-2">{[p.seasonName, p.teamName].filter(Boolean).join(', ')}</span>
                      )}
                      {p.status === 'placed' && p.seasonId && (
                        <Link href={`/seasons/${p.seasonId}/setup`} className="text-brand ml-2 underline underline-offset-2">
                          Rosters
                        </Link>
                      )}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-sm">
                      <span className="sr-only">Status for {p.code}</span>
                      <select
                        className="rounded border border-black/20 bg-white px-2 py-2 text-sm"
                        value={p.status}
                        disabled={busy !== null}
                        onChange={(e) => {
                          const status = e.target.value
                          if (status === 'placed') setDialog({ kind: 'place', row: p })
                          else
                            void act(
                              { action: 'status', programmeId: p.programmeId, status },
                              'status',
                              `${p.code}: ${STATUS_LABEL[status]}.`,
                            )
                        }}
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {STATUS_LABEL[s]}
                          </option>
                        ))}
                      </select>
                    </label>
                    {d.programmes.length > 1 && (
                      <Button
                        variant="link"
                        className="text-red-700"
                        disabled={busy !== null}
                        aria-label={`Remove ${p.code} from this EOI`}
                        onClick={async () => {
                          if (
                            await confirmAction({
                              title: `Remove ${p.code} from this EOI?`,
                              body: 'Its status for that programme goes too. The person stays on the other programmes.',
                              confirmLabel: `Remove ${p.code}`,
                              danger: true,
                            })
                          )
                            void act({ action: 'remove_programme', programmeId: p.programmeId }, 'programme', `Removed ${p.code}.`)
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="secondary" disabled={busy !== null} onClick={() => setDialog({ kind: 'add' })}>
                Add a programme
              </Button>
            </div>
            <p className="mt-3 text-xs text-black/60">
              Placing them on a season roster is done from the season builder (season → Setup → Teams), which marks this placed for you.
              Mark it here by hand when you’ve placed them some other way.
            </p>
          </Card>

          <Card title={i.kind === 'team' ? 'People' : 'Person'}>
            {i.kind === 'team' && (
              <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
                <span>
                  Team name: <strong>{i.teamName}</strong>
                </span>
                <Button variant="link" onClick={() => setDialog({ kind: 'team' })}>
                  Change
                </Button>
              </div>
            )}
            <ul className="space-y-4">
              {d.members.map((m) => (
                <MemberCard key={m.id} m={m} kind={i.kind} pool={d.pool} source={i.source} busy={busy} onApply={act} />
              ))}
            </ul>
          </Card>

          <Card title="Answers">
            <p className="mb-3 text-xs text-black/60">From {d.formName}.</p>
            {d.answers.length === 0 ? (
              <p className="text-sm text-black/70">No answers.</p>
            ) : (
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,14rem)_1fr]">
                {d.answers.map((a) => (
                  <div key={a.key} className="contents">
                    <dt className="font-semibold">{a.label}</dt>
                    <dd className="mb-2 whitespace-pre-wrap [overflow-wrap:anywhere] sm:mb-0">{a.text}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card title="Deposit">
            {i.depositCents === null || i.depositCents === 0 ? (
              <p className="text-sm text-black/70">No deposit asked.</p>
            ) : (
              <div className="space-y-3 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <strong>{formatAud(i.depositCents)}</strong> <PaidChip paid={!!i.paidAt} />
                </p>
                {i.paidAt && (
                  <p className="text-black/70">
                    Marked paid {formatWhen(i.paidAt)}
                    {i.paidByName ? ` by ${i.paidByName}` : ''}
                    {i.paymentNote ? ` (${i.paymentNote})` : ''}.
                  </p>
                )}
                {!i.paidAt && i.paymentNote && <p className="text-black/70">Note: {i.paymentNote}</p>}
                {i.paidAt ? (
                  <Button variant="secondary" disabled={busy !== null} onClick={() => setDialog({ kind: 'unpaid' })}>
                    Mark unpaid
                  </Button>
                ) : (
                  <Button disabled={busy !== null} onClick={() => setDialog({ kind: 'paid' })}>
                    Mark paid
                  </Button>
                )}
              </div>
            )}
          </Card>

          <Card title="Note">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault()
                void act({ action: 'note', note }, 'note', 'Note saved.')
              }}
            >
              <TextArea
                label="For the admins (never sent)"
                rows={4}
                maxLength={2000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                hint="E.g. “Rang 20/10, keen on Thursdays.”"
              />
              <Button type="submit" busy={busy === 'note'} disabled={!dirty}>
                Save note
              </Button>
            </form>
          </Card>

          <Card title={i.archivedAt ? 'Archived' : 'Archive'}>
            <p className="mb-3 text-sm text-black/70">
              {i.archivedAt
                ? `Archived ${formatWhen(i.archivedAt)}. It’s out of the inbox, and deleted on its own after the period in Settings → Interest.`
                : 'Done with it? Archiving takes it out of the inbox. Archived EOIs are deleted on their own after the period in Settings → Interest.'}
            </p>
            <Button
              variant="secondary"
              busy={busy === 'archive'}
              onClick={() =>
                void act({ action: i.archivedAt ? 'unarchive' : 'archive' }, 'archive', i.archivedAt ? 'Back in the inbox.' : 'Archived.')
              }
            >
              {i.archivedAt ? 'Unarchive' : 'Archive'}
            </Button>
          </Card>

          <Card title="Delete">
            <p className="mb-3 text-sm text-black/70">Spam, or no longer needed? This deletes it for good.</p>
            <Button variant="danger" busy={busy === 'delete'} onClick={() => void remove()}>
              Delete for good
            </Button>
          </Card>

          {d.history.length > 0 && (
            <Card title="History">
              <ul className="space-y-2 text-sm">
                {d.history.map((h, n) => (
                  <li key={n}>
                    <span className="block">{historyText(h, d.programmes)}</span>
                    <span className="block text-xs text-black/60">
                      {formatWhen(h.at)}
                      {h.actorEmail ? ` · ${h.actorEmail}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {dialog?.kind === 'paid' && (
        <PaidDialog
          amount={i.depositCents}
          onCancel={() => setDialog(null)}
          onSave={async (method, n) => {
            if (await act({ action: 'mark_paid', method, note: n }, 'paid', 'Marked paid.')) setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'unpaid' && (
        <UnpaidDialog
          onCancel={() => setDialog(null)}
          onSave={async (n) => {
            if (await act({ action: 'mark_unpaid', note: n }, 'paid', 'Marked unpaid.')) setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'place' && (
        <PlaceDialog
          row={dialog.row}
          onCancel={() => setDialog(null)}
          onSave={async (seasonId, teamId) => {
            if (
              await act(
                { action: 'status', programmeId: dialog.row.programmeId, status: 'placed', seasonId, teamId },
                'status',
                `${dialog.row.code}: placed.`,
              )
            )
              setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'team' && (
        <TeamNameDialog
          current={i.teamName ?? ''}
          onCancel={() => setDialog(null)}
          onSave={async (teamName) => {
            if (await act({ action: 'team_name', teamName }, 'team', 'Team name saved.')) setDialog(null)
          }}
        />
      )}
      {dialog?.kind === 'add' && (
        <AddProgrammeDialog
          taken={d.programmes.map((p) => p.programmeId)}
          onCancel={() => setDialog(null)}
          onSave={async (programmeId, code) => {
            if (await act({ action: 'add_programme', programmeId }, 'programme', `Added ${code}.`)) setDialog(null)
          }}
        />
      )}
    </div>
  )
}

function MemberCard({
  m,
  kind,
  pool,
  source,
  busy,
  onApply,
}: {
  m: InterestMemberView
  kind: string
  pool: string
  source: string
  busy: string | null
  onApply: (body: Record<string, unknown>, what: string, done: string) => Promise<boolean>
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  // Anyone can send the public form with someone else's email and name: a match to a player on file is a guess.
  const unverified = source === 'public' && !!m.player && !m.createdHere
  const d = m.details
  const sent = Object.entries(DETAIL_LABELS).filter(([k]) => k !== 'firstName' && k !== 'lastName' && d[k as keyof typeof d])
  const role = kind === 'team' ? (m.role === 'captain' ? 'Captain' : 'Member') : null
  return (
    <li className="rounded border border-black/10 p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">
          {personName(d)}
          {role && <span className="ml-2 text-xs font-semibold text-black/60 uppercase">{role}</span>}
        </p>
        {m.player ? (
          <span className="text-right text-sm">
            <Link href={`/players/${pool}/${m.player.id}`} className="text-brand underline underline-offset-2">
              {m.createdHere ? 'New player (added by this EOI)' : `On file since ${formatWhen(m.player.createdAt).split(',')[0]}`}
              {m.player.retiredAt ? ' · retired' : ''}
            </Link>
            {unverified && <span className="block text-xs text-black/60">Matched by email and name, not verified</span>}
          </span>
        ) : (
          <span className="text-sm text-black/60">Player record deleted</span>
        )}
      </div>
      {sent.length > 0 ? (
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          {sent.map(([k, label]) => (
            <div key={k} className="contents">
              <dt className="text-black/70">{label}</dt>
              <dd className="[overflow-wrap:anywhere]">
                {k === 'email' ? <EmailText email={String(d.email)} /> : show(k, d[k as keyof typeof d])}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-1 text-sm text-black/60">Only a name was given.</p>
      )}
      {m.diff.length > 0 && (
        <div className="mt-3 rounded bg-black/[0.03] p-3">
          <p className="mb-2 text-sm font-semibold">Different from their player record</p>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-black/60">
              <tr>
                <th className="w-8 py-1">
                  <span className="sr-only">Use</span>
                </th>
                <th className="py-1 pr-2">Detail</th>
                <th className="py-1 pr-2">Sent</th>
                <th className="hidden py-1 sm:table-cell">On file</th>
              </tr>
            </thead>
            <tbody>
              {m.diff.map((x) => (
                <tr key={x.field} className="border-t border-black/10 align-top">
                  <td className="py-1.5">
                    <input
                      type="checkbox"
                      className="accent-brand h-4 w-4"
                      aria-label={`Use the sent ${DETAIL_LABELS[x.field]}`}
                      checked={chosen.has(x.field)}
                      onChange={(e) =>
                        setChosen((s) => {
                          const n = new Set(s)
                          if (e.target.checked) n.add(x.field)
                          else n.delete(x.field)
                          return n
                        })
                      }
                    />
                  </td>
                  <td className="py-1.5 pr-2">{DETAIL_LABELS[x.field]}</td>
                  <td className="py-1.5 pr-2 [overflow-wrap:anywhere]">
                    {show(x.field, x.sent)}
                    <span className="block text-xs text-black/60 sm:hidden">On file: {show(x.field, x.current)}</span>
                  </td>
                  <td className="hidden py-1.5 [overflow-wrap:anywhere] sm:table-cell">{show(x.field, x.current)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              className="px-3 py-1.5"
              disabled={chosen.size === 0 || busy !== null}
              busy={busy === `apply-${m.id}`}
              onClick={async () => {
                if (
                  unverified &&
                  !(await confirmAction({
                    title: 'Use these details?',
                    body: (
                      <p>
                        This form was matched to {m.player ? personName(m.player) : 'a player'} by email and name only. Anyone can send the
                        public form with someone else’s details, so check it’s really them (call or reply to them) before overwriting their
                        record.
                      </p>
                    ),
                    confirmLabel: 'Use these details',
                  }))
                )
                  return
                if (
                  await onApply({ action: 'apply_details', memberId: m.id, fields: [...chosen] }, `apply-${m.id}`, 'Player record updated.')
                )
                  setChosen(new Set())
              }}
            >
              Use these details
            </Button>
            <span className="text-xs text-black/60">
              {unverified ? 'Matched by email and name, not verified. ' : ''}
              Copies the ticked details onto their player record. Forms never do this on their own.
            </span>
          </div>
        </div>
      )}
    </li>
  )
}

function PaidDialog({
  amount,
  onCancel,
  onSave,
}: {
  amount: number | null
  onCancel: () => void
  onSave: (method: string, note: string) => Promise<void>
}) {
  const [method, setMethod] = useState('payid')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title="Mark the deposit paid" onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          void onSave(method, note).finally(() => setBusy(false))
        }}
      >
        {amount ? <p className="text-sm">The deposit is {formatAud(amount)}.</p> : null}
        <Select label="How they paid" value={method} onChange={(e) => setMethod(e.target.value)}>
          {Object.entries(PAYMENT_METHODS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
        <Field
          label="Note (optional)"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          hint="e.g. the date it arrived, or who took the cash"
        />
        <DialogActions onCancel={onCancel} busy={busy} label="Mark paid" />
      </form>
    </Dialog>
  )
}

function UnpaidDialog({ onCancel, onSave }: { onCancel: () => void; onSave: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title="Mark the deposit unpaid" onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          void onSave(note).finally(() => setBusy(false))
        }}
      >
        <Field
          label="Why (optional)"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          hint="e.g. marked by mistake, or it bounced"
        />
        <DialogActions onCancel={onCancel} busy={busy} label="Mark unpaid" />
      </form>
    </Dialog>
  )
}

function TeamNameDialog({ current, onCancel, onSave }: { current: string; onCancel: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(current)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title="Team name" onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          void onSave(name).finally(() => setBusy(false))
        }}
      >
        <Field label="Team name" value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
        <DialogActions onCancel={onCancel} busy={busy} label="Save" disabled={!name.trim() || name.trim() === current} />
      </form>
    </Dialog>
  )
}

function AddProgrammeDialog({
  taken,
  onCancel,
  onSave,
}: {
  taken: string[]
  onCancel: () => void
  onSave: (programmeId: string, code: string) => Promise<void>
}) {
  const [options, setOptions] = useState<InterestOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api<InterestOptions>('/api/admin/interest/options').then(setOptions, (e: unknown) => setError(errorMessage(e)))
  }, [])
  const free = options?.programmes.filter((p) => !taken.includes(p.id)) ?? []
  const chosen = free.find((p) => p.id === pick)
  return (
    <Dialog title="Add a programme" onCancel={onCancel}>
      {error && <LoadError message={error} />}
      {!options && !error && <Skeleton lines={2} />}
      {options && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!chosen) return
            setBusy(true)
            void onSave(chosen.id, chosen.code).finally(() => setBusy(false))
          }}
        >
          {free.length === 0 ? (
            <Notice kind="info">It’s already on every programme that takes expressions of interest.</Notice>
          ) : (
            <Select label="Programme" value={pick} onChange={(e) => setPick(e.target.value)} hint="It starts as New for that programme.">
              <option value="">Choose…</option>
              {free.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.name}
                </option>
              ))}
            </Select>
          )}
          <DialogActions onCancel={onCancel} busy={busy} label="Add" disabled={!chosen} />
        </form>
      )}
    </Dialog>
  )
}

/**
 * "Placed": which season of the programme (leagues; optional), and optionally which team. Seasons come from
 * GET /api/admin/leagues (leagues only: an event has no seasons, so it can be placed without one).
 */
function PlaceDialog({
  row,
  onCancel,
  onSave,
}: {
  row: InterestProgrammeRow
  onCancel: () => void
  onSave: (seasonId: string | null, teamId: string | null) => Promise<void>
}) {
  const [leagues, setLeagues] = useState<LeagueListItem[] | null>(null)
  const [teams, setTeams] = useState<TeamListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [seasonId, setSeasonId] = useState(row.seasonId ?? '')
  const [teamId, setTeamId] = useState(row.teamId ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    Promise.all([api<{ leagues: LeagueListItem[] }>('/api/admin/leagues'), api<{ teams: TeamListItem[] }>('/api/admin/teams')]).then(
      ([l, t]) => {
        setLeagues(l.leagues)
        setTeams(t.teams)
        const latest = l.leagues.find((x) => x.id === row.programmeId)?.seasons[0]
        if (!row.seasonId && latest) setSeasonId(latest.id)
      },
      (e: unknown) => setError(errorMessage(e)),
    )
  }, [row.programmeId, row.seasonId])
  const seasons = leagues?.find((l) => l.id === row.programmeId)?.seasons ?? []
  // A team must play in the chosen season (the server checks its team list); with no seasons, any team.
  const inSeason = (teams ?? []).filter((t) => t.history.some((h) => h.id === seasonId))
  const teamChoices = (seasons.length === 0 ? (teams ?? []) : seasonId ? inSeason : []).toSorted((a, b) => a.name.localeCompare(b.name))
  return (
    <Dialog title={`Placed in ${row.code}`} onCancel={onCancel}>
      {error && <LoadError message={error} />}
      {!leagues && !error && <Skeleton lines={3} />}
      {leagues && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            setBusy(true)
            const team = teamChoices.some((t) => t.id === teamId) ? teamId : ''
            void onSave(seasonId || null, team || null).finally(() => setBusy(false))
          }}
        >
          {seasons.length > 0 ? (
            <Select label="Season" value={seasonId} onChange={(e) => setSeasonId(e.target.value)}>
              <option value="">Not saying</option>
              {seasons.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.status === 'draft' ? ' (draft)' : ''}
                </option>
              ))}
            </Select>
          ) : (
            <p className="text-sm text-black/70">{row.code} has no seasons, so it’s placed without one.</p>
          )}
          <Select
            label="Team (optional)"
            value={teamChoices.some((t) => t.id === teamId) ? teamId : ''}
            onChange={(e) => setTeamId(e.target.value)}
            disabled={seasons.length > 0 && !seasonId}
          >
            <option value="">Not saying</option>
            {teamChoices.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
          {seasons.length > 0 && seasonId && teamChoices.length === 0 && (
            <p className="text-xs text-black/60">That season has no teams yet. Add them in the season’s Setup → Teams.</p>
          )}
          <p className="text-xs text-black/60">
            This only records where they went. To put them on the season’s roster, use the season builder.
          </p>
          <DialogActions onCancel={onCancel} busy={busy} label="Mark placed" />
        </form>
      )}
    </Dialog>
  )
}

function DialogActions({ onCancel, busy, label, disabled }: { onCancel: () => void; busy: boolean; label: string; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" busy={busy} disabled={disabled}>
        {label}
      </Button>
    </div>
  )
}
