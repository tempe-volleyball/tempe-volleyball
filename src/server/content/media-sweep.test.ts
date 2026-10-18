import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '../db/testing'
import { media } from '../db/schema'
import { SWEEP_PAGE, sweepAbandonedUploads, type SweepBucket } from './media-sweep'

type Obj = { key: string; uploaded: Date; customMetadata?: Record<string, string> }

/** An R2 stand-in with list (sorted keys, startAfter, limit, truncated) and multi-key delete. */
const fakeBucket = (objects: Obj[]) => {
  const files = new Map(objects.map((o) => [o.key, o]))
  const calls: R2ListOptions[] = []
  const bucket: SweepBucket & { files: typeof files; calls: typeof calls } = {
    files,
    calls,
    async list(opts) {
      calls.push(opts)
      const keys = [...files.keys()].filter((k) => k.startsWith(opts.prefix ?? '') && (!opts.startAfter || k > opts.startAfter)).toSorted()
      const page = keys.slice(0, opts.limit ?? 1000)
      return { objects: page.map((k) => files.get(k)!), truncated: keys.length > page.length }
    },
    async delete(keys) {
      for (const k of keys) files.delete(k)
    },
  }
  return bucket
}

const NOW = new Date('2026-10-18T10:00:00Z')
const OLD = new Date('2026-10-16T10:00:00Z')
const RECENT = new Date('2026-10-18T09:00:00Z')
const ours = { source: 'admin-upload' }
const id = (n: number) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`
const files = (n: number, uploaded: Date, customMetadata?: Record<string, string>) =>
  ['400.webp', '800.webp', 'original.jpg'].map((f) => ({ key: `media/${id(n)}/${f}`, uploaded, customMetadata }))

let db: TestDb
beforeEach(() => {
  db = createTestDb().db
})

const addRow = (n: number) =>
  db.insert(media).values({ id: id(n), keyBase: `media/${id(n)}`, filename: 'x.jpg', mime: 'image/jpeg', bytes: 1, variants: [400, 800] })

describe('abandoned upload sweep', () => {
  it('deletes only old, uploader-made files that have no media row', async () => {
    await addRow(1)
    const bucket = fakeBucket([
      ...files(1, OLD, ours), // saved: kept
      ...files(2, OLD, ours), // abandoned: deleted
      ...files(3, RECENT, ours), // maybe still uploading: kept
      ...files(4, OLD), // the importer's (no marker): kept
      { key: 'media/not-an-id/x.webp', uploaded: OLD, customMetadata: ours },
    ])
    const r = await sweepAbandonedUploads(db, bucket, NOW)
    expect(r).toEqual({ listed: 13, deleted: 3, wrapped: true })
    expect([...bucket.files.keys()].filter((k) => k.includes(id(2)))).toEqual([])
    expect(bucket.files.size).toBe(10)
  })

  it('walks the bucket a page per run and starts again at the end', async () => {
    const objects = Array.from({ length: 200 }, (_, n) => files(n + 10, OLD, ours)).flat() // 600 keys, no rows
    const bucket = fakeBucket(objects)
    const first = await sweepAbandonedUploads(db, bucket, NOW)
    expect(first).toMatchObject({ listed: SWEEP_PAGE, wrapped: false })
    const second = await sweepAbandonedUploads(db, bucket, NOW)
    expect(second).toMatchObject({ listed: 600 - SWEEP_PAGE, wrapped: true })
    expect(bucket.files.size).toBe(0)
    await sweepAbandonedUploads(db, bucket, NOW)
    expect(bucket.calls.map((c) => c.startAfter ?? '')).toEqual(['', bucket.calls[1]!.startAfter, ''])
    expect(bucket.calls.every((c) => c.limit === SWEEP_PAGE && c.include?.includes('customMetadata'))).toBe(true)
  })
})
