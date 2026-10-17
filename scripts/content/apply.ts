// The content map (docs/content-map.md): writes the drafted programmes, intros, page revisions, /enrol draft,
// archives and redirects from scripts/content/drafts.ts, as guarded SQL (scripts/content/sql.ts).
//
//   npx tsx scripts/content/apply.ts --write             # regenerate scripts/content/content-map.sql (checked in)
//   npx tsx scripts/content/apply.ts                     # dry run against staging: shows what's there now
//   npx tsx scripts/content/apply.ts --apply             # …and writes it to staging
//   npx tsx scripts/content/apply.ts --local [--apply]   # the local D1 instead
//
// Every statement is a no-op unless its row is still as the importer left it (no admin edits), so it's safe to run
// again. It never targets production: in Phase 8, after Michael has approved the drafts on staging, apply the
// checked-in content-map.sql to production by hand (docs/content-map.md, "Production").

import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CACHE_DIR } from '../wp/fetch'
import { contentMapSql } from './sql'

const ROOT = join(import.meta.dirname, '..', '..')
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler')
const SQL_FILE = join(import.meta.dirname, 'content-map.sql')

const { values: flags } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
    write: { type: 'boolean', default: false },
  },
})

const sql = contentMapSql()
if (flags.write) {
  await writeFile(SQL_FILE, sql)
  console.info(`Wrote ${SQL_FILE}`)
  process.exit(0)
}

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

async function query<T>(text: string): Promise<T[]> {
  const out = await wrangler(['d1', 'execute', 'DB', ...target, '--json', '--command', text])
  const parsed = JSON.parse(out.slice(out.indexOf('['))) as { results: T[] }[]
  return parsed[0]?.results ?? []
}

type State = Record<string, number>
const STATE_SQL = `SELECT
  (SELECT count(*) FROM leagues WHERE status = 'draft') AS draft_programmes,
  (SELECT count(*) FROM leagues WHERE start_time IS NOT NULL) AS programmes_with_times,
  (SELECT count(*) FROM leagues WHERE json_extract(description, '$.html') <> '') AS programmes_with_description,
  (SELECT count(*) FROM categories WHERE json_extract(intro, '$.html') <> '') AS categories_with_intro,
  (SELECT count(*) FROM venues WHERE directions IS NOT NULL AND directions <> '') AS venues_with_directions,
  (SELECT count(*) FROM pages WHERE status = 'published') AS published_pages,
  (SELECT count(*) FROM pages WHERE status = 'draft') AS draft_pages,
  (SELECT count(*) FROM pages WHERE status = 'archived') AS archived_pages,
  (SELECT count(*) FROM pages WHERE updated_by IS NOT NULL) AS admin_edited_pages,
  (SELECT count(*) FROM page_revisions) AS page_revisions,
  (SELECT count(*) FROM redirects WHERE source = 'manual') AS manual_redirects,
  (SELECT count(*) FROM audit_log) AS audit_rows`

const before = (await query<State>(STATE_SQL))[0] ?? {}
console.info(`Target: ${flags.local ? 'local' : 'staging'}`)
console.info(before)
await mkdir(CACHE_DIR, { recursive: true })
const file = join(CACHE_DIR, 'content-map.sql')
await writeFile(file, sql)
console.info(`SQL: ${file}`)
if (!flags.apply) {
  console.info('Dry run. Re-run with --apply to write it.')
  process.exit(0)
}
await wrangler(['d1', 'execute', 'DB', ...target, '--yes', '--file', file])
const after = (await query<State>(STATE_SQL))[0] ?? {}
console.info('Changes:')
for (const [k, v] of Object.entries(after)) if (v !== before[k]) console.info(`  ${k}: ${before[k]} -> ${v}`)
