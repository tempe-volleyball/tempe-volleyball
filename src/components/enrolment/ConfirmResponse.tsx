import { Fragment, useEffect, useState } from 'react'
import { useHashToken } from './hash-token'

// The confirm page's island (/enrol/confirm#<token>): reads the token from the URL fragment (never sent to the
// server in a URL, so it stays out of logs), shows the entry and confirms it on a click. Opening the link alone
// changes nothing, so link scanners in mail systems can't confirm on someone's behalf.

type ConfirmView = {
  state: 'pending' | 'confirmed' | 'waitlist' | 'full' | 'expired'
  firstName: string
  programme: string
  target: string
  teamName: string | null
  expiresAt: string | null
  reference: string | null
  position: number | null
  details: { phone: string | null; birthYear: number | null; guardianName: string | null; emergencyContact: string | null } | null
}

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso))

async function call(token: string, action: 'view' | 'confirm'): Promise<ConfirmView> {
  const res = await fetch('/api/enrol/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, action }),
  })
  const data = (await res.json().catch(() => ({}))) as ConfirmView & { message?: string }
  if (!res.ok) throw new Error(data.message ?? 'Something went wrong. Please try again.')
  return data
}

/** Keyed by the link's token, so a second link opened in the same tab starts afresh (hash-token.ts). */
export default function ConfirmResponse() {
  const token = useHashToken()
  return <ConfirmResponseFor key={token} token={token} />
}

function ConfirmResponseFor({ token }: { token: string }) {
  const [view, setView] = useState<ConfirmView | null>(null)
  const [error, setError] = useState<string | null>(
    token ? null : 'This page needs the link from your enrolment email. Open the email and use its button.',
  )
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (token) call(token, 'view').then(setView, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [token])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      setView(await call(token, 'confirm'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (error && !view)
    return (
      <p role="alert" className="border-danger bg-danger-tint text-danger rounded-lg border-l-4 p-4 font-semibold">
        {error}
      </p>
    )
  if (!view) return <p>Loading your enrolment…</p>
  const d = view.details
  const rows: [string, string | null | undefined][] = [
    ['Mobile', d?.phone],
    ['Year of birth', d?.birthYear ? String(d.birthYear) : null],
    ['Parent or guardian', d?.guardianName],
    ['Emergency contact', d?.emergencyContact],
  ]
  const details = rows.filter((x): x is [string, string] => !!x[1])
  const what = `${view.target === view.programme ? view.programme : `${view.programme}: ${view.target}`}${view.teamName ? ` (team ${view.teamName})` : ''}`
  return (
    <div className="card space-y-4" aria-live="polite">
      <p>Hi {view.firstName},</p>
      {view.state === 'pending' && (
        <>
          <p>
            Confirm your email address to finish enrolling in <strong>{what}</strong>. No spot is held until you do; the link works until{' '}
            <strong>{when(view.expiresAt!)}</strong>.
          </p>
          {details.length > 0 && (
            <div>
              <p>Confirming also saves these details from the form:</p>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                {details.map(([label, value]) => (
                  <Fragment key={label}>
                    <dt className="font-semibold">{label}</dt>
                    <dd>{value}</dd>
                  </Fragment>
                ))}
              </dl>
              <p className="mt-1 text-sm text-muted">Not yours? Don't confirm: fill in the form again with the right details.</p>
            </div>
          )}
          <button type="button" disabled={busy} onClick={() => void confirm()} className="btn btn-enrol px-6 disabled:opacity-60">
            {busy ? 'Confirming…' : 'Confirm my enrolment'}
          </button>
        </>
      )}
      {view.state === 'confirmed' && (
        <p role="status">
          You're enrolled in <strong>{what}</strong>. Your reference is <strong className="tracking-wider">{view.reference}</strong>; we've
          emailed you the details.
        </p>
      )}
      {view.state === 'waitlist' && (
        <p role="status">
          Thanks, your email is confirmed. <strong>{what}</strong> is full, so you're on the waitlist
          {view.position ? ` (number ${view.position})` : ''}. Your reference is{' '}
          <strong className="tracking-wider">{view.reference}</strong>; if a spot opens up we'll email you an offer.
        </p>
      )}
      {view.state === 'full' && (
        <p role="status">
          Sorry, <strong>{what}</strong> filled up before your email was confirmed, so we couldn't keep your entry. Contact us if you'd like
          to be added by hand.
        </p>
      )}
      {view.state === 'expired' && (
        <p role="status">
          This link has expired or the entry was cancelled, so nothing was confirmed. You're welcome to fill in the form again.
        </p>
      )}
      {error && (
        <p role="alert" className="text-danger font-semibold">
          {error}
        </p>
      )}
    </div>
  )
}
