// Imports the live WordPress + SportsPress site (public REST API only) into D1 and R2. See PLAN.md Phase 2.
//
//   npm run import:wp                         # fetch (cached), build SQL, apply to the local D1 + local R2
//   npm run import:wp -- --remote-staging     # …and also to the staging D1 + tempevb-media-staging
//   flags: --refresh (refetch the API), --sql-only (write SQL, apply nothing), --skip-media (no downloads/R2),
//          --skip-r2 (process media but don't upload), --concurrency N (parallel R2 uploads, default 6)
//
// Idempotent: every row gets a deterministic id derived from its WordPress id, and the SQL is INSERT … ON CONFLICT
// DO UPDATE, so re-running updates in place. It never writes to production.

import { spawn } from 'node:child_process'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { UPLOAD_URL_RE, uploadKey, type ResolvedMedia } from '../src/lib/wp-import/html'
import { chunkStatements, sqlLiteral, upsertStatements, type SqlValue } from '../src/lib/wp-import/sql'
import { RECONCILIATION_REASON, buildCompetition } from './wp/competition'
import { buildContent, contentPages, mediaRedirects } from './wp/content'
import { CACHE_DIR, SITE, fetchCollection } from './wp/fetch'
import { THEME_MEDIA_WP_IDS, libraryIndex, loadManifest, processMedia, saveManifest, type MediaItem, type R2Object } from './wp/media'
import type { WpData, WpMedia } from './wp/types'

const ROOT = join(import.meta.dirname, '..')
const WRANGLER = join(ROOT, 'node_modules', '.bin', 'wrangler')

const { values: flags } = parseArgs({
  options: {
    'remote-staging': { type: 'boolean', default: false },
    refresh: { type: 'boolean', default: false },
    'sql-only': { type: 'boolean', default: false },
    'skip-media': { type: 'boolean', default: false },
    'skip-r2': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '6' },
  },
})

type Target = { name: 'local' | 'staging'; d1: string[]; bucket: string; r2: string[] }
const TARGETS: Record<Target['name'], Target> = {
  local: { name: 'local', d1: ['--local'], bucket: 'tempevb-media-local', r2: ['--local'] },
  staging: { name: 'staging', d1: ['--env', 'staging', '--remote'], bucket: 'tempevb-media-staging', r2: ['--remote'] },
}

function run(args: string[], opts: { quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(WRANGLER, args, { cwd: ROOT, env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('close', (code) => {
      if (code === 0) {
        if (!opts.quiet)
          process.stdout.write(
            out
              .split('\n')
              .filter((l) => /executed|rows|error|warn/i.test(l))
              .join('\n') + '\n',
          )
        resolve(out)
      } else reject(new Error(`wrangler ${args.join(' ')} exited ${code}\n${out}`))
    })
  })
}

async function fetchAll(refresh: boolean): Promise<WpData> {
  const get = <T>(route: string) => fetchCollection<T>(route, { refresh })
  // Sequential on purpose: be polite to the live site.
  return {
    pages: await get('wp/v2/pages'),
    posts: await get('wp/v2/posts'),
    media: await get('wp/v2/media'),
    categories: await get('wp/v2/categories'),
    events: await get('sportspress/v2/events'),
    teams: await get('sportspress/v2/teams'),
    leagues: await get('sportspress/v2/leagues'),
    seasons: await get('sportspress/v2/seasons'),
    venues: await get('sportspress/v2/venues'),
    tables: await get('sportspress/v2/tables'),
    calendars: await get('sportspress/v2/calendars'),
  }
}

/** Library items and orphaned upload links referenced by what we import, plus the theme's logo/header/icon. */
function referencedMedia(data: WpData) {
  const lib = libraryIndex(data.media)
  const byWp = new Map(data.media.map((m) => [m.id, m]))
  const library = new Map<number, WpMedia>()
  const orphans = new Map<string, string>()
  const docs = [...contentPages(data.pages), ...data.posts.filter((p) => p.status === 'publish')]
  for (const d of docs) {
    for (const url of d.content.rendered.match(UPLOAD_URL_RE) ?? []) {
      const key = uploadKey(url)
      if (!key) continue
      const m = lib.get(key)
      if (m) library.set(m.id, m)
      else if (!orphans.has(key)) orphans.set(key, encodeURI(`${SITE}/wp-content/uploads/${key}`))
    }
    const f = d.featured_media ? byWp.get(d.featured_media) : undefined
    if (f) library.set(f.id, f)
  }
  for (const id of THEME_MEDIA_WP_IDS) {
    const m = byWp.get(id)
    if (m) library.set(id, m)
  }
  return { lib, library, orphans }
}

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        await fn(items[i]!, i)
      }
    }),
  )
}

