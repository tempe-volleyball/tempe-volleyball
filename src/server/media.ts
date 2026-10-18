import { eq } from 'drizzle-orm'
import { socialFile } from '../lib/content/media'
import { MEDIA_CACHE_CONTROL } from './cache'
import type { AppDb } from './db'
import { media } from './db/schema'

// Serving media from R2. Keys follow the importer and the uploader: media/<id>/<width>.webp (or .jpg) for resized
// variants and media/<id>/original.<ext> for the original (PDFs only have that).

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FILE = /^(?:\d{2,5}\.(?:webp|jpg)|original\.[a-z0-9]{2,5})$/i

/** The R2 key for a /media/<id>/<file> URL, or null if the URL can't be one of ours (no R2 call then). */
export function mediaKey(id: string, file: string): string | null {
  if (!ID.test(id) || !FILE.test(file)) return null
  return `media/${id.toLowerCase()}/${file.toLowerCase()}`
}

/**
 * The R2 key behind /media/<id>/social (the sharing image pages link to without knowing the row): the variant
 * socialFile() picks, under the row's key base. One indexed lookup; null when there's no such image.
 */
export async function socialMediaKey(db: AppDb, id: string): Promise<string | null> {
  if (!ID.test(id)) return null
  const row = await db
    .select({ keyBase: media.keyBase, mime: media.mime, variants: media.variants, variantExt: media.variantExt })
    .from(media)
    .where(eq(media.id, id.toLowerCase()))
    .get()
  const file = row && socialFile(row)
  return row && file ? `${row.keyBase}/${file}` : null
}

const TYPES: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

type Obj = { key: string; httpEtag: string; size: number; httpMetadata?: { contentType?: string }; body?: ReadableStream }

/**
 * The response for an R2 lookup: 404 when missing, 304 when the client's copy is current (the R2 conditional get
 * returned no body, or the ETag matches), else the file with a year-long immutable Cache-Control.
 */
export function mediaResponse(object: Obj | null, ifNoneMatch: string | null): Response {
  if (!object) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'public, max-age=300' } })
  const ext = object.key.split('.').pop()?.toLowerCase() ?? ''
  const headers = new Headers({
    'Content-Type': object.httpMetadata?.contentType || TYPES[ext] || 'application/octet-stream',
    'Cache-Control': MEDIA_CACHE_CONTROL,
    ETag: object.httpEtag,
    'X-Content-Type-Options': 'nosniff',
  })
  // SVGs and PDFs are served as files, never as documents that can run script on our origin.
  if (ext === 'svg' || ext === 'pdf') headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  if (!object.body || (ifNoneMatch && ifNoneMatch.split(',').some((t) => t.trim() === object.httpEtag))) {
    return new Response(null, { status: 304, headers })
  }
  headers.set('Content-Length', String(object.size))
  return new Response(object.body, { status: 200, headers })
}
