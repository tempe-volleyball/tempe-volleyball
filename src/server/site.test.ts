import { describe, expect, it } from 'vitest'
import { createTestDb } from './db/testing'
import { venues } from './db/schema'
import { bumpSiteVersion, createSiteMemo } from './site'

const setup = () => {
  const t = createTestDb()
  let now = 1_000_000
  const memo = createSiteMemo({ maxAgeMs: 60_000, clock: () => now })
  return { ...t, memo, tick: (ms: number) => (now += ms) }
}

describe('createSiteMemo', () => {
  it('reuses the Site while the version matches, for one one-row query', async () => {
    const { db, stats, memo } = setup()
    const first = await memo.load(db)
    stats.reset()
    const again = await memo.load(db)
    expect(again).toBe(first)
    expect(stats.queries).toBe(1)
  })

  it('reloads after an admin write bumps the version (from any isolate)', async () => {
    const { db, memo } = setup()
    const before = await memo.load(db)
    await db.insert(venues).values({ id: 'v1', name: 'Robyn Webster Sports Centre', slug: 'tempe' })
    expect((await memo.load(db)).venues).toHaveLength(before.venues.length)
    await bumpSiteVersion(db)
    expect((await memo.load(db)).venues.map((v) => v.id)).toContain('v1')
    // Bumping twice works (upsert), and an unknown key never reaches the settings.
    await bumpSiteVersion(db)
    expect(Object.keys((await memo.load(db)).settings)).not.toContain('site_version')
  })

  it('reloads once the copy is older than maxAgeMs, even without a bump', async () => {
    const { db, memo, tick } = setup()
    await memo.load(db)
    await db.insert(venues).values({ id: 'v2', name: 'MLC School', slug: 'mlc' })
    tick(59_000)
    expect((await memo.load(db)).venues.map((v) => v.id)).not.toContain('v2')
    tick(2_000)
    expect((await memo.load(db)).venues.map((v) => v.id)).toContain('v2')
  })

  it('clear() drops the copy; concurrent misses share one load', async () => {
    const { db, stats, memo } = setup()
    stats.reset()
    const [a, b] = await Promise.all([memo.load(db), memo.load(db)])
    expect(a).toBe(b)
    expect(stats.batches).toBe(1)
    memo.clear()
    expect(await memo.load(db)).not.toBe(a)
  })
})
