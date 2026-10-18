import { useCallback, useEffect, useState } from 'react'
import { slugify } from '../../lib/content/paths'
import { api, type CourtRow, type Me, type PurgeResult, type VenueRow } from '../api'
import { MoveButtons, Skeleton, confirmAction, Button, Card, Dialog, Field, Notice, TextArea, errorMessage, purgeNote } from '../ui'

// Venues (the places) and the courts inside them. Courts keep their ids when renamed, so draws and results follow
// the new name. Deleting is only for things nothing uses.

export function Venues({ me }: { me: Me }) {
  const isAdmin = me.user.role !== 'editor'
  const [rows, setRows] = useState<VenueRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [editing, setEditing] = useState<VenueRow | 'new' | null>(null)
  const load = useCallback(
    () =>
      api<{ venues: VenueRow[] }>('/api/admin/venues')
        .then((r) => setRows(r.venues))
        .catch((e) => setError(errorMessage(e))),
    [],
  )
  useEffect(() => {
    void load()
  }, [load])
  const replace = (v: VenueRow, text: string) => {
    setRows((rs) => rs?.map((r) => (r.id === v.id ? v : r)) ?? null)
    setMessage(text)
    setError(null)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Venues and courts</h1>
          <p className="mt-1 max-w-2xl text-sm text-black/60">
            The places we play and the courts inside them. Addresses, map links and directions show on the public site.
          </p>
        </div>
        {isAdmin && <Button onClick={() => setEditing('new')}>New venue</Button>}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {message && <Notice kind="success">{message}</Notice>}
      {rows === null && !error && <Skeleton />}
      <div className="grid gap-5 md:grid-cols-2">
        {rows?.map((v) => (
          <Card
            key={v.id}
            title={v.name}
            actions={
              isAdmin ? (
                <Button variant="secondary" className="px-3 py-1 text-xs" onClick={() => setEditing(v)}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            <div className="-mt-2 mb-3 space-y-1 text-sm text-black/70">
              {v.address && <p>{v.address}</p>}
              {v.mapUrl && (
                <p>
                  <a href={v.mapUrl} target="_blank" rel="noopener" className="text-brand underline">
                    Map
                  </a>
                </p>
              )}
              {v.directions && <p className="text-xs whitespace-pre-line text-black/60">{v.directions}</p>}
              <p className="text-xs text-black/60">
                Used by {v.usage.programmes} programme{v.usage.programmes === 1 ? '' : 's'}
                {v.usage.terms ? `, ${v.usage.terms} terms` : ''}
                {v.usage.sessions ? `, ${v.usage.sessions} sessions` : ''}
                {v.usage.events ? `, ${v.usage.events} event dates` : ''}
              </p>
            </div>
            <Courts venue={v} isAdmin={isAdmin} onChanged={replace} onError={setError} />
          </Card>
        ))}
      </div>
      {editing && (
        <VenueDialog
          venue={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onDone={(text) => {
            setEditing(null)
            setMessage(text)
            void load()
          }}
        />
      )}
    </div>
  )
}

function Courts({
  venue,
  isAdmin,
  onChanged,
  onError,
}: {
  venue: VenueRow
  isAdmin: boolean
  onChanged: (v: VenueRow, message: string) => void
  onError: (e: string) => void
}) {
  const [adding, setAdding] = useState('')
  const [busy, setBusy] = useState(false)
  const call = async (path: string, method: string, body: unknown, text: string) => {
    setBusy(true)
    try {
      const r = await api<{ venue: VenueRow; cache: PurgeResult }>(path, { method, body })
      onChanged(r.venue, `${text}${purgeNote(r.cache)}`)
      return true
    } catch (e) {
      onError(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  const move = (i: number, by: -1 | 1) => {
    const ids = venue.courts.map((c) => c.id)
    const [id] = ids.splice(i, 1)
    ids.splice(i + by, 0, id!)
    void call(`/api/admin/venues/${venue.id}/courts`, 'PUT', { ids }, 'Court order saved.')
  }
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold text-black/60 uppercase">Courts</h3>
      {venue.courts.length === 0 && <p className="text-sm text-black/60">No courts yet.</p>}
      <ul className="space-y-1">
        {venue.courts.map((c, i) => (
          <CourtItem
            key={c.id}
            court={c}
            isAdmin={isAdmin}
            busy={busy}
            first={i === 0}
            last={i === venue.courts.length - 1}
            onMove={(by) => move(i, by)}
            onRename={(name) => call(`/api/admin/courts/${c.id}`, 'PATCH', { name }, `Renamed to ${name}.`)}
            onDelete={async () => {
              if (await confirmAction({ title: `Delete ${c.name}?`, confirmLabel: 'Delete court', danger: true }))
                void call(`/api/admin/courts/${c.id}`, 'DELETE', undefined, `Deleted ${c.name}.`)
            }}
          />
        ))}
      </ul>
      {isAdmin && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            if (await call(`/api/admin/venues/${venue.id}/courts`, 'POST', { name: adding }, `Added ${adding}.`)) setAdding('')
          }}
        >
          <input
            className="w-40 rounded border border-black/20 px-2 py-1 text-sm"
            aria-label={`New court at ${venue.name}`}
            placeholder="Court 4"
            maxLength={60}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
          />
          <Button type="submit" variant="secondary" className="px-3 py-1 text-xs" disabled={busy || !adding.trim()}>
            Add court
          </Button>
        </form>
      )}
    </div>
  )
}

function CourtItem({
  court,
  isAdmin,
  busy,
  first,
  last,
  onMove,
  onRename,
  onDelete,
}: {
  court: CourtRow
  isAdmin: boolean
  busy: boolean
  first: boolean
  last: boolean
  onMove: (by: -1 | 1) => void
  onRename: (name: string) => Promise<boolean>
  onDelete: () => void
}) {
  const [name, setName] = useState(court.name)
  const used = court.matches + court.sessions + court.terms
  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      {isAdmin ? (
        <>
          <MoveButtons name={court.name} first={first} last={last} disabled={busy} onMove={onMove} />
          <input
            className="w-40 rounded border border-black/20 px-2 py-1 text-sm"
            aria-label="Court name"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {name.trim() && name !== court.name && (
            <Button variant="link" className="text-xs" disabled={busy} onClick={() => void onRename(name.trim())}>
              Save
            </Button>
          )}
        </>
      ) : (
        <span>{court.name}</span>
      )}
      <span className="text-xs text-black/60">{court.matches ? `${court.matches} matches` : used ? `${used} sessions` : 'unused'}</span>
      {isAdmin && !used && (
        <Button variant="link" className="ml-auto text-xs text-red-700" disabled={busy} onClick={onDelete}>
          Delete
        </Button>
      )}
    </li>
  )
}

function VenueDialog({ venue, onCancel, onDone }: { venue: VenueRow | null; onCancel: () => void; onDone: (message: string) => void }) {
  const [name, setName] = useState(venue?.name ?? '')
  const [slug, setSlug] = useState(venue?.slug ?? '')
  const [address, setAddress] = useState(venue?.address ?? '')
  const [mapUrl, setMapUrl] = useState(venue?.mapUrl ?? '')
  const [directions, setDirections] = useState(venue?.directions ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dirty =
    name !== (venue?.name ?? '') ||
    slug !== (venue?.slug ?? '') ||
    address !== (venue?.address ?? '') ||
    mapUrl !== (venue?.mapUrl ?? '') ||
    directions !== (venue?.directions ?? '')
  const unused = venue && venue.courts.length === 0 && Object.values(venue.usage).every((n) => n === 0)

  const save = async () => {
    setBusy('save')
    setError(null)
    const body = { name, slug: slug || slugify(name), address: address || null, mapUrl: mapUrl || null, directions: directions || null }
    try {
      const r = venue
        ? await api<{ cache: PurgeResult }>(`/api/admin/venues/${venue.id}`, {
            method: 'PATCH',
            body: { ...body, baseUpdatedAt: venue.updatedAt },
          })
        : await api<{ cache: PurgeResult }>('/api/admin/venues', { body })
      onDone(`${venue ? 'Saved' : 'Added'} ${name}.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }
  const remove = async () => {
    if (!venue || !(await confirmAction({ title: `Delete ${venue.name}?`, confirmLabel: 'Delete venue', danger: true }))) return
    setBusy('delete')
    try {
      const r = await api<{ cache: PurgeResult }>(`/api/admin/venues/${venue.id}`, { method: 'DELETE' })
      onDone(`Deleted ${venue.name}.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  return (
    <Dialog title={venue ? venue.name : 'New venue'} onCancel={onCancel} dirty={dirty && !busy}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <Field label="Name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="URL name" value={slug} placeholder={slugify(name)} onChange={(e) => setSlug(e.target.value)} />
        <Field
          label="Address"
          maxLength={300}
          value={address}
          placeholder="Holbeach Ave, Tempe NSW 2044"
          onChange={(e) => setAddress(e.target.value)}
          hint="End with the suburb (after a comma): lists show it next to the name."
        />
        <Field label="Map link" value={mapUrl} placeholder="https://maps.google.com/…" onChange={(e) => setMapUrl(e.target.value)} />
        <TextArea
          label="Directions"
          rows={4}
          maxLength={4000}
          value={directions}
          onChange={(e) => setDirections(e.target.value)}
          hint="Parking, entrances, public transport."
        />
        <div className="flex flex-wrap justify-between gap-2">
          {venue ? (
            <Button
              variant="danger"
              busy={busy === 'delete'}
              disabled={!!busy || !unused}
              title={unused ? undefined : 'Only venues with no courts that nothing uses can be deleted.'}
              onClick={() => void remove()}
            >
              Delete
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" busy={busy === 'save'} disabled={!!busy}>
              {venue ? 'Save' : 'Add venue'}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
