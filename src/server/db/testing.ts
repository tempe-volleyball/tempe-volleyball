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

export const createMigratedSqlite = () => {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const file of migrationFiles()) {
    for (const statement of migrationStatements(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))) {
      try {
        sqlite.exec(statement)
      } catch (e) {
        throw new Error(`${file}: ${(e as Error).message}\n${statement}`, { cause: e })
      }
    }
  }
  return sqlite
}

/** A migrated in-memory database and a Drizzle client (sqlite-proxy driver) with the full schema. */
export const createTestDb = () => {
  const sqlite = createMigratedSqlite()
  const db = drizzle(
    async (sql, params, method) => {
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
    },
    { schema },
  )
  return { sqlite, db }
}