async function uploadR2(target: Target, objects: R2Object[], concurrency: number) {
  const manifest = await loadManifest(target.name)
  const todo: (R2Object & { size: number })[] = []
  for (const o of objects) {
    const size = (await stat(o.file)).size
    if (manifest[o.key] !== size) todo.push({ ...o, size })
  }
  console.info(`R2 ${target.bucket}: ${objects.length} objects, ${todo.length} to upload`)
  let done = 0
  let failed = 0
  // Local R2 is a SQLite file: parallel writers get "database is locked", so upload locally one at a time.
  const n = target.name === 'local' ? 1 : concurrency
  await pool(todo, n, async (o) => {
    const args = [
      'r2',
      'object',
      'put',
      `${target.bucket}/${o.key}`,
      '--file',
      o.file,
      '--content-type',
      o.contentType,
      '--cache-control',
      'public, max-age=31536000, immutable',
      ...target.r2,
    ]
    for (let attempt = 1; ; attempt++) {
      try {
        await run(args, { quiet: true })
        manifest[o.key] = o.size
        break
      } catch (e) {
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * attempt))
          continue
        }
        failed++
        const msg = (e as Error).message
        console.error(
          `  failed ${o.key}: ${
            msg
              .split('\n')
              .filter((l) => /error|✘/i.test(l))
              .slice(0, 2)
              .join(' ') || msg.slice(0, 300)
          }`,
        )
        break
      }
    }
    if (++done % 50 === 0) {
      console.info(`  ${done}/${todo.length}`)
      await saveManifest(target.name, manifest)
    }
  })
  await saveManifest(target.name, manifest)
  return { total: objects.length, uploaded: todo.length - failed, failed }
}

