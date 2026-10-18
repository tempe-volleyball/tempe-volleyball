// One-off: drops WordPress's trailing slash from same-site links in pages and posts imported before the importer did
// it itself (2026-10-19, src/lib/wp-import/routes.ts stripTrailingSlashes). QA found links like /contact/ and
// /where-we-play/ on staging that cost a 301 each.
//
//   npx tsx scripts/fix-imported-links.ts                     # dry run against staging: lists what it would change
//   npx tsx scripts/fix-imported-links.ts --apply             # …and writes it to staging
//   npx tsx scripts/fix-imported-links.ts --local [--apply]   # the local D1 instead
//
// Guarded and idempotent: each row is only updated while nobody has edited it in the admin (updated_by IS NULL) and
// its HTML is still exactly what was read, so a second run finds nothing to do. Only body.html changes (imported
// bodies have no editor blocks). One import.fix audit row, written only when there's something to do. It never
// targets production, whose import will already have the fix.

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { stripTrailingSlashes } from '../src/lib/wp-import/routes'
import { sqlLiteral } from '../src/lib/wp-import/sql'
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

type Row = { id: string; where: string; html: string }
const read = (table: 'pages' | 'posts', label: string) =>
  query<Row>(
    `SELECT "id", ${label} AS "where", json_extract("body", '$.html') AS "html" FROM "${table}" WHERE "updated_by" IS NULL AND "wp_id" IS NOT NULL AND json_extract("body", '$.html') LIKE '%href="/%/%"%'`,
  )

const changes = (rows: Row[]) => rows.map((r) => ({ ...r, fixed: stripTrailingSlashes(r.html) })).filter((r) => r.fixed !== r.html)
const pages = changes(await read('pages', '"path"'))
const posts = changes(await read('posts', `'/news/' || "slug"`))
console.info(`Target: ${flags.local ? 'local' : 'staging'}.`)
console.info(`Pages: ${pages.map((r) => r.where).join(', ') || 'none'}`)
console.info(`Posts: ${posts.map((r) => r.where).join(', ') || 'none'}`)
if (pages.length + posts.length === 0) {
  console.info('Nothing to do.')
  process.exit(0)
}

const guard = (table: string, r: Row) =>
  `"${table}"."id" = ${sqlLiteral(r.id)} AND "${table}"."updated_by" IS NULL AND json_extract("${table}"."body", '$.html') = ${sqlLiteral(r.html)}`
const update = (table: string, r: Row & { fixed: string }) =>
  `UPDATE "${table}" SET "body" = json_set("body", '$.html', ${sqlLiteral(r.fixed)}) WHERE ${guard(table, r)};`
const anyLeft = [
  ...pages.map((r) => `EXISTS (SELECT 1 FROM "pages" WHERE ${guard('pages', r)})`),
  ...posts.map((r) => `EXISTS (SELECT 1 FROM "posts" WHERE ${guard('posts', r)})`),
].join(' OR ')
const auditJson = (v: unknown) => sqlLiteral(JSON.stringify(v))
const statements = [
  // First, while the guards still see the work, so a second run (nothing left) writes no row.
  `INSERT INTO "audit_log" ("id", "at", "actor_user_id", "action", "target_type", "target_id", "before", "after", "ip") SELECT lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, 'import.fix', 'import', 'links', ${auditJson({ trailingSlashLinks: [...pages, ...posts].map((r) => r.where) })}, ${auditJson({ source: 'scripts/fix-imported-links.ts' })}, NULL WHERE ${anyLeft};`,
  ...pages.map((r) => update('pages', r)),
  ...posts.map((r) => update('posts', r)),
]
await mkdir(CACHE_DIR, { recursive: true })
const file = join(CACHE_DIR, 'fix-imported-links.sql')
await writeFile(file, `${statements.join('\n')}\n`)
console.info(`SQL: ${file}`)
if (!flags.apply) {
  console.info('Dry run. Re-run with --apply to write it.')
  process.exit(0)
}
await wrangler(['d1', 'execute', 'DB', ...target, '--yes', '--file', file])
console.info(`Done: ${pages.length} pages and ${posts.length} posts.`)
