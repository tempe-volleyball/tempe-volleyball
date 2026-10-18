import { sql, type SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { drizzle } from 'drizzle-orm/d1'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema'

/** A Drizzle client for one request. Cheap to create, so make one per request rather than sharing it. */
export const getDb = (d1: D1Database) => drizzle(d1, { schema })

export type Db = ReturnType<typeof getDb>

/**
 * What code in src/server accepts: the D1 client in the Worker, or the in-memory test client (db/testing.ts).
 * Both are async SQLite with the same query builder and `batch()` (one transaction, all or nothing).
 */
// oxlint-disable-next-line typescript/no-explicit-any -- the run-result type differs between the two drivers
export type AppDb = BaseSQLiteDatabase<'async', any, typeof schema>

type Item = BatchItem<'sqlite'>

/**
 * db.batch() on either client: one round trip, one transaction, all or nothing. The two clients' batch() types
 * don't unify, and callers often build the list dynamically, so this takes a plain non-empty array.
 */
export const runBatch = (db: AppDb, items: Item[]) => {
  if (items.length === 0) throw new Error('runBatch: empty batch')
  return (db as SqliteRemoteDatabase<typeof schema>).batch(items as [Item, ...Item[]])
}

/**
 * A guard for a batch: a statement that fails, rolling the whole batch back, when `failWhen` holds. SQLite has no
 * RAISE outside triggers, so it calls json() on the invalid string 'guard:<name>', which fails with "malformed
 * JSON". It's a query builder (a select from a one-row subquery), not db.run(sql``), because drizzle's D1 batch
 * can't bind a raw statement's parameters.
 */
export const batchGuard = (db: AppDb, failWhen: SQL, name: string) => {
  if (!/^[a-z_]+$/.test(name)) throw new Error(`batchGuard: bad name ${name}`)
  return db.select({ guard: sql`case when ${failWhen} then json(${sql.raw(`'guard:${name}'`)}) end` }).from(sql`(select 1)`)
}
