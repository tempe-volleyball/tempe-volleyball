import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { canAssign, canRemove, roleLabel, type UserRole } from '../../lib/roles'
import { api, formatWhen, type AdminUserRow, type InviteRow, type Me } from '../api'
import { Button, Card, Field, Notice, RoleBadge, errorMessage } from '../ui'

// Admin users: list, invite, change role, remove, revoke invites. The server (src/server/auth/roles.ts) enforces
// every rule; the same rules from src/lib/roles.ts only decide which controls to show.

type Data = { users: AdminUserRow[]; invites: InviteRow[] }
type InviteResult = { email: string; role: UserRole; url: string; emailStatus: string; expiresAt: string }

const EMAIL_STATUS: Record<string, string> = {
  sent: 'We emailed them the link.',
  logged: 'Email is not set up here, so the email was written to the server log instead.',
  queued: "Today's email limit is reached, so the email will go out within the hour.",
  failed: "The email couldn't be sent.",
  not_configured: 'Email is not set up yet, so no email was sent.',
}

function InviteForm({ me, onDone }: { me: Me; onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<UserRole>(me.assignableRoles.includes('editor') ? 'editor' : me.assignableRoles[0]!)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<InviteResult | null>(null)
  const [copied, setCopied] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api<InviteResult>('/api/admin/invites', { body: { email, role } })
      setResult(res)
      setCopied(false)
      setEmail('')
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Invite someone">
      <form className="space-y-4" onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Field label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <label className="block">
            <span className="mb-1 block text-sm font-semibold">Role</span>
            <select
              className="w-full rounded border border-black/20 bg-white px-3 py-2"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
            >
              {me.assignableRoles.map((r) => (
                <option key={r} value={r}>
                  {roleLabel[r]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-black/60">
          Editors manage content and results. Admins also manage seasons, products, payments and editors. Owners manage everything,
          including other owners. Invites expire after 7 days.
        </p>
        <Button type="submit" busy={busy}>
          Send invite
        </Button>
      </form>
      {result && (
        <div className="mt-4 space-y-2">
          <Notice kind={result.emailStatus === 'sent' ? 'success' : 'warning'}>
            Invited {result.email} as {roleLabel[result.role]}. {EMAIL_STATUS[result.emailStatus] ?? ''} You can also send them this link
            yourself; it works once, until {formatWhen(result.expiresAt)}.
          </Notice>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-black/5 px-2 py-1 text-xs">{result.url}</code>
            <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(result.url).then(() => setCopied(true))}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function UserRow({ me, row, ownerCount, onChange }: { me: Me; row: AdminUserRow; ownerCount: number; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actor = me.user.role
  const isLastOwner = row.role === 'owner' && ownerCount <= 1
  const options = (['owner', 'admin', 'editor'] as const).filter((r) => r === row.role || canAssign(actor, row.role, r))
  const editable = options.length > 1 && !isLastOwner
  const removable = canRemove(actor, row.role) && !isLastOwner

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onChange()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const changeRole = (role: UserRole) => {
    const self = row.id === me.user.id
    if (self && !window.confirm(`Change your own role to ${roleLabel[role]}? You may lose access to this page.`)) return
    void act(async () => {
      await api(`/api/admin/users/${row.id}`, { method: 'PATCH', body: { role } })
      if (self) window.location.assign('/admin')
    })
  }

  const remove = () => {
    if (!window.confirm(`Remove ${row.email} from the admin? They will be signed out.`)) return
    void act(async () => {
      await api(`/api/admin/users/${row.id}`, { method: 'DELETE' })
      if (row.id === me.user.id) window.location.assign('/admin/sign-in')
    })
  }

  return (
    <tr className="border-t border-black/10 align-top">
      <td className="py-2 pr-3">
        <div className="font-semibold">
          {row.name}
          {row.id === me.user.id && <span className="ml-1 text-xs font-normal text-black/60">(you)</span>}
        </div>
        <div className="text-xs break-all text-black/70">{row.email}</div>
        {error && <div className="mt-1 text-xs text-red-700">{error}</div>}
      </td>
      <td className="py-2 pr-3">
        {editable ? (
          <select
            aria-label={`Role for ${row.email}`}
            className="rounded border border-black/20 bg-white px-2 py-1 text-sm"
            value={row.role}
            disabled={busy}
            onChange={(e) => changeRole(e.target.value as UserRole)}
          >
            {options.map((r) => (
              <option key={r} value={r}>
                {roleLabel[r]}
              </option>
            ))}
          </select>
        ) : (
          <RoleBadge role={row.role} />
        )}
      </td>
      <td className="py-2 pr-3 text-sm">{row.twoFactorEnabled ? 'On' : <span className="text-black/50">Off</span>}</td>
      <td className="py-2 text-right">
        {removable && (
          <Button variant="danger" className="px-2 py-1 text-xs" onClick={remove} busy={busy}>
            Remove
          </Button>
        )}
      </td>
    </tr>
  )
}

export function Users({ me }: { me: Me }) {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api<Data>('/api/admin/users')
      .then(setData)
      .catch((e) => setError(errorMessage(e)))
  }, [])
  useEffect(load, [load])

  const revoke = async (invite: InviteRow) => {
    if (!window.confirm(`Cancel the invite for ${invite.email}?`)) return
    try {
      await api(`/api/admin/invites/${invite.id}`, { method: 'DELETE' })
      load()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  if (!me.canManageUsers) return <Notice kind="error">Only admins and owners can manage admin users.</Notice>
  const ownerCount = data?.users.filter((u) => u.role === 'owner').length ?? 0

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Admin users</h1>
      {error && <Notice kind="error">{error}</Notice>}
      <Card title="People">
        {!data ? (
          <p className="text-sm text-black/60">Loading…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-black/60 uppercase">
                  <th className="pb-2 font-semibold">Person</th>
                  <th className="pb-2 font-semibold">Role</th>
                  <th className="pb-2 font-semibold">2FA</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {data.users.map((u) => (
                  <UserRow key={u.id} me={me} row={u} ownerCount={ownerCount} onChange={load} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data && data.invites.length > 0 && (
        <Card title="Pending invites">
          <ul className="divide-y divide-black/10">
            {data.invites.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 break-all">
                  {i.email} <RoleBadge role={i.role} /> <span className="text-xs text-black/60">expires {formatWhen(i.expiresAt)}</span>
                </span>
                {canAssign(me.user.role, null, i.role) && (
                  <Button variant="danger" className="px-2 py-1 text-xs" onClick={() => void revoke(i)}>
                    Cancel invite
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {me.assignableRoles.length > 0 && <InviteForm me={me} onDone={load} />}
    </div>
  )
}
