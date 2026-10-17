// Polite, cached fetching of the old site's public REST API. Raw JSON is cached under scripts/.cache/ so reruns
// don't hit the live site; pass --refresh to the importer to refetch.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const SITE = 'https://www.tempevb.com'
export const CACHE_DIR = join(import.meta.dirname, '..', '.cache')

const DELAY_MS = 400
const UA = 'tempevb-rebuild-importer/1.0 (+https://github.com/tempe-volleyball/tempe-volleyball)'

let last = 0
async function polite<T>(fn: () => Promise<T>): Promise<T> {
  const wait = last + DELAY_MS - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  try {
    return await fn()
  } finally {
    last = Date.now()
  }
}

async function getWithRetry(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await polite(() => fetch(url, { headers: { 'user-agent': UA, accept: 'application/json, */*' } }))
    if (res.ok || attempt >= 3 || (res.status < 500 && res.status !== 429)) return res
    await new Promise((r) => setTimeout(r, 2000 * attempt))
  }
}

/** Every item of a paginated WP REST collection, e.g. `wp/v2/pages` or `sportspress/v2/events`. */
export async function fetchCollection<T = unknown>(route: string, opts: { refresh?: boolean; query?: string } = {}): Promise<T[]> {
  const file = join(CACHE_DIR, `${route.replaceAll('/', '_')}.json`)
  if (!opts.refresh && existsSync(file)) return JSON.parse(await readFile(file, 'utf8')) as T[]
  const all: T[] = []
  for (let page = 1, total = 1; page <= total; page++) {
    const url = `${SITE}/wp-json/${route}?per_page=100&page=${page}${opts.query ? `&${opts.query}` : ''}`
    const res = await getWithRetry(url)
    if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`)
    total = Number(res.headers.get('x-wp-totalpages') ?? '1') || 1
    all.push(...((await res.json()) as T[]))
    process.stdout.write(`  fetched ${route} page ${page}/${total}\n`)
  }
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(file, JSON.stringify(all, null, 1))
  return all
}

/** A binary file (media original), cached under scripts/.cache/files/. Returns null on 404. */
export async function fetchFile(url: string, opts: { refresh?: boolean } = {}): Promise<Buffer | null> {
  const u = new URL(url)
  const file = join(CACHE_DIR, 'files', u.hostname, decodeURIComponent(u.pathname))
  if (!opts.refresh && existsSync(file)) return readFile(file)
  const res = await getWithRetry(url)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, buf)
  return buf
}
