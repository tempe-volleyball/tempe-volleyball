import { useState, type FormEvent } from 'react'
import { useSearch } from 'wouter'
import { safeNext } from '../../server/auth/guard'
import { authClient } from '../auth-client'
import { Button, Card, Field, Notice } from '../ui'

// Sign in: email -> a 6-digit code (or a one-time link) -> a TOTP code if the user has an authenticator set up.
// After signing in we do a full page load, so the server re-checks the session (and owner TOTP enrolment).

type Step = 'email' | 'code' | 'link-sent' | 'totp'

const LINK_ERRORS: Record<string, string> = {
  INVALID_TOKEN: 'That sign-in link has expired or was already used. Ask for a new one.',
  EXPIRED_TOKEN: 'That sign-in link has expired. Ask for a new one.',
  new_user_signup_disabled: "There's no admin account for that address.",
}

export function SignIn() {
  const params = new URLSearchParams(useSearch())
  const next = safeNext(params.get('next'))
  const linkError = params.get('error')
  const [step, setStep] = useState<Step>(params.get('step') === 'totp' ? 'totp' : 'email')
  const [email, setEmail] = useState(params.get('email') ?? '')
  const [code, setCode] = useState('')
  const [useBackup, setUseBackup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(
    linkError ? (LINK_ERRORS[linkError] ?? 'That sign-in link did not work. Try again.') : null,
  )

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const sendCode = (e?: FormEvent) => {
    e?.preventDefault()
    return run(async () => {
      const { error } = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: 'sign-in' })
      if (error) return setError(error.message ?? "Couldn't send the code.")
      setCode('')
      setStep('code')
    })
  }

  const sendLink = () =>
    run(async () => {
      if (!email.trim()) return setError('Enter your email first.')
      const { error } = await authClient.signIn.magicLink({ email: email.trim(), callbackURL: next, errorCallbackURL: '/admin/sign-in' })
      if (error) return setError(error.message ?? "Couldn't send the link.")
      setStep('link-sent')
    })

  const verifyCode = (e: FormEvent) => {
    e.preventDefault()
    return run(async () => {
      const { data, error } = await authClient.signIn.emailOtp({ email: email.trim(), otp: code.trim() })
      if (error) return setError(error.status === 400 ? "That code isn't right, or it has expired." : (error.message ?? 'Sign-in failed.'))
      setCode('')
      if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) return setStep('totp')
      window.location.assign(next)
    })
  }

  const verifyTotp = (e: FormEvent) => {
    e.preventDefault()
    return run(async () => {
      const value = code.trim().replaceAll(' ', '')
      const { error } = useBackup
        ? await authClient.twoFactor.verifyBackupCode({ code: value })
        : await authClient.twoFactor.verifyTotp({ code: value })
      if (error) {
        if (error.status === 401 && /cookie|session/i.test(error.message ?? '')) {
          setStep('email')
          return setError('That sign-in took too long. Start again.')
        }
        return setError(
          useBackup
            ? "That backup code isn't right, or was already used."
            : "That code isn't right. Check your authenticator app's clock and try again.",
        )
      }
      window.location.assign(next)
    })
  }

  return (
    <div className="mx-auto max-w-md py-8">
      <Card title="Sign in to the admin">
        <div className="space-y-4">
          {error && <Notice kind="error">{error}</Notice>}

          {step === 'email' && (
            <form className="space-y-4" onSubmit={sendCode}>
              <Field
                label="Email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" busy={busy}>
                  Email me a code
                </Button>
                <Button variant="link" onClick={sendLink} disabled={busy}>
                  Send me a sign-in link instead
                </Button>
              </div>
              <p className="text-xs text-black/60">Only people invited to the admin can sign in. There are no passwords.</p>
            </form>
          )}

          {step === 'code' && (
            <form className="space-y-4" onSubmit={verifyCode}>
              <p className="text-sm">
                If that address has an admin account, a code is on its way to <b>{email}</b>. It expires in 5 minutes. If nothing arrives,
                check the address and your spam folder before asking for another.
              </p>
              <Field
                label="Code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" busy={busy}>
                  Sign in
                </Button>
                <Button variant="link" onClick={() => void sendCode()} disabled={busy}>
                  Send a new code
                </Button>
                <Button variant="link" onClick={() => setStep('email')} disabled={busy}>
                  Use a different email
                </Button>
              </div>
            </form>
          )}

          {step === 'link-sent' && (
            <div className="space-y-4">
              <Notice kind="success">
                If that address has an admin account, a sign-in link is on its way to <b>{email}</b>. It works once and expires in 5
                minutes.
              </Notice>
              <Button variant="link" onClick={() => setStep('email')}>
                Back
              </Button>
            </div>
          )}

          {step === 'totp' && (
            <form className="space-y-4" onSubmit={verifyTotp}>
              <p className="text-sm">
                {useBackup ? 'Enter one of your backup codes. Each works once.' : 'Enter the 6-digit code from your authenticator app.'}
              </p>
              <Field
                label={useBackup ? 'Backup code' : 'Authenticator code'}
                inputMode={useBackup ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" busy={busy}>
                  Verify
                </Button>
                <Button
                  variant="link"
                  onClick={() => {
                    setUseBackup(!useBackup)
                    setCode('')
                  }}
                >
                  {useBackup ? 'Use my authenticator app' : 'Use a backup code'}
                </Button>
              </div>
            </form>
          )}
        </div>
      </Card>
    </div>
  )
}
