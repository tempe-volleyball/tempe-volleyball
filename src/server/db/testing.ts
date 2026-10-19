import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { is } from 'drizzle-orm'
import { SQLiteRaw } from 'drizzle-orm/sqlite-core/query-builders/raw'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import * as schema from './schema'

// Test helper (Node only, never import from app code): an in-memory SQLite with every migration in migrations/
// applied in order, the way wrangler applies them to D1, plus a Drizzle client over it. D1 is SQLite with foreign
// keys enforced, so this is close enough for testing queries and constraints.

const MIGRATIONS_DIR = join(import.meta.dirname, '../../../migrations')

export const migrationFiles = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .toSorted()

/** Splits a drizzle-kit migration into statements the way wrangler/drizzle do. */
export const migrationStatements = (sql: string) =>
  sql
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean)

/** Runs one migration file's statements against a database. */
export const applyMigration = (sqlite: DatabaseSync, file: string) => {
  for (const statement of migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))) {
    try {
      sqlite.exec(statement)
    } catch (e) {
      throw new Error(`${file}: ${(e as Error).message}\n${statement}`, { cause: e })
    }
  }
}

/**
 * An in-memory SQLite with the migrations applied in order. `before` stops ahead of that migration file (e.g.
 * '0003_phase6_programmes.sql'), so a test can insert old-shape rows and then apply the rest with applyMigration.
 */
export const createMigratedSqlite = (opts: { before?: string } = {}) => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const file of migrationFiles()) {
    if (opts.before && file >= opts.before) break
    applyMigration(sqlite, file)
  }
  return sqlite
}

type Method = 'run' | 'all' | 'values' | 'get'

/**
 * What the client has run, so tests can hold code to D1's free-plan limits: 50 queries per request (each statement
 * in a batch counts) and 100 bound parameters per statement. Reset it with `stats.reset()` before the call measured.
 */
export type QueryStats = {
  queries: number
  batches: number
  maxParams: number
  /** Every statement run since the last reset, for EXPLAIN QUERY PLAN checks (planOf below). */
  log: { sql: string; params: unknown[] }[]
  reset(): void
}

/**
 * The message drizzle's D1 driver fails with when a raw db.run/db.all(sql`…${param}`) is in a batch: its batch()
 * binds through `preparedQuery.stmt`, which raw statements don't have. Tests throw it too, so they catch it.
 */
export const RAW_BATCH_ERROR =
  "Cannot read properties of undefined (reading 'bind'): a raw db.run/all/get/values(sql`…`) statement with bound " +
  "parameters is in a db.batch()/runBatch(), which drizzle's D1 driver can't bind. Use a query builder instead."

/**
 * A migrated in-memory database and a Drizzle client (sqlite-proxy driver) with the full schema.
 *
 * db.batch() behaves like drizzle's D1 driver, so code that only works in tests fails here too:
 * - a raw statement (db.run/all/get/values) with bound parameters in a batch throws RAW_BATCH_ERROR;
 * - D1 returns batch rows as objects keyed by column name, which drizzle turns back into arrays with Object.keys,
 *   so selected columns with the same name (`id` from two joined tables, say) collapse into one and every later
 *   column shifts. Batch rows go through the same object step here. Outside a batch D1 returns arrays, so plain
 *   queries are unaffected. Raw statements in a batch get the objects themselves, as on D1.
 */
export const createTestDb = () => {
  const sqlite = createMigratedSqlite()
  const stats: QueryStats = {
    queries: 0,
    batches: 0,
    maxParams: 0,
    log: [],
    reset() {
      this.queries = 0
      this.batches = 0
      this.maxParams = 0
      this.log = []
    },
  }
  const exec = (sql: string, params: unknown[], method: Method) => {
    stats.queries++
    stats.maxParams = Math.max(stats.maxParams, params.length)
    stats.log.push({ sql, params })
    const stmt = sqlite.prepare(sql)
    const args = params as SQLInputValue[]
    if (method === 'run') {
      stmt.run(...args)
      return { rows: [] }
    }
    stmt.setReturnArrays(true)
    if (method === 'get') {
      const row = stmt.get(...args)
      return { rows: (row ?? undefined) as unknown as unknown[] }
    }
    return { rows: stmt.all(...args) as unknown as unknown[][] }
  }
  /** One statement of a batch, with D1's batch result shapes (see above). */
  const execInBatch = (sql: string, params: unknown[], method: Method, raw: boolean) => {
    if (method === 'run') return exec(sql, params, method)
    stats.queries++
    stats.maxParams = Math.max(stats.maxParams, params.length)
    stats.log.push({ sql, params })
    const stmt = sqlite.prepare(sql)
    stmt.setReturnArrays(true)
    const names = stmt.columns().map((c) => c.name)
    // Keyed by column name, the last one winning (as in D1's results), then back to arrays the way drizzle's D1
    // driver does it (d1ToRawMapping, with Object.keys).
    const objects = (stmt.all(...(params as SQLInputValue[])) as unknown as unknown[][]).map(
      (r) => Object.fromEntries(names.map((n, i) => [n, r[i]])) as Record<string, unknown>,
    )
    const arrays = objects.map((o) => Object.keys(o).map((k) => o[k]))
    if (raw) return { rows: method === 'values' ? arrays : objects }
    if (method === 'get') return { rows: arrays[0] as unknown[] }
    return { rows: arrays }
  }
  // Which statements of the batch being run are raw. db.batch below sets it, and drizzle calls the batch callback
  // synchronously from there (before its first await), so batches can't see each other's flags.
  let rawFlags: boolean[] = []
  const db = drizzle(
    async (sql, params, method) => exec(sql, params, method),
    // db.batch(): like D1, all statements run in one transaction and a failure rolls back the whole batch.
    async (queries) => {
      stats.batches++
      const raw = rawFlags
      rawFlags = []
      sqlite.exec('BEGIN')
      try {
        const results = queries.map((q, i) => execInBatch(q.sql, q.params, q.method, raw[i] ?? false))
        sqlite.exec('COMMIT')
        return results
      } catch (e) {
        sqlite.exec('ROLLBACK')
        throw e
      }
    },
    { schema },
  )
  const batch = db.batch.bind(db)
  db.batch = (async (items: Parameters<typeof batch>[0]) => {
    const raw = items.map((item) => is(item, SQLiteRaw))
    items.forEach((item, i) => {
      if (raw[i] && (item as unknown as SQLiteRaw<unknown>).getQuery().params.length > 0) throw new TypeError(RAW_BATCH_ERROR)
    })
    rawFlags = raw
    return batch(items)
  }) as unknown as typeof db.batch
  return { sqlite, db, stats }
}

export type TestDb = ReturnType<typeof createTestDb>['db']

/**
 * SQLite's plan for a logged statement (EXPLAIN QUERY PLAN), one line per step: "SCAN players", "SEARCH h USING
 * COVERING INDEX …". D1 bills rows read, so a SCAN of a table that grows with history is what tests look for.
 */
export const planOf = (sqlite: DatabaseSync, q: { sql: string; params: unknown[] }) =>
  (sqlite.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as SQLInputValue[])) as { detail: string }[]).map((r) => r.detail)
