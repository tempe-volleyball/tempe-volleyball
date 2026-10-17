import { MAX_ORIGINAL_BYTES, UPLOAD_TYPES, isUploadMime, scaledHeight, variantWidths, type UploadMime } from '../../lib/content/media'
import { ApiError, api, type MediaItem } from '../api'

// Browser side of a media upload: images are resized to WebP at 400/800/1600 px here (canvas), so the Worker never
// processes images. Then each file is PUT straight into R2 through the Worker, and the row is recorded last.
// See src/server/content/media.ts for the protocol.

export type UploadProgress = (message: string) => void

type Canvas = OffscreenCanvas | HTMLCanvasElement

const makeCanvas = (w: number, h: number): Canvas => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

const toWebp = async (canvas: Canvas): Promise<Blob> => {
  const blob =
    canvas instanceof HTMLCanvasElement
      ? await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8))
      : await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 })
  // Browsers that can't encode WebP silently hand back a PNG instead.
  if (!blob || blob.type !== 'image/webp')
    throw new Error("This browser can't make WebP images. Upload from Chrome, Edge or Firefox instead.")
  return blob
}

/** WebP copies of an image at the library's widths (largest first, each drawn from the previous for quality). */
export async function resizeImage(file: Blob): Promise<{ width: number; height: number; variants: { width: number; blob: Blob }[] }> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error("That image couldn't be read. Try saving it as a JPEG or PNG first.")
  }
  const { width, height } = bitmap
  const widths = variantWidths(width).toSorted((a, b) => b - a)
  const variants: { width: number; blob: Blob }[] = []
  let source: CanvasImageSource = bitmap
  let sourceWidth = width
  for (const w of widths) {
    // Halve at most ~2.5x per step so large downscales stay sharp.
    while (sourceWidth / w > 2.5) {
      const half = Math.round(sourceWidth / 2)
      const step = makeCanvas(half, scaledHeight(width, height, half))
      draw(step, source)
      source = step as CanvasImageSource
      sourceWidth = half
    }
    const canvas = makeCanvas(w, scaledHeight(width, height, w))
    draw(canvas, source)
    variants.push({ width: w, blob: await toWebp(canvas) })
    source = canvas as CanvasImageSource
    sourceWidth = w
  }
  bitmap.close()
  return { width, height, variants }
}

function draw(canvas: Canvas, source: CanvasImageSource) {
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new Error("This browser can't resize images.")
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
}

async function put(id: string, name: string, blob: Blob, type: string) {
  const res = await fetch(`/api/admin/media/${id}/${name}`, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': type },
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
    throw new ApiError(res.status, data.error ?? 'upload_failed', data.message ?? `Upload failed (${res.status}).`)
  }
}

/** The MIME type to upload a file as (browsers sometimes leave it blank or say image/jpg). */
export function uploadMime(file: File): UploadMime | null {
  const t = file.type === 'image/jpg' ? 'image/jpeg' : file.type
  if (isUploadMime(t)) return t
  const ext = file.name.split('.').at(-1)?.toLowerCase()
  const byExt = Object.entries(UPLOAD_TYPES).find(([, e]) => e === ext || (ext === 'jpeg' && e === 'jpg'))
  return byExt ? (byExt[0] as UploadMime) : null
}

/** Resizes (images), uploads every file and records the media item. */
export async function uploadMedia(file: File, alt: string, progress: UploadProgress = () => {}): Promise<MediaItem> {
  const mime = uploadMime(file)
  if (!mime) throw new Error('Only JPEG, PNG, GIF, WebP and PDF files can be uploaded.')
  if (file.size > MAX_ORIGINAL_BYTES)
    throw new Error(`That file is ${Math.round(file.size / 1024 / 1024)} MB; the limit is ${MAX_ORIGINAL_BYTES / 1024 / 1024} MB.`)
  const id = crypto.randomUUID()
  let meta: { width: number | null; height: number | null; variants: number[] } = { width: null, height: null, variants: [] }
  if (mime.startsWith('image/')) {
    progress('Resizing…')
    const resized = await resizeImage(file)
    meta = { width: resized.width, height: resized.height, variants: resized.variants.map((v) => v.width) }
    for (const [i, v] of resized.variants.entries()) {
      progress(`Uploading ${i + 1} of ${resized.variants.length + 1}…`)
      await put(id, `${v.width}.webp`, v.blob, 'image/webp')
    }
  }
  progress('Uploading original…')
  await put(id, `original.${UPLOAD_TYPES[mime]}`, file, mime)
  progress('Saving…')
  const res = await api<{ media: MediaItem }>('/api/admin/media', {
    body: { id, filename: file.name, mime, bytes: file.size, alt, ...meta },
  })
  return res.media
}
