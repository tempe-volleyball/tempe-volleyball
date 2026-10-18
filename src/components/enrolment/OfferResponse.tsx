import { useEffect, useState } from 'react'
import { useHashToken } from './hash-token'

// The waitlist offer page's island (/enrol/offer#<token>): reads the token from the URL fragment (never sent to the
// server in a URL, so it stays out of logs), shows the offer and lets the person accept or decline it.

type OfferView = {
  state: 'live' | 'accepted' | 'gone'
  firstName: string
  programme: string
  target: string
  reference: string
  teamName: string | null
  expiresAt: string | null
}

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso))

async function call(token: string, action: 'view' | 'accept' | 'decline'): Promise<OfferView> {
  const res = await fetch('/api/enrol/offer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, action }),
  })
  const data = (await res.json().catch(() => ({}))) as OfferView & { message?: string }
  if (!res.ok) throw new Error(data.message ?? 'Something went wrong. Please try again.')
  return data
}

/** Keyed by the link's token, so a second link opened in the same tab starts afresh (hash-token.ts). */
export default function OfferResponse() {
  const token = useHashToken()
  return <OfferResponseFor key={token} token={token} />
}

function OfferResponseFor({ token }: { token: string }) {
  const [offer, setOffer] = useState<OfferView | null>(null)
  const [error, setError] = useState<string | null>(
    token ? null : 'This page needs the link from your offer email. Open the email and use its button.',
  )
  const [busy, setBusy] = useState(false)
  const [declined, setDeclined] = useState(false)

  useEffect(() => {
    if (token) call(token, 'view').then(setOffer, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [token])

  const respond = async (action: 'accept' | 'decline') => {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const v = await call(token, action)
      setOffer(v)
      if (action === 'decline') setDeclined(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (error && !offer)
    return (
      <p role="alert" className="rounded border border-red-300 bg-red-50 p-4 text-red-800">
        {error}
      </p>
    )
  if (!offer) return <p>Loading your offer…</p>
  const what = `${offer.target === offer.programme ? offer.programme : `${offer.programme}: ${offer.target}`}${offer.teamName ? ` (team ${offer.teamName})` : ''}`
  return (
    <div className="space-y-4 rounded border border-black/15 bg-white p-5" aria-live="polite">
      <p>Hi {offer.firstName},</p>
      {offer.state === 'live' && (
        <>
          <p>
            A spot is free in <strong>{what}</strong>. It's held for you until <strong>{when(offer.expiresAt!)}</strong>.
          </p>
          <p>Reference {offer.reference}</p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('accept')}
              className="bg-brand hover:bg-brand-dark rounded px-6 py-3 font-bold text-white disabled:opacity-60"
            >
              Accept the spot
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void respond('decline')}
              className="border-brand text-brand rounded border bg-white px-6 py-3 font-bold disabled:opacity-60"
            >
              No thanks, pass it on
            </button>
          </div>
        </>
      )}
      {offer.state === 'accepted' && (
        <p role="status">
          You're in <strong>{what}</strong>. Your reference is <strong>{offer.reference}</strong>; we've emailed you a confirmation.
        </p>
      )}
      {offer.state === 'gone' && (
        <p role="status">
          {declined
            ? "Thanks for letting us know. We've offered the spot to the next person."
            : 'This offer has lapsed or was already answered, so the spot has moved on. Contact us if you think that is wrong.'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-800">
          {error}
        </p>
      )}
    </div>
  )
}
