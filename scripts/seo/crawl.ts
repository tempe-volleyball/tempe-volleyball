// SEO checks against a running copy of the site (docs/public-site.md "Checking a build"). Node only; used by
// scripts/seo/check.ts and the old-URL test (scripts/seo/old-urls.test.ts).
//
//  - pageReport(): one page's status, H1s, heading order, title, description, canonical, og:image and JSON-LD.
//  - oldUrls(): every old WordPress URL to check, from PLAN.md's "Old URL patterns to redirect" (with real slugs
//    from the importer's cache) plus every page and post link the old site had.
//  - followOnce(): where an old URL goes: it must be one 301 to a page that answers 200.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const CACHE = join(ROOT, 'scripts', '.cache')

export const CANONICAL_ORIGIN = 'https://www.tempevb.com'

export type PageReport = {
  url: string
  status: number
  problems: string[]
  title: string
  h1s: number
  jsonLdTypes: string[]
}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tag)?.[1]

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

/** The checks for one HTML page, as served by `base` for the canonical `path`. */
export function checkHtml(path: string, html: string): Omit<PageReport, 'url' | 'status'> {
  const problems: string[] = []
  const head = html.slice(0, html.indexOf('</head>'))
  const body = html.slice(html.indexOf('<body'))
  const title = decode(/<title>([^<]*)<\/title>/i.exec(head)?.[1] ?? '')
  if (!title) problems.push('no <title>')
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0])
  const meta = (key: string) => metas.find((m) => attr(m, 'name') === key || attr(m, 'property') === key)
  const description = meta('description') && attr(meta('description')!, 'content')
  if (!description) problems.push('no meta description')
  else if (description.length < 50) problems.push(`short meta description (${description.length})`)
  const canonical = /<link\b[^>]*rel="canonical"[^>]*>/i.exec(head)?.[0]
  const href = canonical && attr(canonical, 'href')
  if (!href) problems.push('no canonical')
  else if (href !== new URL(path, CANONICAL_ORIGIN).href) problems.push(`canonical is ${href}`)
  for (const k of ['og:title', 'og:description', 'og:image', 'og:url', 'twitter:card']) if (!meta(k)) problems.push(`no ${k}`)

  const headings = [...body.matchAll(/<h([1-6])\b/gi)].map((m) => Number(m[1]))
  const h1s = headings.filter((h) => h === 1).length
  if (h1s !== 1) problems.push(`${h1s} <h1>`)
  if (headings[0] !== undefined && headings[0] !== 1) problems.push(`first heading is h${headings[0]}`)
  for (let i = 1; i < headings.length; i++)
    if (headings[i]! > headings[i - 1]! + 1) problems.push(`heading jumps h${headings[i - 1]} -> h${headings[i]}`)

  const jsonLdTypes: string[] = []
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]!) as { '@graph'?: { '@type': string }[]; '@type'?: string; '@context'?: string }
      if (data['@context'] !== 'https://schema.org') problems.push('JSON-LD without the schema.org context')
      for (const n of data['@graph'] ?? [data as { '@type': string }]) {
        if (!n['@type']) problems.push('JSON-LD node without @type')
        else jsonLdTypes.push(n['@type'])
      }
    } catch {
      problems.push('JSON-LD that does not parse')
    }
  }
  if (!jsonLdTypes.includes('SportsOrganization')) problems.push('no SportsOrganization JSON-LD')
  return { problems: [...new Set(problems)], title, h1s, jsonLdTypes }
}

/** Fetches `path` from `base` (no redirects followed) and checks it. */
export async function pageReport(base: string, path: string): Promise<PageReport> {
  const res = await fetch(new URL(path, base), { redirect: 'manual' })
  const url = new URL(path, base).href
  if (res.status !== 200) return { url, status: res.status, problems: [`status ${res.status}`], title: '', h1s: 0, jsonLdTypes: [] }
  return { url, status: res.status, ...checkHtml(path, await res.text()) }
}

/** The paths in a sitemap (absolute www.tempevb.com URLs, as the site writes them). */
export function sitemapPaths(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(decode(m[1]!)).pathname)
}

type Linked = { link: string; slug: string }

const cached = async (name: string): Promise<Linked[]> => {
  try {
    return JSON.parse(await readFile(join(CACHE, `${name}.json`), 'utf8')) as Linked[]
  } catch {
    return []
  }
}

/**
 * Every old URL to check: the patterns and page slugs in PLAN.md's "Old URL patterns to redirect" (patterns filled
 * with every slug the importer's cache has), and every old page and post link. Paths keep WordPress's trailing slash.
 */
export async function oldUrls(): Promise<{ patterns: string[]; urls: string[] }> {
  const plan = await readFile(join(ROOT, 'PLAN.md'), 'utf8')
  const para = /\*\*Old URL patterns to redirect:\*\*([\s\S]*?)(?:\n\n|$)/.exec(plan)?.[1] ?? ''
  const patterns = [...para.matchAll(/`([^`]+)`/g)].map((m) => m[1]!)
  if (patterns.length === 0) throw new Error('PLAN.md has no "Old URL patterns to redirect" list')
  const sources: Record<string, string> = {
    team: 'sportspress_v2_teams',
    table: 'sportspress_v2_tables',
    event: 'sportspress_v2_events',
    calendar: 'sportspress_v2_calendars',
  }
  const urls = new Set<string>()
  for (const p of patterns) {
    const m = /^\/([a-z]+)\/<slug>\/$/.exec(p)
    if (!m) {
      urls.add(p)
      continue
    }
    const source = sources[m[1]!]
    if (!source) throw new Error(`Don't know where the slugs for ${p} come from`)
    const rows = await cached(source)
    if (rows.length === 0) throw new Error(`No ${source} in scripts/.cache: run npm run import:wp first`)
    for (const r of rows) urls.add(new URL(r.link).pathname)
  }
  for (const name of ['wp_v2_pages', 'wp_v2_posts']) for (const r of await cached(name)) urls.add(new URL(r.link).pathname)
  return { patterns, urls: [...urls].toSorted() }
}

export type Hop = { from: string; status: number; location: string | null; finalStatus: number | null }

/** Requests `path` without following redirects, then its target once. */
export async function followOnce(base: string, path: string): Promise<Hop> {
  const res = await fetch(new URL(path, base), { redirect: 'manual' })
  const location = res.headers.get('location')
  if (res.status < 300 || res.status >= 400 || !location) return { from: path, status: res.status, location, finalStatus: null }
  const target = new URL(location, base)
  const next = await fetch(new URL(target.pathname + target.search, base), { redirect: 'manual' })
  return { from: path, status: res.status, location, finalStatus: next.status }
}
