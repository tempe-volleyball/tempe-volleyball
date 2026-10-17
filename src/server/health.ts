import { sydneyDateTime } from '../lib/time'

export type Health = {
  ok: boolean
  env: string
  db: 'ok' | 'error'
  /** Sydney wall-clock time, so it's obvious at a glance the zone handling works. */
  time: string
  error?: string
}

/** The smallest slice of D1 the health check needs, so tests can pass a fake. */
type Pingable = Pick<D1Database, 'prepare'>

export async function checkHealth(db: Pingable, env: string, now = new Date()): Promise<Health> {
  const base = { env, time: sydneyDateTime(now) }
  try {
    const row = await db.prepare('select 1 as one').first<{ one: number }>()
    if (row?.one !== 1) return { ...base, ok: false, db: 'error', error: 'unexpected response' }
    return { ...base, ok: true, db: 'ok' }
  } catch (e) {
    return { ...base, ok: false, db: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}
