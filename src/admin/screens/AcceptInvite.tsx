import { useEffect, useState, type FormEvent } from 'react'
import { roleLabel, type UserRole } from '../../lib/roles'
import { api, formatWhen } from '../api'
import { Button, Card, Field, Notice, errorMessage } from '../ui'

// /admin/invite#<token>: the link from an invite email. The token is in the fragment, so it never reaches the
// server's logs; we POST it to look the invite up and to accept it.

type Invite = { email: string; role: UserRole; expiresAt: string }

export function AcceptInvite() {
  const [token] = useState(() => window.location.hash.slice(1))
  const [invite, setInvite] = useState<Invite | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(token ? null : 'This invite link is incomplete. Open the link from your email again.')

  useEffect(() => {
    if (!token) return
    api<Invite>('/api/invites/lookup', { body: { token } })
      .then(setInvite)
      .catch((e) => setError(errorMessage(e)))
  }, [token])

  const accept = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await api<{ email: string }>('/api/invites/accept', { body: { token, name } })
      window.location.assign(`/admin/sign-in?email=${encodeURIComponent(res.email)}`)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-md py-8">
      <Card title="Join the Tempe Volleyball admin">
        <div className="space-y-4">
          {error && <Notice kind="error">{error}</Notice>}
          {invite && (
            <form className="space-y-4" onSubmit={accept}>
              <p className="text-sm">
                You've been invited as <b>{roleLabel[invite.role]}</b> with the email <b>{invite.email}</b>. The invite is valid until{' '}
                {formatWhen(invite.expiresAt)}.
              </p>
              <Field
                label="Your name"
                autoComplete="name"
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button type="submit" busy={busy}>
                Accept invite
              </Button>
              <p className="text-xs text-black/60">Next you'll sign in with a code we email to {invite.email}. There's no password.</p>
            </form>
          )}
          {!invite && !error && <p className="text-sm text-black/60">Checking your invite…</p>}
          {error && (
            <a className="text-brand text-sm underline" href="/admin/sign-in">
              Go to sign-in
            </a>
          )}
        </div>
      </Card>
    </div>
  )
}
