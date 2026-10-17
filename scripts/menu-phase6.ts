// One-off: moves an imported menu to the Phase 6 structure (docs/admin.md §3.5): Home · Mixed Leagues · Super League ·
// Juniors · Adult Training · Enrol · About, with category dropdowns that fill themselves. It's the importer's MENU
// (scripts/wp/content.ts), so a later import writes the same rows.
//
//   npx tsx scripts/menu-phase6.ts                     # dry run against staging: shows the guard and the SQL
//   npx tsx scripts/menu-phase6.ts --apply             # …and writes it to staging
//   npx tsx scripts/menu-phase6.ts --local [--apply]   # the local D1 instead
//
// Guarded: it refuses (and the SQL itself is a no-op) once anyone has edited the menu in the admin (an audit_log
// menu.update row, or a menu_items row with updated_by). It writes a menu.update audit row, so it runs once. It never
// targets production.

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { sqlLiteral } from '../src/lib/wp-import/sql'
import { FRONT_PAGE_SLUG, MENU_UNEDITED_SQL, buildMenu, guardedMenuStatements } from './wp/content'
import { CACHE_DIR } from './wp/fetch'

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

const [state] = await query<{ items: number; edited: number; audits: number }>(
  `SELECT (SELECT count(*) FROM menu_items) AS items, (SELECT count(*) FROM menu_items WHERE updated_by IS NOT NULL) AS edited, (SELECT count(*) FROM audit_log WHERE action = 'menu.update') AS audits`,
)
console.info(
  `Target: ${flags.local ? 'local' : 'staging'}. Menu items: ${state?.items}, edited rows: ${state?.edited}, menu.update audits: ${state?.audits}.`,
)
if (!state || state.edited > 0 || state.audits > 0) {
  console.error('The menu has been edited in the admin (or this already ran), so it is left alone.')
  process.exit(1)
}

const before = await query<{ label: string }>(`SELECT label FROM menu_items WHERE parent_id IS NULL ORDER BY sort`)
const pages = await query<{ id: string; path: string }>(`SELECT id, path FROM pages`)
const pageIdBySlug = new Map(pages.map((p) => [p.path === '/' ? FRONT_PAGE_SLUG : p.path.slice(1), p.id]))
// No league items in the new menu (category dropdowns list them), so no league ids are needed.
const rows = buildMenu(pageIdBySlug, new Map())
const after = rows.filter((r) => r.parent_id === null).map((r) => String(r.label))
const auditJson = (v: unknown) => sqlLiteral(JSON.stringify(v))
const statements = [
  ...guardedMenuStatements(rows),
  // Last, and guarded by the same check (the rows above don't set updated_by), so it records only a real change.
  `INSERT INTO "audit_log" ("id", "at", "actor_user_id", "action", "target_type", "target_id", "before", "after", "ip") SELECT lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 'menu.update', 'menu', 'main', ${auditJson({ items: state.items, labels: before.map((b) => b.label) })}, ${auditJson({ items: rows.length, labels: after, source: 'scripts/menu-phase6.ts' })}, NULL WHERE ${MENU_UNEDITED_SQL};`,
]
await mkdir(CACHE_DIR, { recursive: true })
const file = join(CACHE_DIR, 'menu-phase6.sql')
await writeFile(file, `${statements.join('\n')}\n`)
console.info(`Before: ${before.map((b) => b.label).join(' · ')}`)
console.info(`After:  ${after.join(' · ')} (${rows.length} items)`)
console.info(`SQL: ${file}`)
if (!flags.apply) {
  console.info('Dry run. Re-run with --apply to write it.')
  process.exit(0)
}
await wrangler(['d1', 'execute', 'DB', ...target, '--yes', '--file', file])
const [done] = await query<{ items: number }>(`SELECT count(*) AS items FROM menu_items`)
console.info(`Done: ${done?.items} menu items.`)
