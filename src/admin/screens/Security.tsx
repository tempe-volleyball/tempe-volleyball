import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { renderSVG } from 'uqr'
import { useSearch } from 'wouter'
import { api, type Me } from '../api'
import { authClient } from '../auth-client'
import { Button, Card, Field, Notice, errorMessage } from '../ui'

// TOTP enrolment and backup codes. Owners must enrol before they can use anything else (the server enforces this
// too, in src/server/auth/guard.ts); everyone else can opt in.

type Enrolment = { totpURI: string; backupCodes: string[] }

/** "Trust this device" on sign-in, and forgetting every trusted device at once. */
function TrustedDevices() {
  const [state, setState] = useState<{ days: number; count: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  useEffect(() => {
    api<{ days: number; count: number }>('/api/admin/me/trusted-devices')
      .then(setState)
      .catch((e) => setMessage({ kind: 'error', text: errorMessage(e) }))
  }, [])
  const days = state?.days ?? 0
  const count = state?.count ?? 0
  const setCount = (n: number) => setState((s) => (s ? { ...s, count: n } : s))

  const forget = async () => {
    if (
      !window.confirm(
        'Forget every trusted device? Each will ask for your authenticator code at its next sign-in. You stay signed in here.',
      )
    )
      return
    setBusy(true)
    setMessage(null)
    try {
      const r = await api<{ revoked: number }>('/api/admin/me/trusted-devices', { method: 'DELETE' })
      setCount(0)
      setMessage({ kind: 'success', text: r.revoked === 1 ? 'Forgot 1 device.' : `Forgot ${r.revoked} devices.` })
    } catch (e) {
      setMessage({ kind: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Trusted devices">
      <div className="space-y-3 text-sm">
        {!state ? (
          <p className="text-black/60">Loading…</p>
        ) : days > 0 ? (
          <p>
            When you sign in you can tick “Trust this device for {days} days”, and that browser won't ask for your authenticator code until
            then.{' '}
            {count === 0 ? 'No devices are trusted now.' : count === 1 ? '1 device is trusted now.' : `${count} devices are trusted now.`}
          </p>
        ) : (
          <p>Trusted devices are turned off (Settings → Sign-in security), so every sign-in asks for your authenticator code.</p>
        )}
        <p className="text-xs text-black/60">
          Trusted devices are also forgotten when you set up your authenticator again or turn it off, and when your role changes.
        </p>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
        <Button variant="secondary" onClick={() => void forget()} busy={busy} disabled={count === 0 && days > 0}>
          Forget all trusted devices
        </Button>
      </div>
    </Card>
  )
}

function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-2">
      <p className="text-sm">
        Save these backup codes somewhere safe, such as a password manager. Each one signs you in once if you lose your phone.
      </p>
      <ul className="grid grid-cols-2 gap-1 rounded bg-black/5 p-3 font-mono text-sm sm:grid-cols-5">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <Button
        variant="secondary"
        onClick={() => {
          void navigator.clipboard.writeText(codes.join('\n')).then(() => setCopied(true))
        }}
      >
        {copied ? 'Copied' : 'Copy codes'}
      </Button>
    </div>
  )
}

export function Security({ me }: { me: Me }) {
  const required = new URLSearchParams(useSearch()).has('required') || me.totpRequired
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null)
  const [newCodes, setNewCodes] = useState<string[] | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const enabled = me.user.twoFactorEnabled

  const qr = useMemo(() => (enrolment ? renderSVG(enrolment.totpURI, { border: 1 }) : ''), [enrolment])
  const secret = enrolment ? (new URL(enrolment.totpURI).searchParams.get('secret') ?? '') : ''

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const start = () =>
    run(async () => {
      const { data, error } = await authClient.twoFactor.enable({})
      if (error || !data || !('totpURI' in data)) return setError(error?.message ?? "Couldn't start setup.")
      setEnrolment({ totpURI: data.totpURI, backupCodes: data.backupCodes })
    })

  const confirm = (e: FormEvent) => {
    e.preventDefault()
    return run(async () => {
      const { error } = await authClient.twoFactor.verifyTotp({ code: code.trim() })
      if (error) return setError("That code isn't right. Check the app shows Tempe Volleyball and try the current code.")
      // Full reload: the server re-reads the session, which now has TOTP enabled.
      window.location.assign('/admin/security?enabled=1')
    })
  }

  const regenerate = () =>
    run(async () => {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({})
      if (error || !data) return setError(error?.message ?? "Couldn't make new codes. Sign out and in again, then retry.")
      setNewCodes(data.backupCodes)
    })

  const disable = () =>
    run(async () => {
      if (!window.confirm('Turn off two-factor sign-in? You will sign in with just an email code.')) return
      const { error } = await authClient.twoFactor.disable({})
      if (error) return setError(error.message ?? "Couldn't turn it off. Sign out and in again, then retry.")
      window.location.assign('/admin/security')
    })

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Security</h1>
      {error && <Notice kind="error">{error}</Notice>}
      {new URLSearchParams(useSearch()).has('enabled') && enabled && (
        <Notice kind="success">Two-factor sign-in is on. You're all set.</Notice>
      )}

      {enabled ? (
        <Card title="Two-factor sign-in is on">
          <div className="space-y-4">
            <p className="text-sm">After your email code or link, you'll be asked for a code from your authenticator app.</p>
            {newCodes ? (
              <BackupCodes codes={newCodes} />
            ) : (
              <div className="flex flex-wrap gap-3">
                <Button variant="secondary" onClick={regenerate} busy={busy}>
                  Make new backup codes
                </Button>
                {me.user.role !== 'owner' && (
                  <Button variant="danger" onClick={disable} disabled={busy}>
                    Turn off
                  </Button>
                )}
              </div>
            )}
            {me.user.role === 'owner' && <p className="text-xs text-black/60">Owners can't turn two-factor sign-in off.</p>}
          </div>
        </Card>
      ) : null}
      {enabled && <TrustedDevices />}
      {enabled ? null : (
        <Card title="Set up two-factor sign-in">
          <div className="space-y-4">
            {required && (
              <Notice kind="warning">As an owner you need an authenticator app set up before you can use the rest of the admin.</Notice>
            )}
            {!enrolment ? (
              <>
                <p className="text-sm">
                  You'll need an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator, 1Password or Authy.
                </p>
                <Button onClick={start} busy={busy}>
                  Set up authenticator
                </Button>
              </>
            ) : (
              <form className="space-y-5" onSubmit={confirm}>
                <ol className="list-decimal space-y-4 pl-5 text-sm">
                  <li>
                    <p>Scan this QR code with your authenticator app.</p>
                    <div
                      className="mt-2 w-48 bg-white p-2"
                      aria-label="QR code for your authenticator app"
                      dangerouslySetInnerHTML={{ __html: qr }}
                    />
                    <p className="mt-2 text-xs text-black/60">
                      Can't scan it? Enter this key instead: <code className="break-all font-mono">{secret}</code>
                    </p>
                  </li>
                  <li>
                    <BackupCodes codes={enrolment.backupCodes} />
                  </li>
                  <li>
                    <p className="mb-2">Enter the 6-digit code the app shows now.</p>
                    <Field
                      label="Code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      required
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </li>
                </ol>
                <Button type="submit" busy={busy}>
                  Turn on
                </Button>
              </form>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}
