import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { shapeKey } from '../../src/lib/fixtures'
import { toCompetition } from '../../src/server/competition/adapter'
import { loadSeason } from '../../src/server/competition/seasons'
import { createTestDb } from '../../src/server/db/testing'
import { leagues, seasons, seasonTeams, teams, type NewSeason } from '../../src/server/db/schema'
import type { SeasonSettings } from '../../src/server/db/schema/competition'
import { importedShapeSql } from './shape'

/** Rows imported long ago may lack settings keys; the adapter defaults them, and so must the SQL. */
const loose = (s: Partial<SeasonSettings>) => s as SeasonSettings

describe('importedShapeSql', () => {
  it('writes the same key as shapeKey() for imported seasons, and leaves the rest alone', async () => {
    const { db, sqlite } = createTestDb()
    await db.insert(leagues).values([
      { id: 'tnl', code: 'TNL', name: 'Thursday Night League', slug: 'tnl', weekday: 4 },
      { id: 'tvsl', code: 'TVSL', name: 'Super League', slug: 'tvsl', weekday: 0, format: 'super' },
    ])
    // Sorts tie on purpose (then by name), and a name that sorts before the others.
    await db.insert(teams).values([
      { id: 't-z', name: 'ZEBRAS', slug: 'zebras' },
      { id: 't-a', name: 'ANTS', slug: 'ants' },
      { id: 't-m', name: 'MOTHS', slug: 'moths' },
    ])
    const base = { year: 2026, startDate: '2026-10-01', status: 'published' as const }
    const rows: NewSeason[] = [
      {
        ...base,
        id: 's1',
        leagueId: 'tnl',
        name: 'TNL Q4 2026',
        slug: 'tnl-q4-2026',
        quarter: 4,
        wpId: 1,
        settings: loose({ sessions: ['19:00', '20:00', '21:00'], meetings: 2, includeFinals: true }),
      },
      // TVSL: no duty, no finals, no sessions key at all.
      {
        ...base,
        id: 's2',
        leagueId: 'tvsl',
        name: 'TVSL Q4 2026',
        slug: 'tvsl-q4-2026',
        quarter: 4,
        wpId: 2,
        dutyEnabled: false,
        settings: loose({}),
      },
      // Made here: not imported, so not touched.
      { ...base, id: 's3', leagueId: 'tnl', name: 'TNL Q1 2027', slug: 'tnl-q1-2027', year: 2027, quarter: 1, settings: loose({}) },
      // Imported but already keyed (e.g. regenerated here): not touched.
      {
        ...base,
        id: 's4',
        leagueId: 'tnl',
        name: 'TNL Q3 2026',
        slug: 'tnl-q3-2026',
        quarter: 3,
        wpId: 4,
        generatedFrom: 'kept',
        settings: loose({}),
      },
    ]
    await db.insert(seasons).values(rows)
    await db.insert(seasonTeams).values([
      { seasonId: 's1', teamId: 't-z', sort: 0 },
      { seasonId: 's1', teamId: 't-m', sort: 1 },
      { seasonId: 's1', teamId: 't-a', sort: 1 },
      { seasonId: 's2', teamId: 't-a', sort: 0 },
    ])

    sqlite.exec(importedShapeSql())
    sqlite.exec(importedShapeSql()) // idempotent

    for (const id of ['s1', 's2']) {
      const d = await loadSeason(db, id)
      expect(d.season.generatedFrom).toBe(shapeKey(toCompetition(d).settings))
    }
    expect((await db.select().from(seasons).where(eq(seasons.id, 's1')).get())!.generatedFrom).toBe(
      JSON.stringify([['t-z', 't-a', 't-m'], 3, 2, true, true]),
    )
    expect((await db.select().from(seasons).where(eq(seasons.id, 's3')).get())!.generatedFrom).toBeNull()
    expect((await db.select().from(seasons).where(eq(seasons.id, 's4')).get())!.generatedFrom).toBe('kept')
  })
})
