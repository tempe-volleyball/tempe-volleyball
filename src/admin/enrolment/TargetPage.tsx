import { useCallback, useEffect, useMemo, useState } from 'react'
import { ENTRY_TYPE_LABELS } from '../../lib/enrolment/defaults'
import type { FormField } from '../../lib/enrolment/forms'
import { formatDate, TARGET_LABELS, type TargetKind } from '../../lib/enrolment/targets'
import { answerText, isDisplayOnly, isMapped } from '../../lib/enrolment/validate'
import { formatAud } from '../../lib/time'
import { useUnsavedWarning } from '../unsaved'
import { api, formatWhen, type FormsList, type GroupRow, type RegistrationRow, type TargetDetail } from '../api'
import { Breadcrumbs, Skeleton, Button, Card, Dialog, Field, Notice, Select, TextArea, errorMessage, purgeNote } from '../ui'
import { Fill, OpenBadge } from './EnrolmentList'

// One season, session, term or event: its entries, its settings (the product row) and every action on an entry.
// Admin and owner only. Every action is audited on the server; anything that frees a spot offers it to the
// waitlist automatically.

type Detail = TargetDetail & { paymentMethods: Record<string, string> }

const STATUS_STYLE: Record<string, string> = {
  confirmed: 'bg-green-100 text-green-900',
  paid: 'bg-green-100 text-green-900',
  pending_payment: 'bg-accent/30 text-ink',
  waitlist: 'bg-accent/30 text-ink',
  offered: 'bg-brand/15 text-brand',
  pending_email: 'bg-amber-100 text-amber-900',
  cancelled: 'bg-black/10 text-black/60',
  expired: 'bg-black/10 text-black/60',
  refunded: 'bg-black/10 text-black/60',
}
const STATUS_LABEL: Record<string, string> = {
  waitlist: 'Waitlist',
  offered: 'Offered',
  confirmed: 'Confirmed',
  pending_email: 'Awaiting email',
  cancelled: 'Cancelled',
  expired: 'Lapsed',
}

/** `position` is the waitlist rank (1, 2, 3 …), not the stored position, which keeps gaps. */
function Status({ status, position, expires }: { status: string; position?: number | null; expires?: string | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold uppercase ${STATUS_STYLE[status] ?? 'bg-black/10'}`}>
        {STATUS_LABEL[status] ?? status.replace('_', ' ')}
        {status === 'waitlist' && position ? ` #${position}` : ''}
      </span>
      {(status === 'offered' || status === 'pending_email') && expires && (
        <span className="text-xs text-black/60">until {formatWhen(expires)}</span>
      )}
    </span>
  )
}

const LIVE = (s: string) => !['cancelled', 'expired', 'refunded'].includes(s)
const HOLDS = (s: string) => ['pending_payment', 'paid', 'confirmed', 'offered'].includes(s)

type Pending =
  | { kind: 'paid'; reg: RegistrationRow }
  | { kind: 'cancel'; reg?: RegistrationRow; group?: GroupRow }
  | { kind: 'move'; reg: RegistrationRow }
  | { kind: 'place'; reg: RegistrationRow }
  | { kind: 'edit'; reg: RegistrationRow }
  | { kind: 'confirm'; title: string; text: string; run: () => Promise<unknown>; danger?: boolean }
  | { kind: 'add' }
  | { kind: 'addTeam' }
  | { kind: 'rename'; group: GroupRow }

