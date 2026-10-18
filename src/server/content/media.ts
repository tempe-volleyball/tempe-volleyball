import { describeError } from '../log'
import { desc, eq, or, sql } from 'drizzle-orm'
import { runBatch, type AppDb } from '../db'
import { media, pages, posts, user, type Media } from '../db/schema'
import { HttpError } from '../http'
import {
  MAX_ALT_LENGTH,
  MAX_ORIGINAL_BYTES,
  MAX_VARIANT_BYTES,
  checkMediaMeta,
  isMediaId,
  mediaKeyBase,
  mediaKeys,
  mediaUrls,
  parseUploadFile,
  UPLOAD_TYPES,
} from '../../lib/content/media'
import { UPLOAD_SOURCE } from './media-sweep'
import { audit, conflict, invalid, likeEscaped, likePattern, notFound, type Editor } from './common'

// The media library. Images are resized to WebP in the admin's browser; the Worker only streams the files it's
// sent into R2 (checking names, types and sizes) and then records the media row. No image processing here.
//
// Upload protocol (the admin's src/admin/media/upload.ts):
//   1. PUT /api/admin/media/<new uuid>/original.<ext>   the original file
//   2. PUT /api/admin/media/<uuid>/<width>.webp         each resized copy (images only; .jpg from browsers that
//                                                        can't encode WebP)
//   3. POST /api/admin/media { id, filename, mime, bytes, width, height, variants, variantExt, alt }
// Step 3 checks every file is in R2 before writing the row. Files from an abandoned upload are deleted by the
// hourly cron after a day (media-sweep.ts).

/** What the media routes need from the R2 binding (so tests can pass a fake). */
export type MediaBucket = Pick<R2Bucket, 'put' | 'head' | 'delete' | 'get'>

export type MediaRow = Media & { urls: ReturnType<typeof mediaUrls>; uploadedByEmail: string | null }

const withUrls = (m: Media & { uploadedByEmail?: string | null }): MediaRow => ({
  ...m,
  uploadedByEmail: m.uploadedByEmail ?? null,
  urls: mediaUrls(m),
})

export async function listMedia(db: AppDb, opts: { q?: string; limit?: number; offset?: number; images?: boolean } = {}) {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 60), 1), 200)
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0)
  const q = opts.q?.trim()
  const conds = [
    q ? or(likeEscaped(media.filename, likePattern(q)), likeEscaped(media.alt, likePattern(q))) : undefined,
    opts.images ? sql`${media.mime} like 'image/%'` : undefined,
  ].filter(Boolean)
  const rows = await db
    .select({ media, uploadedByEmail: user.email })
    .from(media)
    .leftJoin(user, eq(user.id, media.uploadedBy))
    .where(conds.length ? sql.join(conds as ReturnType<typeof sql>[], sql` and `) : undefined)
    .orderBy(desc(media.createdAt), desc(media.id))
    .limit(limit + 1)
    .offset(offset)
    .all()
  return {
    items: rows.slice(0, limit).map((r) => withUrls({ ...r.media, uploadedByEmail: r.uploadedByEmail })),
    next: rows.length > limit ? offset + limit : null,
  }
}

export async function getMedia(db: AppDb, id: string): Promise<MediaRow> {
  const row = await db.select().from(media).where(eq(media.id, id)).get()
  if (!row) throw notFound('file')
  return withUrls(row)
}

/** Streams one uploaded file into R2 at media/<id>/<name>. */
export async function storeUpload(
  db: AppDb,
  bucket: MediaBucket,
  id: string,
  name: string,
  file: { body: ReadableStream | null; contentType: string | null; contentLength: string | null },
) {
  if (!isMediaId(id)) throw invalid('Bad upload id.')
  const parsed = parseUploadFile(name)
  if (!parsed) throw invalid('Uploads are original.<jpg|png|gif|webp|pdf> or <width>.webp.')
  const type = (file.contentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== parsed.mime) throw new HttpError(415, 'unsupported_type', `Expected ${parsed.mime} for ${name}.`)
  const max = parsed.kind === 'original' ? MAX_ORIGINAL_BYTES : MAX_VARIANT_BYTES
  const length = Number(file.contentLength)
  if (!file.body || !Number.isInteger(length) || length < 1) throw new HttpError(411, 'length_required', 'The upload is empty.')
  if (length > max) throw new HttpError(413, 'too_large', `${name} is too large (at most ${Math.round(max / 1024 / 1024)} MB).`)
  // Ids are minted by the browser, so make sure this one isn't an existing item's (that would overwrite its files).
  const existing = await db.select({ id: media.id }).from(media).where(eq(media.id, id)).get()
  if (existing) throw conflict('That file has already been saved.')
  const key = `${mediaKeyBase(id)}/${name}`
  const object = await bucket.put(key, file.body, {
    httpMetadata: { contentType: parsed.mime, cacheControl: 'public, max-age=31536000, immutable' },
    // Marks the file as ours for the abandoned-upload sweep (media-sweep.ts), which only ever deletes these.
    customMetadata: { ...UPLOAD_SOURCE },
  })
  if (!object) throw new HttpError(500, 'upload_failed', 'The upload could not be stored.')
  return { key, size: object.size }
}

export type NewMediaInput = Record<string, unknown> & { id?: unknown; alt?: unknown }