async function main() {
  const targets = flags['sql-only'] ? [] : [TARGETS.local, ...(flags['remote-staging'] ? [TARGETS.staging] : [])]
  console.info('Fetching (cached under scripts/.cache)…')
  const data = await fetchAll(flags.refresh)

  console.info('Mapping SportsPress…')
  const comp = buildCompetition(data)

  // Media
  const items: MediaItem[] = []
  const mediaFailures: string[] = []
  const resolvedByKey = new Map<string, ResolvedMedia>()
  const mediaIdByWp = new Map<number, string>()
  const { lib, library, orphans } = referencedMedia(data)
  if (!flags['skip-media']) {
    console.info(`Media: ${library.size} library items and ${orphans.size} orphaned upload links referenced`)
    let n = 0
    const sources: ({ wp: WpMedia } | { url: string })[] = [
      ...[...library.values()].map((wp) => ({ wp })),
      ...[...orphans.values()].map((url) => ({ url })),
    ]
    for (const src of sources) {
      const label = 'wp' in src ? src.wp.source_url : src.url
      try {
        const item = await processMedia(src, { refresh: flags.refresh })
        if (item) items.push(item)
        else mediaFailures.push(`404 ${label}`)
      } catch (e) {
        mediaFailures.push(`${label}: ${(e as Error).message}`)
      }
      if (++n % 25 === 0) console.info(`  ${n}/${sources.length}`)
    }
    for (const it of items) {
      if (it.wpId !== null) mediaIdByWp.set(it.wpId, it.id)
      const k = uploadKey(it.row.wp_url as string)
      if (k) resolvedByKey.set(k, it.resolved)
    }
    // Every sized copy of a library item resolves to the item.
    for (const [k, m] of lib) {
      const id = mediaIdByWp.get(m.id)
      const it = id && items.find((x) => x.id === id)
      if (it && !resolvedByKey.has(k)) resolvedByKey.set(k, it.resolved)
    }
  }
  const resolveMedia = (url: string) => resolvedByKey.get(uploadKey(url) ?? '') ?? null

  console.info('Mapping pages, posts, menu and redirects…')
  const content = buildContent(data, comp, resolveMedia, mediaIdByWp)
  const redirects = [...content.redirects]
  const seen = new Set(redirects.map((r) => r.from_path))
  for (const r of mediaRedirects(items)) if (!seen.has(r.from_path)) redirects.push(r)

  // SQL, parents before children.
  type R = Record<string, SqlValue>
  const up = (table: string, rows: R[], conflict = ['id'], extra: { touch?: boolean; where?: string; update?: string[] } = {}) =>
    rows.length ? upsertStatements(table, rows, { conflict, touch: true, ...extra }) : []
  const seasonIds = comp.seasons.map((s) => sqlLiteral(s.id as string)).join(', ')
  const notIn = (ids: SqlValue[]) => (ids.length ? ids.map((i) => sqlLiteral(i)).join(', ') : `''`)
  const stmts = [
    ...up('venues', comp.venues),
    ...up('courts', comp.courts),
    ...up('leagues', comp.leagues),
    // Categories are seeded by migration 0003; put leagues imported after it into theirs, never overriding an edit.
    `UPDATE "leagues" SET "category_id" = 'cat_mixed_leagues' WHERE "code" IN ('TNL', 'FNL', 'SNL', 'SAL') AND "category_id" IS NULL;`,
    `UPDATE "leagues" SET "category_id" = 'cat_super_league' WHERE "code" = 'TVSL' AND "category_id" IS NULL;`,
    ...up('teams', comp.teams),
    ...up(
      'media',
      items.map((i) => i.row),
    ),
    ...up('seasons', comp.seasons),
    ...up('season_teams', comp.seasonTeams, ['season_id', 'team_id']),
    ...up('match_days', comp.matchDays),
    ...up('matches', comp.matches),
    ...up('match_results', comp.matchResults, ['match_id', 'kind']),
    ...up('ladder_adjustments', comp.ladderAdjustments),
    ...up('pages', content.pages),
    ...up('posts', content.posts),
    ...up('menu_items', content.menuItems),
    ...up('redirects', redirects, ['from_path'], { where: `"redirects"."source" = 'wp-import'`, update: ['to_path', 'status'] }),
    // Prune rows a previous run imported into these seasons that SportsPress no longer has.
    ...(seasonIds
      ? [
          `DELETE FROM "matches" WHERE "season_id" IN (${seasonIds}) AND "id" NOT IN (${notIn(comp.matches.map((m) => m.id))});`,
          `DELETE FROM "match_days" WHERE "season_id" IN (${seasonIds}) AND "id" NOT IN (${notIn(comp.matchDays.map((m) => m.id))});`,
          `DELETE FROM "season_teams" WHERE "season_id" IN (${seasonIds}) AND ("season_id" || ':' || "team_id") NOT IN (${notIn(comp.seasonTeams.map((s) => `${s.season_id}:${s.team_id}`))});`,
          `DELETE FROM "ladder_adjustments" WHERE "reason" = ${sqlLiteral(RECONCILIATION_REASON)} AND "season_id" IN (${seasonIds}) AND "id" NOT IN (${notIn(comp.ladderAdjustments.map((a) => a.id))});`,
        ]
      : []),
  ]
  const files = chunkStatements(stmts)
  const sqlDir = join(CACHE_DIR, 'sql')
  await rm(sqlDir, { recursive: true, force: true })
  await mkdir(sqlDir, { recursive: true })
  const paths: string[] = []
  for (const [i, f] of files.entries()) {
    const p = join(sqlDir, `import-${String(i + 1).padStart(3, '0')}.sql`)
    await writeFile(p, f)
    paths.push(p)
  }
  console.info(`SQL: ${stmts.length} statements in ${paths.length} files under ${sqlDir}`)

  const r2Results: Record<string, unknown> = {}
  for (const t of targets) {
    if (t.name === 'local') {
      console.info('Applying migrations to the local D1…')
      await run(['d1', 'migrations', 'apply', 'DB', '--local'], { quiet: true })
    }
    console.info(`Applying SQL to ${t.name} D1…`)
    for (const p of paths) {
      process.stdout.write(`  ${p.split('/').at(-1)}: `)
      await run(['d1', 'execute', 'DB', ...t.d1, '--yes', '--file', p], { quiet: true })
      process.stdout.write('ok\n')
    }
    if (!flags['skip-media'] && !flags['skip-r2'])
      r2Results[t.name] = await uploadR2(
        t,
        items.flatMap((i) => i.objects),
        Number(flags.concurrency) || 6,
      )
  }

  const report = {
    at: new Date().toISOString(),
    targets: targets.map((t) => t.name),
    source: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, (v as unknown[]).length])),
    rows: {
      venues: comp.venues.length,
      courts: comp.courts.length,
      leagues: comp.leagues.length,
      teams: comp.teams.length,
      seasons: comp.seasons.length,
      season_teams: comp.seasonTeams.length,
      match_days: comp.matchDays.length,
      matches: comp.matches.length,
      match_results: comp.matchResults.length,
      ladder_adjustments: comp.ladderAdjustments.length,
      media: items.length,
      pages: content.pages.length,
      posts: content.posts.length,
      menu_items: content.menuItems.length,
      redirects: redirects.length,
    },
    competition: comp.report,
    content: content.report,
    media: {
      library: library.size,
      orphans: orphans.size,
      imported: items.length,
      objects: items.reduce((n, i) => n + i.objects.length, 0),
      failures: mediaFailures,
      unresolvedUploadLinks: [...content.unresolvedUploads],
      r2: r2Results,
    },
  }
  await writeFile(join(CACHE_DIR, 'report.json'), JSON.stringify(report, null, 2))
  printReport(report)
}

