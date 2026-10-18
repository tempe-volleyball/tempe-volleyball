import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, formatBytes, type MediaItem } from '../api'
import { EmptyState, Button, Dialog, Field, Notice, errorMessage } from '../ui'
import { uploadMedia, uploadMime } from './upload'

// The media library's building blocks: the upload form, the searchable grid, and a picker dialog for the editor
// and image fields.

export function UploadForm({ onUploaded, imagesOnly }: { onUploaded: (m: MediaItem) => void; imagesOnly?: boolean }) {
  const [file, setFile] = useState<File | null>(null)
  const [alt, setAlt] = useState('')
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isImage = !!file && (uploadMime(file)?.startsWith('image/') ?? false)
  const preview = useMemo(() => (file && isImage ? URL.createObjectURL(file) : null), [file, isImage])
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!file) return
    const form = e.currentTarget
    setError(null)
    setProgress('Starting…')
    try {
      const m = await uploadMedia(file, alt, setProgress)
      setFile(null)
      setAlt('')
      form.reset()
      onUploaded(m)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setProgress(null)
    }
  }

  return (
    <form className="space-y-3" onSubmit={(e) => void submit(e)}>
      {error && <Notice kind="error">{error}</Notice>}
      <label className="block">
        <span className="mb-1 block text-sm font-semibold">File</span>
        <input
          type="file"
          required
          accept={imagesOnly ? 'image/jpeg,image/png,image/gif,image/webp' : 'image/jpeg,image/png,image/gif,image/webp,application/pdf'}
          className="block w-full text-sm"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
          }}
        />
        <span className="mt-1 block text-xs text-black/60">
          JPEG, PNG, GIF or WebP{imagesOnly ? '' : ', or a PDF'}, up to 20 MB. Images are resized to 400, 800 and 1600 px wide in your
          browser before uploading.
        </span>
      </label>
      {preview && <img src={preview} alt="" className="max-h-40 rounded border border-black/10" />}
      {(isImage || !file) && (
        <Field
          label="Description (alt text)"
          required={isImage}
          maxLength={300}
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          hint="What the image shows, for people using screen readers and for search engines, e.g. “Players at the net at Robyn Webster Sports Centre”."
        />
      )}
      <Button type="submit" busy={!!progress} disabled={!file}>
        Upload
      </Button>
      {progress && <p className="text-sm text-black/60">{progress}</p>}
    </form>
  )
}

export function MediaThumb({ m }: { m: MediaItem }) {
  if (m.urls.thumb)
    return <img src={m.urls.thumb} alt={m.alt} loading="lazy" className="aspect-[4/3] w-full rounded bg-black/5 object-cover" />
  return (
    <div className="flex aspect-[4/3] w-full items-center justify-center rounded bg-black/5 text-sm font-bold text-black/60 uppercase">
      {m.mime.split('/')[1] ?? 'file'}
    </div>
  )
}

export function useMediaList(opts: { imagesOnly?: boolean } = {}) {
  const [q, setQ] = useState('')
  const [items, setItems] = useState<MediaItem[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (query: string, offset = 0) => {
      setLoading(true)
      try {
        const params = new URLSearchParams({ q: query, offset: String(offset), limit: '48' })
        if (opts.imagesOnly) params.set('images', '1')
        const res = await api<{ items: MediaItem[]; next: number | null }>(`/api/admin/media?${params}`)
        setItems((cur) => (offset ? [...cur, ...res.items] : res.items))
        setNext(res.next)
        setError(null)
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        setLoading(false)
      }
    },
    [opts.imagesOnly],
  )

  useEffect(() => {
    const t = setTimeout(() => void load(q), q ? 250 : 0)
    return () => clearTimeout(t)
  }, [q, load])

  return { q, setQ, items, setItems, next, loading, error, reload: () => load(q), more: () => next !== null && load(q, next) }
}