const altText = (v: unknown) => {
  const alt = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
  if (!alt) throw invalid('Describe the image (alt text) for people who can’t see it.')
  if (alt.length > MAX_ALT_LENGTH) throw invalid(`Keep the description under ${MAX_ALT_LENGTH} characters.`)
  return alt
}

/** Records an uploaded file once all its parts are in R2. Images need alt text; PDFs get their name as alt. */
export async function createMedia(db: AppDb, bucket: MediaBucket, actor: Editor, input: NewMediaInput): Promise<MediaRow> {
  if (!isMediaId(input.id)) throw invalid('Bad upload id.')
  const id = input.id
  const meta = checkMediaMeta(input)
  if (!meta.ok) throw invalid(meta.message)
  const v = meta.value
  const isImage = v.mime.startsWith('image/')
  const alt = isImage ? altText(input.alt) : (typeof input.alt === 'string' && input.alt.trim()) || v.filename
  const keyBase = mediaKeyBase(id)
  const keys = mediaKeys({ keyBase, mime: v.mime, variants: v.variants, variantExt: v.variantExt })
  const heads = await Promise.all(keys.map((k) => bucket.head(k)))
  const missing = keys.filter((_, i) => !heads[i])
  if (missing.length)
    throw invalid(`Some files didn't finish uploading (${missing.map((k) => k.split('/').at(-1)).join(', ')}). Try again.`)
  const original = heads[keys.length - 1]!
  if (original.size !== v.bytes) throw invalid('The uploaded original is not the expected size. Try again.')
  try {
    await db.insert(media).values({
      id,
      keyBase,
      filename: v.filename,
      alt,
      mime: v.mime,
      width: v.width,
      height: v.height,
      variants: v.variants,
      variantExt: v.variantExt,
      bytes: v.bytes,
      uploadedBy: actor.id,
      updatedBy: actor.id,
    })
  } catch (e) {
    if (/UNIQUE constraint failed/i.test(String((e as { cause?: Error }).cause?.message ?? e)))
      throw conflict('That file has already been saved.')
    throw e
  }
  return getMedia(db, id)
}

/** Edits a file's alt text or name. */
export async function updateMedia(db: AppDb, actor: Editor, id: string, input: { alt?: unknown; filename?: unknown }): Promise<MediaRow> {
  const row = await db.select().from(media).where(eq(media.id, id)).get()
  if (!row) throw notFound('file')
  const alt =
    input.alt === undefined
      ? row.alt
      : row.mime.startsWith('image/')
        ? altText(input.alt)
        : String(input.alt).trim().slice(0, MAX_ALT_LENGTH)
  const filename = typeof input.filename === 'string' && input.filename.trim() ? input.filename.trim().slice(0, 200) : row.filename
  await db.update(media).set({ alt, filename, updatedBy: actor.id }).where(eq(media.id, id))
  return getMedia(db, id)
}

export type MediaUse = { type: 'page' | 'post'; id: string; title: string; where: 'body' | 'social image' | 'cover image' }

/** Pages and posts that show this file (in their body, or as the social / cover image). */
export async function mediaUsage(db: AppDb, id: string): Promise<MediaUse[]> {
  const inBody = `%/media/${id}/%`
  const [p, ps] = await Promise.all([
    db
      .select({ id: pages.id, title: pages.title, og: pages.ogImageId })
      .from(pages)
      .where(or(eq(pages.ogImageId, id), sql`${pages.body} like ${inBody}`))
      .all(),
    db
      .select({ id: posts.id, title: posts.title, cover: posts.coverMediaId })
      .from(posts)
      .where(or(eq(posts.coverMediaId, id), sql`${posts.body} like ${inBody}`))
      .all(),
  ])
  return [
    ...p.map((r): MediaUse => ({ type: 'page', id: r.id, title: r.title, where: r.og === id ? 'social image' : 'body' })),
    ...ps.map((r): MediaUse => ({ type: 'post', id: r.id, title: r.title, where: r.cover === id ? 'cover image' : 'body' })),
  ]
}

/** Deletes a file and its resized copies. Refused while a page or post uses it. Audited. */
export async function deleteMedia(db: AppDb, bucket: MediaBucket, actor: Editor, id: string, now = new Date()) {
  const row = await db.select().from(media).where(eq(media.id, id)).get()
  if (!row) throw notFound('file')
  const uses = await mediaUsage(db, id)
  if (uses.length) {
    const list = uses
      .slice(0, 5)
      .map((u) => `${u.type} “${u.title}” (${u.where})`)
      .join(', ')
    throw new HttpError(
      409,
      'in_use',
      `This file is used by ${list}${uses.length > 5 ? ` and ${uses.length - 5} more` : ''}. Remove it there first.`,
    )
  }
  await runBatch(db, [
    db.delete(media).where(eq(media.id, id)),
    audit(
      db,
      actor,
      'media.delete',
      { type: 'media', id },
      { filename: row.filename, mime: row.mime, bytes: row.bytes },
      null,
      now.toISOString(),
    ),
  ])
  // After the row is gone, so a failed R2 delete only leaves unlisted files behind.
  try {
    await bucket.delete(mediaKeys(row))
  } catch (e) {
    console.error(`[media] R2 delete failed for ${id}: ${describeError(e)}`)
  }
  return { id }
}

export { UPLOAD_TYPES }