export function TargetPage({ kind, id }: { kind: string; id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('live')
  const [paid, setPaid] = useState('')
  const [entry, setEntry] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())

  const load = useCallback(
    () =>
      api<Detail>(`/api/admin/enrolment/targets/${kind}/${id}`)
        .then((d) => {
          setDetail(d)
          setError(null)
        })
        .catch((e) => setError(errorMessage(e))),
    [kind, id],
  )
  useEffect(() => void load(), [load])

  /** Runs an action, reloads, and reports what happened (including offers made). */
  const act = async (url: string, body: Record<string, unknown>, done: string) => {
    const r = await api<{ offers?: number }>(url, { body })
    setPending(null)
    setFlash(`${done}${r.offers ? ` The freed spot was offered to the waitlist (${r.offers} email${r.offers > 1 ? 's' : ''}).` : ''}`)
    await load()
  }
  const regAct = (reg: RegistrationRow, body: Record<string, unknown>, done: string) =>
    act(`/api/admin/enrolment/registrations/${reg.id}`, body, done)
  const groupAct = (g: GroupRow, body: Record<string, unknown>, done: string) => act(`/api/admin/enrolment/groups/${g.id}`, body, done)

  const fieldsByKey = useMemo(() => new Map((detail?.form.fields ?? []).map((f) => [f.key, f])), [detail])

  if (error && !detail) return <Notice kind="error">{error}</Notice>
  if (!detail) return <Skeleton />

  const { summary, registrations, groups } = detail
  const teamsKind = summary.programme.kind === 'league' || summary.programme.kind === 'event'
  const needle = q.trim().toLowerCase()
  const shown = registrations.filter((r) => {
    if (status === 'live' ? !LIVE(r.status) : status && r.status !== status) return false
    if (paid === 'unpaid' && (r.paidAt || !r.amountCents || !HOLDS(r.status))) return false
    if (paid === 'paid' && !r.paidAt) return false
    if (entry && r.entryType !== entry) return false
    if (!needle) return true
    const p = r.player
    return [
      r.reference,
      p.firstName,
      p.lastName,
      `${p.firstName} ${p.lastName}`,
      p.email,
      p.phone ?? '',
      r.teamName ?? '',
      p.guardianName ?? '',
    ]
      .join(' ')
      .toLowerCase()
      .includes(needle)
  })
  const freeAgents = registrations.filter((r) => r.entryType === 'free_agent' && LIVE(r.status))
  const liveGroups = groups.filter((g) => g.status !== 'cancelled')
  const exportBase = `/api/admin/enrolment/targets/${kind}/${id}/export.csv`
  const toggle = (rid: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(rid)) n.delete(rid)
      else n.add(rid)
      return n
    })

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs items={[{ label: 'Enrolments', href: '/enrolments' }, { label: summary.programme.name }]} />
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{summary.label}</h1>
          <OpenBadge open={summary.open} status={summary.status} />
          <span className="text-sm text-black/60">
            {TARGET_LABELS[summary.ref.kind]}
            {summary.startsOn ? ` · ${formatDate(summary.startsOn)}` : ''}
            {summary.endsOn && summary.endsOn !== summary.startsOn ? ` to ${formatDate(summary.endsOn)}` : ''}
          </span>
        </div>
        {!summary.open && summary.status === 'open' && (
          <p className="mt-1 text-sm text-black/60">
            Enrolment is closed: switch it on for the programme (and check the dates below) to take entries on the website. You can still
            add entries by hand.
          </p>
        )}
      </div>

      {flash && <Notice kind="success">{flash}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Players" value={<Fill n={summary.counts.players} cap={summary.caps.players} />} />
        {teamsKind && <Stat label="Teams" value={<Fill n={summary.counts.teams} cap={summary.caps.teams} />} />}
        <Stat label="Waitlist" value={summary.counts.waitlist + summary.counts.teamsWaitlist} />
        <Stat label="Offered" value={summary.counts.offered} />
        <Stat label="Unpaid" value={summary.counts.unpaid} />
        {(summary.counts.pending > 0 || summary.counts.teamsPending > 0 || detail.effective.emailConfirm) && (
          <Stat label="Awaiting email" value={summary.counts.pending + summary.counts.teamsPending} />
        )}
      </div>

      <Settings key={JSON.stringify(detail.product)} detail={detail} onSaved={(msg) => (setFlash(msg), void load())} />

      {teamsKind && (
        <Card
          title={`Team entries (${liveGroups.length})`}
          actions={
            <Button variant="secondary" className="px-3 py-1 text-xs" onClick={() => setPending({ kind: 'addTeam' })}>
              Add a team
            </Button>
          }
        >
          {groups.length === 0 ? (
            <p className="text-sm text-black/60">No team entries yet.</p>
          ) : (
            <ul className="divide-y divide-black/10">
              {groups.map((g) => {
                const captain = registrations.find((r) => r.groupId === g.id && r.entryType === 'team')
                const members = registrations.filter((r) => r.groupId === g.id && r.entryType === 'free_agent' && LIVE(r.status))
                const players = typeof captain?.answers.players === 'string' ? captain.answers.players : ''
                return (
                  <li key={g.id} className={`py-3 text-sm ${g.status === 'cancelled' ? 'opacity-60' : ''}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{g.name}</span>
                      <Status
                        status={g.status}
                        position={g.waitlistRank}
                        expires={g.status === 'pending_email' ? (captain?.confirmBy ?? null) : g.offerExpiresAt}
                      />
                      {captain && (
                        <span className="text-black/70">
                          Captain {captain.player.firstName} {captain.player.lastName} · {captain.reference}
                        </span>
                      )}
                      <GroupActions
                        group={g}
                        onPick={(a) => {
                          if (a === 'cancel') setPending({ kind: 'cancel', group: g })
                          else if (a === 'rename') setPending({ kind: 'rename', group: g })
                          else
                            setPending({
                              kind: 'confirm',
                              title: GROUP_ACTION_LABELS[a],
                              text: GROUP_CONFIRM[a](g.name),
                              danger: a === 'delete',
                              run: () => groupAct(g, { action: a }, `${g.name}: done.`),
                            })
                        }}
                      />
                    </div>
                    {(players || members.length > 0) && (
                      <div className="mt-1 grid gap-1 text-black/70 sm:grid-cols-2">
                        {players && <p className="whitespace-pre-line">{players}</p>}
                        {members.length > 0 && <p>Placed: {members.map((m) => `${m.player.firstName} ${m.player.lastName}`).join(', ')}</p>}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {freeAgents.some((f) => !f.groupId) && (
            <p className="mt-3 text-sm">
              <strong>{freeAgents.filter((f) => !f.groupId).length}</strong> free agent(s) not in a team yet: use “Place in a team” on their
              row below.
            </p>
          )}
        </Card>
      )}

      <Card
        title={`Enrolments (${registrations.filter((r) => LIVE(r.status)).length})`}
        actions={
          <div className="flex flex-wrap gap-2">
            <a href={exportBase} className="text-brand rounded border border-brand px-3 py-1 text-xs font-semibold" download>
              Export CSV
            </a>
            <a
              href={`${exportBase}?status=all`}
              className="text-brand rounded border border-brand px-3 py-1 text-xs font-semibold"
              download
            >
              Export all (incl. cancelled)
            </a>
            <Button className="px-3 py-1 text-xs" onClick={() => setPending({ kind: 'add' })}>
              Add enrolment
            </Button>
          </div>
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-4">
          <label className="block sm:col-span-1">
            <span className="mb-1 block text-sm font-semibold">Search</span>
            <input
              type="search"
              className="w-full rounded border border-black/20 px-3 py-2"
              placeholder="Name, email, reference…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="live">Current (not cancelled)</option>
            <option value="">Everything</option>
            <option value="confirmed">Confirmed</option>
            <option value="offered">Offered</option>
            <option value="waitlist">Waitlist</option>
            <option value="pending_email">Awaiting email confirmation</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Lapsed (offers and unconfirmed emails)</option>
          </Select>
          <Select label="Payment" value={paid} onChange={(e) => setPaid(e.target.value)}>
            <option value="">Any</option>
            <option value="unpaid">Unpaid</option>
            <option value="paid">Paid</option>
          </Select>
          <Select label="Entry" value={entry} onChange={(e) => setEntry(e.target.value)}>
            <option value="">Any</option>
            {(teamsKind ? (['team', 'free_agent'] as const) : (['player'] as const)).map((t) => (
              <option key={t} value={t}>
                {t === 'team' ? 'Team captains' : ENTRY_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-black/60">{registrations.length === 0 ? 'No enrolments yet.' : 'Nobody matches those filters.'}</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-black/5 text-xs uppercase">
                <tr>
                  <th className="px-3 py-2">Ref</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Contact</th>
                  {teamsKind && <th className="px-3 py-2">Entry</th>}
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Paid</th>
                  <th className="px-3 py-2">Enrolled</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {shown.map((r) => (
                  <RegRow
                    key={r.id}
                    reg={r}
                    teamsKind={teamsKind}
                    expanded={open.has(r.id)}
                    onToggle={() => toggle(r.id)}
                    fieldsByKey={fieldsByKey}
                    onAction={(a) => {
                      if (a === 'mark_paid') setPending({ kind: 'paid', reg: r })
                      else if (a === 'cancel') setPending({ kind: 'cancel', reg: r })
                      else if (a === 'move') setPending({ kind: 'move', reg: r })
                      else if (a === 'place') setPending({ kind: 'place', reg: r })
                      else if (a === 'edit') setPending({ kind: 'edit', reg: r })
                      else
                        setPending({
                          kind: 'confirm',
                          title: REG_ACTION_LABELS[a],
                          text: REG_CONFIRM[a](`${r.player.firstName} ${r.player.lastName}`),
                          danger: a === 'delete',
                          run: () => regAct(r, { action: a }, `${r.player.firstName} ${r.player.lastName}: done.`),
                        })
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {pending?.kind === 'paid' && (
        <MarkPaidDialog
          reg={pending.reg}
          methods={detail.paymentMethods}
          onCancel={() => setPending(null)}
          onSave={(method, note) => regAct(pending.reg, { action: 'mark_paid', method, note }, `Marked ${pending.reg.reference} paid.`)}
        />
      )}
      {pending?.kind === 'cancel' && (
        <CancelDialog
          name={pending.group ? pending.group.name : `${pending.reg!.player.firstName} ${pending.reg!.player.lastName}`}
          onCancel={() => setPending(null)}
          onSave={(reason, notify) =>
            pending.group
              ? groupAct(pending.group, { action: 'cancel', reason, notify }, `Cancelled ${pending.group.name}.`)
              : regAct(pending.reg!, { action: 'cancel', reason, notify }, `Cancelled ${pending.reg!.reference}.`)
          }
        />
      )}
      {pending?.kind === 'move' && (
        <MoveDialog
          reg={pending.reg}
          targets={detail.moveTargets}
          onCancel={() => setPending(null)}
          onSave={(to, force) => regAct(pending.reg, { action: 'move', to, force }, `Moved ${pending.reg.reference}.`)}
        />
      )}
      {pending?.kind === 'place' && (
        <PlaceDialog
          reg={pending.reg}
          groups={liveGroups}
          onCancel={() => setPending(null)}
          onSave={(groupId) =>
            regAct(pending.reg, { action: 'place', groupId }, groupId ? 'Placed in the team.' : 'Taken out of the team.')
          }
        />
      )}
      {pending?.kind === 'edit' && (
        <EditDialog
          reg={pending.reg}
          onCancel={() => setPending(null)}
          onSave={(body) => regAct(pending.reg, { action: 'edit', ...body }, 'Details saved.')}
        />
      )}
      {pending?.kind === 'rename' && (
        <PromptDialog
          title="Rename team entry"
          label="Team name"
          initial={pending.group.name}
          onCancel={() => setPending(null)}
          onSave={(name) => groupAct(pending.group, { action: 'rename', name }, 'Renamed.')}
        />
      )}
      {pending?.kind === 'addTeam' && (
        <PromptDialog
          title="Add a team entry"
          label="Team name"
          hint="For placing free agents into. It's confirmed straight away, whatever the cap."
          initial=""
          onCancel={() => setPending(null)}
          onSave={async (name) => {
            await api(`/api/admin/enrolment/targets/${kind}/${id}/groups`, { body: { name } })
            setPending(null)
            setFlash(`Added ${name}.`)
            await load()
          }}
        />
      )}
      {pending?.kind === 'add' && (
        <AddDialog
          detail={detail}
          onCancel={() => setPending(null)}
          onSaved={async (msg) => {
            setPending(null)
            setFlash(msg)
            await load()
          }}
        />
      )}
      {pending?.kind === 'confirm' && <ConfirmDialog {...pending} onCancel={() => setPending(null)} />}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded border border-black/10 bg-white px-4 py-3 shadow-sm">
      <div className="text-xs font-semibold text-black/60 uppercase">{label}</div>
      <div className="mt-1 text-lg font-bold">{value}</div>
    </div>
  )
}

// ── Rows and their actions ────────────────────────────────────────────────────

const REG_ACTION_LABELS = {
  verify: 'Confirm their email (by hand)',
  resend_confirm: 'Resend the confirm-email link',
  mark_paid: 'Mark paid…',
  mark_unpaid: 'Mark unpaid',
  offer: 'Offer the spot (email)',
  confirm: 'Confirm now (over the cap if need be)',
  resend_offer: 'Resend the offer email',
  move: 'Move to…',
  place: 'Place in a team…',
  edit: 'Edit details…',
  cancel: 'Cancel…',
  reinstate: 'Reinstate',
  delete: 'Delete for good',
} as const
type RegAction = keyof typeof REG_ACTION_LABELS

const REG_CONFIRM: Record<RegAction, (name: string) => string> = {
  verify: (n) =>
    `Confirm ${n}'s email address for them (say they told you by phone)? Their entry then counts against the caps: a spot if there's room, otherwise the end of the waitlist. They'll get the usual email.`,
  resend_confirm: (n) => `Email ${n} the confirm link again? Their deadline restarts from now.`,
  mark_paid: () => '',
  mark_unpaid: (n) => `Mark ${n} as not paid? The payment note is cleared.`,
  offer: (n) => `Email ${n} an offer for a spot? It's held for them for the offer time, even if that takes the count over the cap.`,
  confirm: (n) => `Give ${n} a spot now, even if that takes the count over the cap? They'll get a confirmation email.`,
  resend_offer: (n) => `Send ${n} the offer email again? The expiry stays the same.`,
  move: () => '',
  place: () => '',
  edit: () => '',
  cancel: () => '',
  reinstate: (n) => `Reinstate ${n}? They get a spot if there's room, otherwise they go to the end of the waitlist.`,
  delete: (n) =>
    `Delete ${n}'s enrolment for good? Use this for mistakes and privacy requests; otherwise cancel instead. Their personal details are deleted too if they have no other enrolments. This can't be undone.`,
}

function regActions(r: RegistrationRow): RegAction[] {
  const a: RegAction[] = []
  if (r.entryType !== 'team') {
    if (r.status === 'pending_email') a.push('verify', 'resend_confirm', 'confirm')
    if (r.status === 'waitlist') a.push('offer', 'confirm')
    if (r.status === 'offered') a.push('resend_offer', 'confirm')
  }
  if (LIVE(r.status)) a.push(r.paidAt ? 'mark_unpaid' : 'mark_paid')
  if (r.entryType === 'free_agent' && LIVE(r.status)) a.push('place')
  if (r.entryType !== 'team' && LIVE(r.status) && r.status !== 'pending_email') a.push('move')
  a.push('edit')
  if (r.entryType !== 'team') a.push(LIVE(r.status) ? 'cancel' : 'reinstate')
  if (r.entryType !== 'team') a.push('delete')
  return a
}

function RegRow({
  reg: r,
  teamsKind,
  expanded,
  onToggle,
  onAction,
  fieldsByKey,
}: {
  reg: RegistrationRow
  teamsKind: boolean
  expanded: boolean
  onToggle: () => void
  onAction: (a: RegAction) => void
  fieldsByKey: Map<string, FormField>
}) {
  const p = r.player
  const actions = regActions(r)
  return (
    <>
      <tr className={LIVE(r.status) ? '' : 'text-black/60'}>
        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{r.reference}</td>
        <td className="px-3 py-2">
          <button type="button" className="text-brand text-left font-semibold underline" aria-expanded={expanded} onClick={onToggle}>
            {p.firstName} {p.lastName}
          </button>
          {p.birthYear && <span className="ml-1 text-xs text-black/60">b. {p.birthYear}</span>}
        </td>
        <td className="px-3 py-2">
          <a href={`mailto:${p.email}`} className="block break-all underline">
            {p.email}
          </a>
          {p.phone && (
            <a href={`tel:${p.phone.replace(/\s/g, '')}`} className="text-xs text-black/70">
              {p.phone}
            </a>
          )}
        </td>
        {teamsKind && (
          <td className="px-3 py-2">
            {r.entryType === 'team' ? `Captain, ${r.teamName}` : r.teamName ? `Free agent → ${r.teamName}` : 'Free agent'}
          </td>
        )}
        <td className="px-3 py-2">
          <Status status={r.status} position={r.waitlistRank} expires={r.status === 'pending_email' ? r.confirmBy : r.offerExpiresAt} />
        </td>
        <td className="px-3 py-2 text-xs">
          {r.paidAt ? (
            <span title={r.paidMarkedBy ? `Marked by ${r.paidMarkedBy}` : undefined}>
              <span className="font-bold text-green-800">Paid</span> {r.paymentNote ? `· ${r.paymentNote}` : ''}
            </span>
          ) : r.amountCents ? (
            <span>
              <span className="font-bold text-red-800">Unpaid</span> {formatAud(r.amountCents)}
            </span>
          ) : (
            <span className="text-black/60">No fee</span>
          )}
        </td>
        <td className="px-3 py-2 text-xs whitespace-nowrap">{formatWhen(r.createdAt)}</td>
        <td className="px-3 py-2">
          <select
            aria-label={`Actions for ${p.firstName} ${p.lastName}`}
            className="rounded border border-black/20 bg-white px-2 py-1 text-xs"
            value=""
            onChange={(e) => e.target.value && onAction(e.target.value as RegAction)}
          >
            <option value="">Actions…</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {REG_ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-black/[0.02]">
          <td colSpan={teamsKind ? 8 : 7} className="px-3 py-3">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {p.guardianName && (
                <Item label="Parent or guardian" value={`${p.guardianName} · ${p.guardianEmail ?? ''} · ${p.guardianPhone ?? ''}`} />
              )}
              {p.emergencyContact && <Item label="Emergency contact" value={p.emergencyContact} />}
              {r.vnswConfirmed && <Item label="Volleyball NSW" value="Has a membership" />}
              {Object.entries(r.answers).map(([k, v]) => {
                const f = fieldsByKey.get(k)
                if (f && (isDisplayOnly(f.type) || isMapped(f.type))) return null
                return <Item key={k} label={f ? `${f.label}${f.retired ? ' (retired question)' : ''}` : k} value={answerText(f, v)} />
              })}
              <Item label="Source" value={`${r.source}${r.formVersion ? `, form v${r.formVersion}` : ''}`} />
              {r.paymentNote && <Item label="Payment note" value={`${r.paymentNote}${r.paidMarkedBy ? ` (by ${r.paidMarkedBy})` : ''}`} />}
              {r.cancelReason && (
                <Item label="Cancelled" value={`${r.cancelReason}${r.cancelledAt ? `, ${formatWhen(r.cancelledAt)}` : ''}`} />
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  )
}

const Item = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-xs font-semibold text-black/60">{label}</dt>
    <dd className="whitespace-pre-line">{value || '–'}</dd>
  </div>
)

const GROUP_ACTION_LABELS = {
  verify: "Confirm the captain's email (by hand)",
  resend_confirm: 'Resend the confirm-email link',
  offer: 'Offer the spot (email the captain)',
  confirm: 'Confirm now',
  resend_offer: 'Resend the offer email',
  rename: 'Rename…',
  cancel: 'Cancel…',
  reinstate: 'Reinstate',
  delete: 'Delete for good',
} as const
type GroupActionName = keyof typeof GROUP_ACTION_LABELS

const GROUP_CONFIRM: Record<GroupActionName, (name: string) => string> = {
  verify: (n) =>
    `Confirm ${n}'s captain's email address for them? The entry then counts against the caps: a spot if there's room, otherwise the end of the waitlist.`,
  resend_confirm: (n) => `Email ${n}'s captain the confirm link again? Their deadline restarts from now.`,
  offer: (n) => `Email ${n}'s captain an offer for a spot?`,
  confirm: (n) => `Give ${n} a spot now, even if that takes the count over the cap?`,
  resend_offer: (n) => `Send ${n}'s captain the offer email again?`,
  rename: () => '',
  cancel: () => '',
  reinstate: (n) => `Reinstate ${n}? It gets a spot if there's room, otherwise it goes to the end of the waitlist.`,
  delete: (n) => `Delete ${n} and its captain's enrolment for good? This can't be undone.`,
}

function GroupActions({ group: g, onPick }: { group: GroupRow; onPick: (a: GroupActionName) => void }) {
  const list: GroupActionName[] = []
  if (g.status === 'pending_email') list.push('verify', 'resend_confirm', 'confirm')
  if (g.status === 'waitlist') list.push('offer', 'confirm')
  if (g.status === 'offered') list.push('resend_offer', 'confirm')
  list.push('rename')
  list.push(g.status === 'cancelled' ? 'reinstate' : 'cancel')
  list.push('delete')
  return (
    <select
      aria-label={`Actions for ${g.name}`}
      className="ml-auto rounded border border-black/20 bg-white px-2 py-1 text-xs"
      value=""
      onChange={(e) => e.target.value && onPick(e.target.value as GroupActionName)}
    >
      <option value="">Actions…</option>
      {list.map((a) => (
        <option key={a} value={a}>
          {GROUP_ACTION_LABELS[a]}
        </option>
      ))}
    </select>
  )
}

// ── Settings (the product row) ────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')
const yesNo = (b: boolean) => (b ? 'on' : 'off')
const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s))
const triState = (s: string) => (s === '' ? null : s === 'true')

const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "On", "Off" or "" (inherit) for a nullable boolean override. */
const triValue = (b: boolean | null | undefined) => (b === null || b === undefined ? '' : String(b))

function Settings({ detail, onSaved }: { detail: Detail; onSaved: (msg: string) => void }) {
  // A target with no product row yet (a season nobody has entered) shows the programme's defaults; saving creates it.
  const { product, programme } = detail
  const [openPanel, setOpenPanel] = useState(false)
  const [forms, setForms] = useState<FormsList['forms'] | null>(null)
  const [v, setV] = useState(() => ({
    capacity: product?.capacity == null ? '' : String(product.capacity),
    capacityTeams: product?.capacityTeams == null ? '' : String(product.capacityTeams),
    price: ((product ? product.priceCents : (programme.priceCents ?? 0)) / 100).toFixed(2),
    formId: product?.formId ?? '',
    waitlistEnabled: triValue(product?.waitlistEnabled),
    waitlistOfferHours: product?.waitlistOfferHours == null ? '' : String(product.waitlistOfferHours),
    allowTeamEntries: triValue(product?.allowTeamEntries),
    allowFreeAgents: triValue(product?.allowFreeAgents),
    emailConfirm: triValue(product?.emailConfirm),
    opensAt: toLocalInput(product?.opensAt ?? null),
    closesAt: toLocalInput(product?.closesAt ?? null),
    active: product?.active ?? true,
  }))
  const [initial] = useState(v)
  useUnsavedWarning(JSON.stringify(v) !== JSON.stringify(initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (openPanel && !forms)
      void api<FormsList>('/api/admin/forms').then(
        (r) => setForms(r.forms.filter((f) => !f.archivedAt)),
        () => setForms([]),
      )
  }, [openPanel, forms])
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const teamsKind = programme.kind === 'league' || programme.kind === 'event'
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const num = numOrNull
      const tri = triState
      const ref = detail.summary.ref
      const r = await api<{ offered: number; cache: string }>(`/api/admin/enrolment/targets/${ref.kind}/${ref.id}`, {
        method: 'PATCH',
        body: {
          baseUpdatedAt: product?.updatedAt ?? '',
          capacity: num(v.capacity),
          capacityTeams: teamsKind ? num(v.capacityTeams) : null,
          priceCents: Math.round(Number(v.price || '0') * 100),
          formId: v.formId || null,
          waitlistEnabled: tri(v.waitlistEnabled),
          waitlistOfferHours: num(v.waitlistOfferHours),
          allowTeamEntries: teamsKind ? tri(v.allowTeamEntries) : null,
          allowFreeAgents: teamsKind ? tri(v.allowFreeAgents) : null,
          emailConfirm: tri(v.emailConfirm),
          opensAt: v.opensAt ? new Date(v.opensAt).toISOString() : null,
          closesAt: v.closesAt ? new Date(v.closesAt).toISOString() : null,
          active: v.active,
        },
      })
      onSaved(`Settings saved.${r.offered ? ` ${r.offered} waitlist offer(s) sent for the new spots.` : ''}${purgeNote(r.cache)}`)
      setOpenPanel(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const eff = detail.effective
  return (
    <Card
      title="Settings for this one"
      actions={
        <Button variant="link" className="text-sm" onClick={() => setOpenPanel((o) => !o)} aria-expanded={openPanel}>
          {openPanel ? 'Close' : 'Change'}
        </Button>
      }
    >
      <p className="text-sm text-black/70">
        Player cap {eff.capPlayers ?? 'none'}
        {teamsKind ? ` · team cap ${eff.capTeams ?? 'none'}` : ''} · {eff.amountCents ? formatAud(eff.amountCents) : 'no fee'} · waitlist{' '}
        {yesNo(eff.waitlistEnabled)}, offers held {eff.offerHours}h · email confirmation {yesNo(eff.emailConfirm)} · form:{' '}
        {detail.form.name}
        {product && !product.active ? ' · not taking enrolments' : ''}
      </p>
      {openPanel && (
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <p className="text-sm text-black/60">Blank fields use {programme.name}'s defaults (shown in brackets).</p>
          {error && <Notice kind="error">{error}</Notice>}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="Player cap"
              type="number"
              min={0}
              value={v.capacity}
              onChange={set('capacity')}
              hint={`(${programme.capPlayers ?? 'no cap'})`}
            />
            {teamsKind && (
              <Field
                label="Team cap"
                type="number"
                min={0}
                value={v.capacityTeams}
                onChange={set('capacityTeams')}
                hint={`(${programme.capTeams ?? 'no cap'})`}
              />
            )}
            <Field
              label="Price per person ($)"
              type="number"
              min={0}
              step="0.01"
              value={v.price}
              onChange={set('price')}
              hint="0 = no fee"
            />
            <Select label="Waitlist when full" value={v.waitlistEnabled} onChange={set('waitlistEnabled')}>
              <option value="">({yesNo(programme.waitlistEnabled)})</option>
              <option value="true">On</option>
              <option value="false">Off: refuse when full</option>
            </Select>
            <Field
              label="Hold offers for (hours)"
              type="number"
              min={1}
              max={336}
              value={v.waitlistOfferHours}
              onChange={set('waitlistOfferHours')}
              hint={`(${programme.waitlistOfferHours})`}
            />
            <Select
              label="Confirm email before holding a spot"
              value={v.emailConfirm}
              onChange={set('emailConfirm')}
              hint="Public entries wait for the person to click an emailed link; until then they hold no spot."
            >
              <option value="">
                ({programme.enrolmentEmailConfirm === null ? 'automatic: on when capped' : yesNo(programme.enrolmentEmailConfirm)})
              </option>
              <option value="true">On</option>
              <option value="false">Off: hold the spot straight away</option>
            </Select>
            <Select label="Form" value={v.formId} onChange={set('formId')}>
              <option value="">(the programme's)</option>
              {forms?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
            {teamsKind && (
              <>
                <Select label="Team entries" value={v.allowTeamEntries} onChange={set('allowTeamEntries')}>
                  <option value="">({yesNo(programme.allowTeamEntries)})</option>
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </Select>
                <Select label="Free agents" value={v.allowFreeAgents} onChange={set('allowFreeAgents')}>
                  <option value="">({yesNo(programme.allowFreeAgents)})</option>
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </Select>
              </>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field
              label="Opens (optional)"
              type="datetime-local"
              value={v.opensAt}
              onChange={set('opensAt')}
              hint="Can only narrow the programme's dates."
            />
            <Field label="Closes (optional)" type="datetime-local" value={v.closesAt} onChange={set('closesAt')} />
            <label className="flex items-center gap-2 self-center text-sm">
              <input type="checkbox" checked={v.active} onChange={(e) => setV((s) => ({ ...s, active: e.target.checked }))} />
              Taking enrolments
            </label>
          </div>
          <div className="flex justify-end">
            <Button type="submit" busy={busy}>
              Save settings
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}

// ── Dialogs ───────────────────────────────────────────────────────────────────

function useSubmit(fn: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function Actions({ onCancel, busy, label, danger }: { onCancel: () => void; busy: boolean; label: string; danger?: boolean }) {
  return (
    <div className="flex justify-end gap-2">
      <Button variant="secondary" onClick={onCancel}>
        Back
      </Button>
      <Button type="submit" variant={danger ? 'danger' : 'primary'} busy={busy}>
        {label}
      </Button>
    </div>
  )
}

function ConfirmDialog({
  title,
  text,
  run,
  danger,
  onCancel,
}: {
  title: string
  text: string
  run: () => Promise<unknown>
  danger?: boolean
  onCancel: () => void
}) {
  const s = useSubmit(run)
  return (
    <Dialog title={title} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void s.run()
        }}
      >
        {s.error && <Notice kind="error">{s.error}</Notice>}
        <p className="text-sm">{text}</p>
        <Actions onCancel={onCancel} busy={s.busy} label={title.replace('…', '')} danger={danger} />
      </form>
    </Dialog>
  )
}

function MarkPaidDialog({
  reg,
  methods,
  onCancel,
  onSave,
}: {
  reg: RegistrationRow
  methods: Record<string, string>
  onCancel: () => void
  onSave: (method: string, note: string) => Promise<unknown>
}) {
  const [method, setMethod] = useState('payid')
  const [note, setNote] = useState('')
  const s = useSubmit(() => onSave(method, note))
  return (
    <Dialog title={`Mark ${reg.reference} paid`} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void s.run()
        }}
      >
        {s.error && <Notice kind="error">{s.error}</Notice>}
        <p className="text-sm">
          {reg.player.firstName} {reg.player.lastName}
          {reg.amountCents ? ` owes ${formatAud(reg.amountCents)}` : ''}.
        </p>
        <Select label="How they paid" value={method} onChange={(e) => setMethod(e.target.value)}>
          {Object.entries(methods).map(([k, label]) => (
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
        <Actions onCancel={onCancel} busy={s.busy} label="Mark paid" />
      </form>
    </Dialog>
  )
}

function CancelDialog({
  name,
  onCancel,
  onSave,
}: {
  name: string
  onCancel: () => void
  onSave: (reason: string, notify: boolean) => Promise<unknown>
}) {
  const [reason, setReason] = useState('')
  const [notify, setNotify] = useState(true)
  const s = useSubmit(() => onSave(reason, notify))
  return (
    <Dialog title={`Cancel ${name}`} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void s.run()
        }}
      >
        {s.error && <Notice kind="error">{s.error}</Notice>}
        <Field
          label="Reason (optional)"
          value={reason}
          maxLength={300}
          onChange={(e) => setReason(e.target.value)}
          hint="Included in the email if you send one."
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          Email them that it's cancelled
        </label>
        <p className="text-sm text-black/60">If this frees a spot, the first on the waitlist is offered it straight away.</p>
        <Actions onCancel={onCancel} busy={s.busy} label="Cancel enrolment" danger />
      </form>
    </Dialog>
  )
}

function MoveDialog({
  reg,
  targets,
  onCancel,
  onSave,
}: {
  reg: RegistrationRow
  targets: TargetDetail['moveTargets']
  onCancel: () => void
  onSave: (to: { kind: TargetKind; id: string }, force: boolean) => Promise<unknown>
}) {
  const [to, setTo] = useState(targets[0] ? `${targets[0].ref.kind}:${targets[0].ref.id}` : '')
  const [force, setForce] = useState(false)
  const s = useSubmit(async () => {
    const [kind, id] = to.split(':') as [TargetKind, string]
    await onSave({ kind, id }, force)
  })
  return (
    <Dialog title={`Move ${reg.player.firstName} ${reg.player.lastName}`} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void s.run()
        }}
      >
        {s.error && <Notice kind="error">{s.error}</Notice>}
        {targets.length === 0 ? (
          <p className="text-sm">There's nothing else in this programme to move to.</p>
        ) : (
          <>
            <Select label="Move to" value={to} onChange={(e) => setTo(e.target.value)}>
              {targets.map((t) => (
                <option key={t.ref.id} value={`${t.ref.kind}:${t.ref.id}`}>
                  {t.label}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              Give them a spot there even if it's full
            </label>
            <p className="text-sm text-black/60">
              Otherwise they join the end of its waitlist when it's full. Their spot here is offered to this waitlist.
            </p>
          </>
        )}
        <Actions onCancel={onCancel} busy={s.busy} label="Move" />
      </form>
    </Dialog>
  )
}

function PlaceDialog({
  reg,
  groups,
  onCancel,
  onSave,
}: {
  reg: RegistrationRow
  groups: GroupRow[]
  onCancel: () => void
  onSave: (groupId: string | null) => Promise<unknown>
}) {
  const [groupId, setGroupId] = useState(reg.groupId ?? groups[0]?.id ?? '')
  const s = useSubmit(() => onSave(groupId || null))
  return (
    <Dialog title={`Place ${reg.player.firstName} ${reg.player.lastName}`} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void s.run()
        }}
      >
        {s.error && <Notice kind="error">{s.error}</Notice>}
        <Select
          label="Team"
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
          hint="Add a team entry first if the team isn't listed."
        >
          <option value="">Not in a team</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </Select>
        <Actions onCancel={onCancel} busy={s.busy} label="Save" />
      </form>
    </Dialog>
  )
}

function EditDialog({
  reg,
  onCancel,
  onSave,
}: {
  reg: RegistrationRow
  onCancel: () => void
  onSave: (body: Record<string, unknown>) => Promise<unknown>
}) {
  const p = reg.player
  const [v, setV] = useState({
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    phone: p.phone ?? '',
    birthYear: p.birthYear ? String(p.birthYear) : '',
    guardianName: p.guardianName ?? '',
    guardianEmail: p.guardianEmail ?? '',
    guardianPhone: p.guardianPhone ?? '',
    emergencyContact: p.emergencyContact ?? '',
  })
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))
  const junior = !!(p.birthYear || p.guardianName)
  const s = useSubmit(() =>
    onSave({
      person: { firstName: v.firstName, lastName: v.lastName, email: v.email, phone: v.phone },
      emergencyContact: v.emergencyContact,
      ...(junior || v.birthYear ? { birthYear: v.birthYear || null } : {}),
      ...(junior || v.guardianName ? { guardian: { name: v.guardianName, email: v.guardianEmail, phone: v.guardianPhone } } : {}),
    }),
  )
  return (
    <Dialog title={`Edit ${p.firstName} ${p.lastName}`} onCancel={onCancel}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void s.run()
        }}
      >
        {s.error && <Notice kind="error">{s.error}</Notice>}
        <p className="text-sm text-black/60">These are the person's details, so they change on all of their enrolments.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" value={v.firstName} onChange={set('firstName')} required />
          <Field label="Last name" value={v.lastName} onChange={set('lastName')} required />
          <Field label="Email" type="email" value={v.email} onChange={set('email')} required />
          <Field label="Phone" type="tel" value={v.phone} onChange={set('phone')} />
          <Field label="Year of birth" type="number" value={v.birthYear} onChange={set('birthYear')} />
          <Field label="Emergency contact" value={v.emergencyContact} onChange={set('emergencyContact')} />
          <Field label="Guardian name" value={v.guardianName} onChange={set('guardianName')} />
          <Field label="Guardian email" type="email" value={v.guardianEmail} onChange={set('guardianEmail')} />
          <Field label="Guardian phone" type="tel" value={v.guardianPhone} onChange={set('guardianPhone')} />
        </div>
        <Actions onCancel={onCancel} busy={s.busy} label="Save" />
      </form>
    </Dialog>
  )
}

function PromptDialog({
  title,
  label,
  hint,
  initial,
  onCancel,
  onSave,
}: {
  title: string
  label: string
  hint?: string
  initial: string
  onCancel: () => void
  onSave: (value: string) => Promise<unknown>
}) {
  const [value, setValue] = useState(initial)
  const s = useSubmit(() => onSave(value))
  return (
    <Dialog title={title} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void s.run()
        }}
      >
        {s.error && <Notice kind="error">{s.error}</Notice>}
        <Field label={label} value={value} maxLength={80} onChange={(e) => setValue(e.target.value)} hint={hint} required />
        <Actions onCancel={onCancel} busy={s.busy} label="Save" />
      </form>
    </Dialog>
  )
}

/** Adds an enrolment by hand: the person, the entry type, any answers (all optional), and where it lands. */
function AddDialog({ detail, onCancel, onSaved }: { detail: Detail; onCancel: () => void; onSaved: (msg: string) => Promise<void> }) {
  const teamsKind = detail.summary.programme.kind === 'league' || detail.summary.programme.kind === 'event'
  const [entryType, setEntryType] = useState(teamsKind ? 'free_agent' : 'player')
  const [person, setPerson] = useState({ firstName: '', lastName: '', email: '', phone: '' })
  const [teamName, setTeamName] = useState('')
  const [notes, setNotes] = useState('')
  const [status, setStatus] = useState('auto')
  const [notify, setNotify] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const hasNotes = detail.form.fields.some((f) => f.key === 'notes' && !f.retired)
  const s = useSubmit(async () => {
    try {
      const r = await api<{ reference: string; status: string }>(
        `/api/admin/enrolment/targets/${detail.summary.ref.kind}/${detail.summary.ref.id}/registrations`,
        {
          body: {
            entryType,
            person,
            answers: { ...(entryType === 'team' ? { team_name: teamName } : {}), ...(hasNotes && notes ? { notes } : {}) },
            status: status === 'auto' ? undefined : status,
            notify,
          },
        },
      )
      await onSaved(`Added ${person.firstName} ${person.lastName} (${r.reference}, ${r.status}).`)
    } catch (e) {
      const fe = (e as { details?: { fieldErrors?: Record<string, string> } }).details?.fieldErrors
      if (fe) setFieldErrors(fe)
      throw e
    }
  })
  const setP = (k: keyof typeof person) => (e: { target: { value: string } }) => setPerson((p) => ({ ...p, [k]: e.target.value }))
  return (
    <Dialog title="Add an enrolment" onCancel={onCancel}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          void s.run()
        }}
      >
        {s.error && <Notice kind="error">{s.error}</Notice>}
        <p className="text-sm text-black/60">For people who enrol by phone or in person. Required questions can be left blank.</p>
        {teamsKind && (
          <Select label="Entry" value={entryType} onChange={(e) => setEntryType(e.target.value)}>
            <option value="free_agent">Individual (free agent)</option>
            <option value="team">Team entry (this person is the captain)</option>
          </Select>
        )}
        {entryType === 'team' && (
          <Field label="Team name" value={teamName} onChange={(e) => setTeamName(e.target.value)} required hint={fieldErrors.team_name} />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" value={person.firstName} onChange={setP('firstName')} required hint={fieldErrors.firstName} />
          <Field label="Last name" value={person.lastName} onChange={setP('lastName')} required hint={fieldErrors.lastName} />
          <Field label="Email" type="email" value={person.email} onChange={setP('email')} required hint={fieldErrors.email} />
          <Field label="Phone" type="tel" value={person.phone} onChange={setP('phone')} hint={fieldErrors.phone} />
        </div>
        {hasNotes && <TextArea label="Notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}
        <Select label="Where it lands" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="auto">A spot if there's room, else the waitlist</option>
          <option value="confirmed">A spot, even over the cap</option>
          <option value="waitlist">The end of the waitlist</option>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
          Email them a confirmation
        </label>
        <Actions onCancel={onCancel} busy={s.busy} label="Add" />
      </form>
    </Dialog>
  )
}
