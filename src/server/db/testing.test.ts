import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { batchGuard, runBatch } from '.'
import { analyticsState, leagues, venues } from './schema'
import { createTestDb, RAW_BATCH_ERROR } from './testing'

// The test DB's batch must fail where drizzle's D1 driver fails, or bugs reach staging (QA, Phase 6).

describe('createTestDb batch, like D1', () => {
  it('throws on a raw statement with bound parameters in a batch, and rolls nothing in', async () => {
    const { db } = createTestDb()
    await expect(
      runBatch(db, [
        db.insert(analyticsState).values({ source: 'ga4', createdAt: 'x', updatedAt: 'x' }),
        db.run(sql`update analytics_state set last_error = ${'boom'}`),
      ]),
    ).rejects.toThrow(RAW_BATCH_ERROR)
    expect(await db.select().from(analyticsState)).toEqual([])
    // Outside a batch, raw statements with parameters are fine on D1 too.
    await db.run(sql`select ${1}`)
  })

  it('allows raw statements without parameters, and returns their rows as objects', async () => {
    const { db } = createTestDb()
    const [rows] = (await runBatch(db, [db.all(sql`select 1 as a, 'x' as b`)])) as unknown as [unknown[]]
    expect(rows).toEqual([{ a: 1, b: 'x' }])
  })

  it('collapses same-named columns of a join, as D1 batch rows are keyed by column name', async () => {
    const { db } = createTestDb()
    await db.insert(venues).values({ id: 'v1', slug: 'v', name: 'Venue', createdAt: 'x', updatedAt: 'x' })
    await db
      .insert(leagues)
      .values({ id: 'l1', code: 'TNL', slug: 'l', name: 'League', weekday: 4, defaultVenueId: 'v1', createdAt: 'x', updatedAt: 'x' })
    const q = (aliased: boolean) =>
      db
        .select({ league: leagues.name, venue: aliased ? sql<string>`${venues.name}`.as('venue_name') : venues.name, id: leagues.id })
        .from(leagues)
        .innerJoin(venues, eq(venues.id, leagues.defaultVenueId))
    // Not batched: arrays all the way, so it works.
    expect(await q(false)).toEqual([{ league: 'League', venue: 'Venue', id: 'l1' }])
    const [clash, ok] = (await runBatch(db, [q(false), q(true)])) as unknown as [unknown[], unknown[]]
    expect(clash).not.toEqual([{ league: 'League', venue: 'Venue', id: 'l1' }])
    expect(ok).toEqual([{ league: 'League', venue: 'Venue', id: 'l1' }])
  })

  it('batchGuard fails the batch only when its condition holds', async () => {
    const { db } = createTestDb()
    await runBatch(db, [batchGuard(db, sql`${1} = ${2}`, 'never')])
    await expect(runBatch(db, [batchGuard(db, sql`${1} = ${1}`, 'always')])).rejects.toThrow(/malformed JSON/)
  })
})