export function MediaGrid({
  list,
  onPick,
  selectedId,
}: {
  list: ReturnType<typeof useMediaList>
  onPick: (m: MediaItem) => void
  selectedId?: string | null
}) {
  return (
    <div className="space-y-3">
      <Field
        label="Search"
        type="search"
        placeholder="File name or description"
        value={list.q}
        onChange={(e) => list.setQ(e.target.value)}
      />
      {list.error && <Notice kind="error">{list.error}</Notice>}
      {list.items.length === 0 && !list.loading ? (
        list.q ? (
          <EmptyState title="Nothing matches">Try part of the file name or its description.</EmptyState>
        ) : (
          <EmptyState title="No files yet">Upload images or PDFs here, then pick them in the page editor.</EmptyState>
        )
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {list.items.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onPick(m)}
                className={`w-full rounded border p-1 text-left hover:border-brand ${selectedId === m.id ? 'border-brand ring-brand/40 ring-2' : 'border-black/10'}`}
              >
                <MediaThumb m={m} />
                <span className="mt-1 block truncate text-xs font-semibold" title={m.filename}>
                  {m.filename}
                </span>
                <span className="block truncate text-xs text-black/60">
                  {m.width ? `${m.width}×${m.height} · ` : ''}
                  {formatBytes(m.bytes)}
                </span>
                {!m.alt && m.mime.startsWith('image/') && <span className="block text-xs font-semibold text-red-700">No description</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.next !== null && (
        <Button variant="secondary" busy={list.loading} onClick={() => void list.more()}>
          Load more
        </Button>
      )}
    </div>
  )
}

/** Choose an image from the library, or upload one. */
export function MediaPicker({
  title = 'Choose an image',
  onPick,
  onCancel,
}: {
  title?: string
  onPick: (m: MediaItem) => void
  onCancel: () => void
}) {
  const list = useMediaList({ imagesOnly: true })
  const [uploading, setUploading] = useState(false)
  return (
    <Dialog title={title} onCancel={onCancel} wide>
      <div className="space-y-4">
        {uploading ? (
          <div className="rounded border border-black/10 p-4">
            <UploadForm imagesOnly onUploaded={(m) => onPick(m)} />
            <Button variant="link" className="mt-3" onClick={() => setUploading(false)}>
              Back to the library
            </Button>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setUploading(true)}>
            Upload a new image
          </Button>
        )}
        {!uploading && <MediaGrid list={list} onPick={onPick} />}
      </div>
    </Dialog>
  )
}

/** A form field holding one image (social image, cover image). */
export function ImageField({
  label,
  hint,
  mediaId,
  onChange,
}: {
  label: string
  hint?: string
  mediaId: string | null
  onChange: (id: string | null) => void
}) {
  const [picking, setPicking] = useState(false)
  const [fetched, setFetched] = useState<MediaItem | null>(null)
  const item = mediaId && fetched?.id === mediaId ? fetched : null
  useEffect(() => {
    if (!mediaId || fetched?.id === mediaId) return
    api<{ media: MediaItem }>(`/api/admin/media/${mediaId}`)
      .then((r) => setFetched(r.media))
      .catch(() => setFetched(null))
  }, [mediaId, fetched?.id])
  return (
    <div>
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      <div className="flex items-center gap-3">
        {item ? (
          <img src={item.urls.thumb ?? item.urls.src} alt={item.alt} className="h-16 w-24 rounded object-cover" />
        ) : (
          <span className="text-sm text-black/60">None</span>
        )}
        <Button variant="secondary" onClick={() => setPicking(true)}>
          {item ? 'Change' : 'Choose'}
        </Button>
        {item && (
          <Button variant="link" onClick={() => onChange(null)}>
            Remove
          </Button>
        )}
      </div>
      {hint && <span className="mt-1 block text-xs text-black/60">{hint}</span>}
      {picking && (
        <MediaPicker
          onCancel={() => setPicking(false)}
          onPick={(m) => {
            setPicking(false)
            setFetched(m)
            onChange(m.id)
          }}
        />
      )}
    </div>
  )
}
