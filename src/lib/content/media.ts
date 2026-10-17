import { mediaOriginalUrl, mediaVariantUrl } from '../wp-import/routes'

// Media library rules shared by the admin (which resizes images in the browser) and the Worker (which only checks
// and stores what it's sent). R2 layout: media/<id>/original.<ext> plus media/<id>/<width>.webp per variant.

/** The WebP widths made for every image (the importer uses the same). */
export const MEDIA_WIDTHS = [400, 800, 1600] as const

/** What can be uploaded, by MIME type, and the extension its original is stored under. No SVG (it can carry script). */
export const UPLOAD_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
} as const satisfies Record<string, string>

export type UploadMime = keyof typeof UPLOAD_TYPES

export const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024
export const MAX_VARIANT_BYTES = 5 * 1024 * 1024
export const MAX_ALT_LENGTH = 300
export const MAX_FILENAME_LENGTH = 200

export const isUploadMime = (m: unknown): m is UploadMime => typeof m === 'string' && Object.hasOwn(UPLOAD_TYPES, m)
export const isImageMime = (m: string) => m.startsWith('image/')

/**
 * The variant widths for an image `width` px wide: the fixed widths up to the original's, plus the original width
 * when it's under the largest, so no image is only available downscaled (a 1500 px photo gets 400, 800, 1500).
 */
export function variantWidths(width: number): number[] {
  if (!Number.isFinite(width) || width < 1) return []
  const w = Math.round(width)
  const out: number[] = MEDIA_WIDTHS.filter((x) => x <= w)
  if (w < MEDIA_WIDTHS.at(-1)! && !out.includes(w)) out.push(w)
  return out
}

/** Height for a variant `w` px wide, keeping the aspect ratio. */
export const scaledHeight = (width: number, height: number, w: number) => Math.max(1, Math.round((height * w) / width))

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const isMediaId = (id: unknown): id is string => typeof id === 'string' && UUID_RE.test(id)

export const mediaKeyBase = (id: string) => `media/${id}`

export type UploadFile = { kind: 'original'; ext: string; mime: UploadMime } | { kind: 'variant'; width: number; mime: 'image/webp' }

/** Parses the file part of an upload URL: "original.jpg" or "800.webp". null if it isn't one we accept. */
export function parseUploadFile(name: string): UploadFile | null {
  const variant = /^([1-9]\d{0,3})\.webp$/.exec(name)
  if (variant) {
    const width = Number(variant[1])
    return width <= MEDIA_WIDTHS.at(-1)! ? { kind: 'variant', width, mime: 'image/webp' } : null
  }
  const original = /^original\.([a-z0-9]+)$/.exec(name)
  if (original) {
    const entry = Object.entries(UPLOAD_TYPES).find(([, ext]) => ext === original[1])
    return entry ? { kind: 'original', ext: entry[1], mime: entry[0] as UploadMime } : null
  }
  return null
}

/** The R2 keys a media row's files live under. */
export function mediaKeys(m: { keyBase: string; mime: string; variants: readonly number[] }): string[] {
  const ext = isUploadMime(m.mime) ? UPLOAD_TYPES[m.mime] : null
  const keys = m.variants.map((w) => `${m.keyBase}/${w}.webp`)
  if (ext) keys.push(`${m.keyBase}/original.${ext}`)
  return keys
}

/** URLs for showing a media item: src (800 px or the largest), srcset, and the original file. */
export function mediaUrls(m: { id: string; mime: string; variants: readonly number[] }) {
  const ext = isUploadMime(m.mime) ? UPLOAD_TYPES[m.mime] : (m.mime.split('/')[1] ?? 'bin')
  const original = mediaOriginalUrl(m.id, ext)
  const widths = m.variants.toSorted((a, b) => a - b)
  if (widths.length === 0) return { src: original, srcset: null, thumb: null, original }
  const src = mediaVariantUrl(m.id, widths.includes(800) ? 800 : widths.at(-1)!)
  return {
    src,
    srcset: widths.map((w) => `${mediaVariantUrl(m.id, w)} ${w}w`).join(', '),
    thumb: mediaVariantUrl(m.id, widths[0]!),
    original,
  }
}

/** The content type for a stored media file name ("800.webp", "original.pdf"). */
export function fileContentType(name: string): string | null {
  const f = parseUploadFile(name)
  return f ? f.mime : null
}

export type MediaMetaCheck =
  | {
      ok: true
      value: { filename: string; mime: UploadMime; bytes: number; width: number | null; height: number | null; variants: number[] }
    }
  | { ok: false; message: string }

/** Checks the metadata the admin sends after uploading the files. */
export function checkMediaMeta(input: Record<string, unknown>): MediaMetaCheck {
  const mime = input.mime
  if (!isUploadMime(mime)) return { ok: false, message: 'Only JPEG, PNG, GIF, WebP and PDF files can be uploaded.' }
  const filename = typeof input.filename === 'string' ? input.filename.trim().slice(0, MAX_FILENAME_LENGTH) : ''
  if (!filename) return { ok: false, message: 'The file needs a name.' }
  const bytes = input.bytes
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 1 || bytes > MAX_ORIGINAL_BYTES)
    return { ok: false, message: `Files can be at most ${MAX_ORIGINAL_BYTES / 1024 / 1024} MB.` }
  if (!isImageMime(mime)) return { ok: true, value: { filename, mime, bytes, width: null, height: null, variants: [] } }
  const width = input.width
  const height = input.height
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 20_000 ||
    height > 20_000
  )
    return { ok: false, message: 'The image size is missing.' }
  const expected = variantWidths(width)
  const variants = input.variants
  if (!Array.isArray(variants) || variants.length !== expected.length || !expected.every((w) => variants.includes(w)))
    return { ok: false, message: `Expected resized copies at ${expected.join(', ')} px.` }
  return { ok: true, value: { filename, mime, bytes, width, height, variants: expected } }
}
