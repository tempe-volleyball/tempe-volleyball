import { useEffect, useState } from 'react'
import { Link } from 'wouter'
import { api, formatBytes, formatWhen, type MediaItem, type MediaUse } from '../api'
import { MediaGrid, UploadForm, useMediaList } from '../media/MediaLibrary'
import { Button, Card, Dialog, Field, Notice, errorMessage } from '../ui'

// The media library: upload, search, edit descriptions, delete (refused while a page or post uses the file).

function Details({
  item,
  onSaved,
  onDeleted,
  onCancel,
}: {
  item: MediaItem
  onSaved: (m: MediaItem) => void
  onDeleted: (id: string) => void
  onCancel: () => void
}) {
  const [alt, setAlt] = useState(item.alt)
  const [filename, setFilename] = useState(item.filename)
  const [usage, setUsage] = useState<MediaUse[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isImage = item.mime.startsWith('image/')

  useEffect(() => {
    api<{ usage: MediaUse[] }>(`/api/admin/media/${item.id}`)
      .then((r) => setUsage(r.usage))
      .catch((e) => setError(errorMessage(e)))
  }, [item.id])

  const save = async () => {
    setBusy('save')
    setError(null)
    try {
      const r = await api<{ media: MediaItem }>(`/api/admin/media/${item.id}`, { method: 'PATCH', body: { alt, filename } })
      onSaved(r.media)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete ${item.filename}? This can't be undone.`)) return
    setBusy('delete')
    setError(null)
    try {
      await api(`/api/admin/media/${item.id}`, { method: 'DELETE' })
      onDeleted(item.id)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  return (
    <Dialog title={item.filename} onCancel={onCancel} wide>
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          {isImage ? (
            <img
              src={item.urls.src}
              srcSet={item.urls.srcset ?? undefined}
              sizes="400px"
              alt={item.alt}
              className="w-full rounded border border-black/10"
            />
          ) : (
            <a href={item.urls.original} target="_blank" rel="noopener" className="text-brand underline">
              Open {item.filename}
            </a>
          )}
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-black/60">Size</dt>
            <dd>
              {item.width ? `${item.width}×${item.height} px, ` : ''}
              {formatBytes(item.bytes)}
            </dd>
            {isImage && (
              <>
                <dt className="text-black/60">Copies</dt>
                <dd>
                  {item.variants.join(', ')} px wide ({item.variantExt === 'jpg' ? 'JPEG' : 'WebP'})
                </dd>
              </>
            )}
            <dt className="text-black/60">Uploaded</dt>
            <dd>
              {formatWhen(item.createdAt)} {item.uploadedByEmail ? `by ${item.uploadedByEmail}` : ''}
            </dd>
            <dt className="text-black/60">Address</dt>
            <dd className="break-all">
              <code>{isImage ? item.urls.src : item.urls.original}</code>
            </dd>
          </dl>
        </div>
        <div className="space-y-4">
          {error && <Notice kind="error">{error}</Notice>}
          <Field
            label="Description (alt text)"
            required={isImage}
            maxLength={300}
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            hint="Changing this doesn't update copies of the image already placed in pages; re-insert them to pick it up."
          />
          <Field label="File name" maxLength={200} value={filename} onChange={(e) => setFilename(e.target.value)} />
          <Button busy={busy === 'save'} disabled={!!busy} onClick={() => void save()}>
            Save
          </Button>
          <div>
            <h3 className="text-sm font-semibold">Used in</h3>
            {usage === null ? (
              <p className="text-sm text-black/60">Checking…</p>
            ) : usage.length === 0 ? (
              <p className="text-sm text-black/60">Not used by any page or post.</p>
            ) : (
              <ul className="list-disc pl-5 text-sm">
                {usage.map((u) => (
                  <li key={`${u.type}${u.id}${u.where}`}>
                    <Link href={u.type === 'page' ? `/pages/${u.id}` : `/news/${u.id}`} className="text-brand underline">
                      {u.title}
                    </Link>{' '}
                    <span className="text-black/60">
                      ({u.type}, {u.where})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button variant="danger" busy={busy === 'delete'} disabled={!!busy || !!usage?.length} onClick={() => void remove()}>
            Delete file
          </Button>
          {!!usage?.length && <p className="text-xs text-black/60">Remove it from the pages and posts above before deleting it.</p>}
        </div>
      </div>
    </Dialog>
  )
}

export function Media() {
  const list = useMediaList()
  const [open, setOpen] = useState<MediaItem | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Media</h1>
      {message && <Notice kind="success">{message}</Notice>}
      <Card title="Upload">
        <UploadForm
          onUploaded={(m) => {
            setMessage(`Uploaded ${m.filename}.`)
            list.setItems((items) => [m, ...items])
          }}
        />
      </Card>
      <Card title="Library">
        <MediaGrid list={list} onPick={setOpen} />
      </Card>
      {open && (
        <Details
          item={open}
          onCancel={() => setOpen(null)}
          onSaved={(m) => {
            setOpen(null)
            setMessage(`Saved ${m.filename}.`)
            list.setItems((items) => items.map((x) => (x.id === m.id ? m : x)))
          }}
          onDeleted={(id) => {
            setOpen(null)
            setMessage('Deleted.')
            list.setItems((items) => items.filter((x) => x.id !== id))
          }}
        />
      )}
    </div>
  )
}