function printReport(r: {
  rows: Record<string, number>
  competition: ReturnType<typeof buildCompetition>['report']
  content: ReturnType<typeof buildContent>['report']
  media: {
    library: number
    orphans: number
    imported: number
    objects: number
    failures: string[]
    unresolvedUploadLinks: string[]
    r2: Record<string, unknown>
  }
}) {
  const c = r.competition
  console.info('\n══ Import report ══')
  console.info(
    'Rows:',
    Object.entries(r.rows)
      .map(([k, v]) => `${k} ${v}`)
      .join(', '),
  )
  console.info(`Leagues not mapped (no events; old 2020–23 leagues): ${c.unmappedLeagues.join('; ') || 'none'}`)
  if (c.unmappedSeasons.length) console.info(`Seasons not mapped: ${c.unmappedSeasons.join('; ')}`)
  if (c.unmappedCourts.length) console.info(`Courts not mapped: ${c.unmappedCourts.join('; ')}`)
  if (c.skippedEvents.length) console.info(`Events skipped/flagged: ${c.skippedEvents.join('; ')}`)
  console.info(`Bye events (not stored; byes are derived): ${c.byeEvents}. Skip days: ${c.skipDays}. Forfeits: ${c.forfeits}.`)
  console.info(`Results whose set scores disagree with SportsPress sets/points (set scores dropped, totals kept): ${c.setScoresDropped}`)
  if (c.unresolvedNames.length) console.info(`Team names in titles not matched to a team (kept as labels): ${c.unresolvedNames.join('; ')}`)
  console.info('Ladder reconciliation:')
  for (const l of c.ladders) {
    if (l.outcomeModelAgrees !== null)
      console.info(
        `  ${l.season}: table rebuilt from SportsPress outcomes ${l.outcomeModelAgrees ? 'agrees' : 'DISAGREES'} with ${l.table}`,
      )
    if (!l.diffs.length) console.info(`  ${l.season} vs ${l.table}: matches`)
    else if (l.withFinalsMatches) console.info(`  ${l.season} vs ${l.table}: differs only because SportsPress counts finals; no adjustment`)
    else {
      console.info(`  ${l.season} vs ${l.table}: ${l.diffs.length} teams differ, ${l.adjustments} adjustments`)
      for (const d of l.diffs)
        console.info(
          `    ${d.team}: pts ${d.pointsDiff >= 0 ? '+' : ''}${d.pointsDiff}; ${d.fields.map(([f, sp, ours]) => `${f} SP ${sp} / ours ${ours}`).join(', ')}`,
        )
    }
  }
  console.info(`  No SportsPress table (compared with the table rebuilt from outcomes): ${c.seasonsWithoutTable.join(', ') || 'none'}`)
  console.info(
    `Pages ${r.content.pages}, posts ${r.content.posts}; league-data pages turned into redirects: ${r.content.leaguePages.length}`,
  )
  if (r.content.oversizeBodies.length) console.info(`Large bodies: ${r.content.oversizeBodies.join(', ')}`)
  console.info('Redirects by kind:', JSON.stringify(r.content.redirects))
  const m = r.media
  console.info(
    `Media: ${m.imported} imported (${m.library} library + ${m.orphans} orphan links referenced), ${m.objects} R2 objects, ${m.failures.length} failed`,
  )
  if (m.failures.length) console.info(`  failed: ${m.failures.slice(0, 20).join('; ')}${m.failures.length > 20 ? ' …' : ''}`)
  if (m.unresolvedUploadLinks.length) console.info(`  upload links left unrewritten: ${m.unresolvedUploadLinks.length}`)
  console.info('R2:', JSON.stringify(m.r2))
  console.info(`Full report: scripts/.cache/report.json`)
}

await main()
