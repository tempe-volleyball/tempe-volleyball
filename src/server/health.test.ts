import { describe, expect, it } from 'vitest'
import { checkHealth } from './health'

const fakeDb = (first: () => Promise<unknown>) => ({ prepare: () => ({ first }) }) as unknown as Pick<D1Database, 'prepare'>
const now = new Date('2026-10-17T04:30:00Z')

describe('checkHealth', () => {
  it('is ok when the database answers', async () => {
    const h = await checkHealth(
      fakeDb(async () => ({ one: 1 })),
      'staging',
      now,
    )
    expect(h).toEqual({ ok: true, env: 'staging', db: 'ok', time: '2026-10-17 15:30' })
  })

  it('reports a database error without throwing', async () => {
    const h = await checkHealth(
      fakeDb(async () => {
        throw new Error('D1_ERROR: no such database')
      }),
      'production',
      now,
    )
    expect(h).toMatchObject({ ok: false, db: 'error', error: 'D1_ERROR: no such database' })
  })
})
