import { eq, inArray } from 'drizzle-orm'
import type { AppDb } from '../db'
import { media, siteSettings } from '../db/schema'

// Cleaning up abandoned uploads. The admin uploads an item's files to R2 first and records the media row last
// (src/server/content/media.ts), so a closed tab or a failed save leaves files in R2 that nothing lists.
//
// The hourly cron walks the bucket a page at a time (R2 list, resuming after the last key it saw, which it keeps in
// site_settings under SWEEP_STATE_KEY) and deletes files that:
//   - were stored by the admin uploader (storeUpload marks them with customMetadata.source = 'admin-upload', so the
//     importer's files and anything else in the bucket are never touched),
//   - are older than ABANDONED_AFTER_MS (24 h; an upload takes seconds), and
//   - belong to an id with no media row.
// Each run costs one R2 list, at most one R2 delete, one or two D1 reads (ids in chunks of 100) and one D1 write.

export const SWEEP_STATE_KEY = 'cron.media_sweep'
export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000
/** Keys listed per run (an item is up to five files). */
export const SWEEP_PAGE = 400
/** The customMetadata storeUpload writes on every file. */
export const UPLOAD_SOURCE = { source: 'admin-upload' } as const

export type SweepBucket = {
  list(options: R2ListOptions): Promise<{
    objects: { key: string; uploaded: Date; customMetadata?: Record<string, string> | undefined }[]
    truncated: boolean
  }>
  delete(keys: string[]): Promise<void>
}

const KEY = /^media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[^/]+$/

export type SweepResult = { listed: number; deleted: number; wrapped: boolean }

export async function sweepAbandonedUploads(db: AppDb, bucket: SweepBucket, now = new Date()): Promise<SweepResult> {
  const state = await db.select({ value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, SWEEP_STATE_KEY)).get()
  const after =
    typeof (state?.value as { after?: unknown } | undefined)?.after === 'string' ? (state!.value as { after: string }).after : ''
  const page = await bucket.list({
    prefix: 'media/',
    limit: SWEEP_PAGE,
    include: ['customMetadata'],
    ...(after ? { startAfter: after } : {}),
  })

  const cutoff = now.getTime() - ABANDONED_AFTER_MS
  const candidates = new Map<string, string[]>()
  for (const o of page.objects) {
    const id = KEY.exec(o.key)?.[1]
    if (!id || o.customMetadata?.source !== UPLOAD_SOURCE.source || o.uploaded.getTime() > cutoff) continue
    candidates.set(id, [...(candidates.get(id) ?? []), o.key])
  }

  const ids = [...candidates.keys()]
  const known = new Set<string>()
  for (let i = 0; i < ids.length; i += 100) {
    const rows = await db
      .select({ id: media.id })
      .from(media)
      .where(inArray(media.id, ids.slice(i, i + 100)))
    for (const r of rows) known.add(r.id)
  }
  const orphans = ids.filter((id) => !known.has(id)).flatMap((id) => candidates.get(id)!)
  // R2 deletes up to 1000 keys per call; a page is at most SWEEP_PAGE.
  if (orphans.length) await bucket.delete(orphans)

  const next = page.truncated ? (page.objects.at(-1)?.key ?? '') : ''
  const at = now.toISOString()
  await db
    .insert(siteSettings)
    .values({ key: SWEEP_STATE_KEY, value: { after: next, at }, updatedAt: at })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value: { after: next, at }, updatedAt: at } })
  if (orphans.length) console.info(`[media] deleted ${orphans.length} abandoned upload file(s)`)
  return { listed: page.objects.length, deleted: orphans.length, wrapped: !page.truncated }
}
