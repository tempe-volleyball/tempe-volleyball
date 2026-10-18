// One-off: tidies data imported before the importer fixes of 2026-10-19 (docs/admin.md §3.11, "Imported draws").
//
//   npx tsx scripts/fix-imported-seasons.ts                     # dry run against staging: shows what it would change
//   npx tsx scripts/fix-imported-seasons.ts --apply             # …and writes it to staging
//   npx tsx scripts/fix-imported-seasons.ts --local [--apply]   # the local D1 instead
//
// 1. Imported seasons get seasons.generated_from (scripts/wp/shape.ts), so their Fixtures tab stops saying
//    "Settings changed" about a draw nobody changed.
// 2. SportsPress placeholder "teams" that nothing uses (BYE, Grand Final, 3rd Place …) are deleted, so they leave
//    Admin → Teams and the merge picker. Old /team/<slug>/ links are redirects and don't need them.
//
// Guarded and idempotent: (1) only touches imported seasons with no key yet; (2) only deletes imported teams with a
// placeholder name that no season, game, ladder adjustment or enrolment uses. It writes one import.fix audit row when
// there's something to do. It never targets production (a fresh import there already has both fixes).

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { isPlaceholderTeamName } from '../src/lib/wp-import/titles'
import { sqlLiteral } from '../src/lib/wp-import/sql'
import { CACHE_DIR } from './wp/fetch'
import { IMPORTED_WITHOUT_SHAPE, importedShapeSql } from './wp/shape'

const ROOT = join(import.meta.dirname, '..')
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler')
const { values: flags } = parseArgs({ options: { apply: { type: 'boolean', default: false }, local: { type: 'boolean', default: false } } })
const target = flags.local ? ['--local'] : ['--env', 'staging', '--remote']

function wrangler(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(WRANGLER, args, { cwd: ROOT, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`wrangler ${args.join(' ')} exited ${code}\n${err}${out}`))))
  })
}

async function query<T>(sql: string): Promise<T[]> {
  const out = await wrangler(['d1', 'execute', 'DB', ...target, '--json', '--command', sql])
  const parsed = JSON.parse(out.slice(out.indexOf('['))) as { results: T[] }[]
  return parsed[0]?.results ?? []
}

/** An imported team nothing uses. */
const UNUSED = `"teams"."wp_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "season_teams" WHERE "team_id" = "teams"."id")
  AND NOT EXISTS (SELECT 1 FROM "matches" WHERE "home_team_id" = "teams"."id" OR "away_team_id" = "teams"."id" OR "duty_team_id" = "teams"."id")
  AND NOT EXISTS (SELECT 1 FROM "ladder_adjustments" WHERE "team_id" = "teams"."id")
  AND NOT EXISTS (SELECT 1 FROM "groups" WHERE "team_id" = "teams"."id")`.replace(/\n\s*/g, ' ')

const unkeyed = await query<{ id: string; name: string }>(
  `SELECT "id", "name" FROM "seasons" WHERE ${IMPORTED_WITHOUT_SHAPE} ORDER BY "name"`,
)
const unused = await query<{ id: string; name: string }>(`SELECT "id", "name" FROM "teams" WHERE ${UNUSED} ORDER BY "name"`)
const placeholders = unused.filter((t) => isPlaceholderTeamName(t.name))
console.info(`Target: ${flags.local ? 'local' : 'staging'}.`)
console.info(`Imported seasons without a draw key: ${unkeyed.map((s) => s.name).join(', ') || 'none'}`)
console.info(`Unused placeholder teams: ${placeholders.map((t) => t.name).join(', ') || 'none'}`)
if (unkeyed.length === 0 && placeholders.length === 0) {
  console.info('Nothing to do.')
  process.exit(0)
}

const ids = placeholders.map((t) => sqlLiteral(t.id)).join(', ')
const auditJson = (v: unknown) => sqlLiteral(JSON.stringify(v))
const statements = [
  // First, while the guards still see the work, so a second run (nothing left) writes no row.
  `INSERT INTO "audit_log" ("id", "at", "actor_user_id", "action", "target_type", "target_id", "before", "after", "ip") SELECT lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 'import.fix', 'import', 'wp', ${auditJson({ seasonsWithoutKey: unkeyed.map((s) => s.name), placeholderTeams: placeholders.map((t) => t.name) })}, ${auditJson({ source: 'scripts/fix-imported-seasons.ts' })}, NULL WHERE EXISTS (SELECT 1 FROM "seasons" WHERE ${IMPORTED_WITHOUT_SHAPE})${ids ? ` OR EXISTS (SELECT 1 FROM "teams" WHERE "id" IN (${ids}) AND ${UNUSED})` : ''};`,
  importedShapeSql(),
  ...(ids ? [`DELETE FROM "teams" WHERE "id" IN (${ids}) AND ${UNUSED};`] : []),
]
await mkdir(CACHE_DIR, { recursive: true })
const file = join(CACHE_DIR, 'fix-imported-seasons.sql')
await writeFile(file, `${statements.join('\n')}\n`)
console.info(`SQL: ${file}`)
if (!flags.apply) {
  console.info('Dry run. Re-run with --apply to write it.')
  process.exit(0)
}
await wrangler(['d1', 'execute', 'DB', ...target, '--yes', '--file', file])
const [left] = await query<{ n: number }>(`SELECT count(*) AS "n" FROM "seasons" WHERE ${IMPORTED_WITHOUT_SHAPE}`)
console.info(`Done. Imported seasons still without a key: ${left?.n}.`)
