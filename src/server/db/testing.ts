import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
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
export type QueryStats = { queries: number; batches: number; maxParams: number; reset(): void }

/** A migrated in-memory database and a Drizzle client (sqlite-proxy driver) with the full schema. */
export const createTestDb = () => {
  const sqlite = createMigratedSqlite()
  const stats: QueryStats = {
    queries: 0,
    batches: 0,
    maxParams: 0,
    reset() {
      this.queries = 0
      this.batches = 0
      this.maxParams = 0
    },
  }
  const exec = (sql: string, params: unknown[], method: Method) => {
    stats.queries++
    stats.maxParams = Math.max(stats.maxParams, params.length)
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
  const db = drizzle(
    async (sql, params, method) => exec(sql, params, method),
    // db.batch(): like D1, all statements run in one transaction and a failure rolls back the whole batch.
    async (queries) => {
      stats.batches++
      sqlite.exec('BEGIN')
      try {
        const results = queries.map((q) => exec(q.sql, q.params, q.method))
        sqlite.exec('COMMIT')
        return results
      } catch (e) {
        sqlite.exec('ROLLBACK')
        throw e
      }
    },
    { schema },
  )
  return { sqlite, db, stats }
}

export type TestDb = ReturnType<typeof createTestDb>['db']
