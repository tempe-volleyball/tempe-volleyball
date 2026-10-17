// Media: download the originals referenced by imported pages/posts (plus the logo, header photo and site icon),
// resize to WebP at the fixed widths with sharp, and stage the files for R2 under media/<id>/.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import type { ResolvedMedia } from '../../src/lib/wp-import/html'
import { uploadKey } from '../../src/lib/wp-import/html'
import type { SqlValue } from '../../src/lib/wp-import/sql'
import { decodeEntities } from '../../src/lib/wp-import/text'
import { CACHE_DIR, SITE, fetchFile } from './fetch'
import { stableId } from './ids'
import type { WpMedia } from './types'

export const WIDTHS = [400, 800, 1600] as const

/** Logo ("the one and only since 2005"), header photo and site icon, used by the theme rather than page bodies. */
export const THEME_MEDIA_WP_IDS = [3764, 3462, 3438]

export type R2Object = { key: string; file: string; contentType: string }

export type MediaItem = {
  id: string
  wpId: number | null
  url: string
  row: Record<string, SqlValue>
  resolved: ResolvedMedia
  objects: R2Object[]
}

const IMAGE_MIME = /^image\/(jpeg|png|gif|webp)$/

const extOf = (path: string, mime: string) => {
  const m = /\.([a-z0-9]+)$/i.exec(path)
  if (m) return m[1]!.toLowerCase().replace('jpeg', 'jpg')
  return mime === 'application/pdf' ? 'pdf' : (mime.split('/')[1] ?? 'bin')
}

const mimeOf = (ext: string) =>
  ({ jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' })[ext] ?? 'application/octet-stream'

/** Every known URL of each library item (original and WordPress's sized copies), keyed by uploadKey(). */
export function libraryIndex(media: WpMedia[]): Map<string, WpMedia> {
  const idx = new Map<string, WpMedia>()
  for (const m of media) {
    const urls = [m.source_url, ...Object.values(m.media_details?.sizes ?? {}).map((s) => s.source_url)]
    for (const u of urls) {
      const k = uploadKey(u)
      if (k && !idx.has(k)) idx.set(k, m)
    }
  }
  return idx
}

const OUT_DIR = join(CACHE_DIR, 'media-out')

/** Downloads and resizes one file. Returns null when the original can't be downloaded. */
export async function processMedia(source: { wp: WpMedia } | { url: string }, opts: { refresh?: boolean }): Promise<MediaItem | null> {
  const wp = 'wp' in source ? source.wp : null
  const url = wp ? wp.source_url : (source as { url: string }).url
  const key = uploadKey(url)!
  const id = wp ? stableId('media', wp.id) : stableId('upload', key)
  let buf = await fetchFile(url, opts)
  let fetchedUrl = url
  if (!buf && !wp) {
    // Orphaned links may only exist as "-scaled" copies.
    const scaled = encodeURI(`${SITE}/wp-content/uploads/${key.replace(/(\.[a-z0-9]+)$/i, '-scaled$1')}`)
    buf = await fetchFile(scaled, opts)
    fetchedUrl = scaled
  }
  if (!buf) return null

  const ext = extOf(key, wp?.mime_type ?? '')
  const mime = wp?.mime_type ?? mimeOf(ext)
  const dir = join(OUT_DIR, id)
  await mkdir(dir, { recursive: true })
  const original = join(dir, `original.${ext}`)
  if (!existsSync(original)) await writeFile(original, buf)
  const objects: R2Object[] = [{ key: `media/${id}/original.${ext}`, file: original, contentType: mime }]

  let width: number | null = null
  let height: number | null = null
  const variants: number[] = []
  if (IMAGE_MIME.test(mime)) {
    const meta = await sharp(buf, { failOn: 'none' }).metadata()
    // EXIF orientation 5–8 swaps width and height.
    const swap = (meta.orientation ?? 1) >= 5
    width = (swap ? meta.height : meta.width) ?? null
    height = (swap ? meta.width : meta.height) ?? null
    // The fixed widths up to the original's, plus the original width when it's under the largest (a 1500 px
    // header gets 400, 800 and 1500), so no image is only available downscaled.
    const widths: number[] = WIDTHS.filter((w) => !width || w <= width)
    if (width && width < WIDTHS.at(-1)! && !widths.includes(width)) widths.push(width)
    for (const w of widths) {
      const file = join(dir, `${w}.webp`)
      if (opts.refresh || !existsSync(file)) {
        const out = await sharp(buf, { animated: false, failOn: 'none' })
          .rotate()
          .resize({ width: w, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer()
        await writeFile(file, out)
      }
      variants.push(w)
      objects.push({ key: `media/${id}/${w}.webp`, file, contentType: 'image/webp' })
    }
  }

  const filename = decodeURIComponent(key.split('/').at(-1)!)
  return {
    id,
    wpId: wp?.id ?? null,
    url: fetchedUrl,
    resolved: { id, variants, ext },
    objects,
    row: {
      id,
      key_base: `media/${id}`,
      filename,
      alt: wp ? decodeEntities(wp.alt_text ?? '') : '',
      mime,
      width,
      height,
      variants,
      bytes: buf.length,
      wp_id: wp?.id ?? null,
      wp_url: wp ? wp.source_url : url,
    },
  }
}

/** Cached manifest of what's been uploaded to a bucket: key -> size, so reruns skip unchanged objects. */
export async function loadManifest(target: string): Promise<Record<string, number>> {
  const f = join(CACHE_DIR, `r2-manifest-${target}.json`)
  return existsSync(f) ? (JSON.parse(await readFile(f, 'utf8')) as Record<string, number>) : {}
}

export async function saveManifest(target: string, m: Record<string, number>) {
  await writeFile(join(CACHE_DIR, `r2-manifest-${target}.json`), JSON.stringify(m, null, 1))
}
