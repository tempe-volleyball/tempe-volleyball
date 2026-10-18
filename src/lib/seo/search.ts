import type { MenuItem } from '../content/menu'
import { normalisePath } from '../wp-import/routes'

// Site search (/search?q=) and the 404 page's "did you mean" links (docs/public-site.md "404 and search"). Pure:
// the query rules, ranking and suggestions; src/server/search.ts runs the one D1 batch.

export const SEARCH_ROUTE = '/search'
/** Longest query kept (the canonical URL drops the rest). */
export const MAX_QUERY = 80
/** At most this many words are matched (each must appear). */
export const MAX_TERMS = 5
export const MAX_RESULTS = 30

/** The canonical form of a ?q= value: whitespace collapsed, trimmed, at most MAX_QUERY characters. */
export const normaliseQuery = (q: string | null | undefined) => (q ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY).trim()

/** The canonical query string of /search: '?q=…' or ''. */
export function searchQueryString(params: URLSearchParams): string {
  const q = normaliseQuery(params.get('q'))
  return q ? `?${new URLSearchParams({ q })}` : ''
}

/** The words a query matches on: lower case, at least 2 characters, at most MAX_TERMS of them, no duplicates. */
export function searchTerms(q: string): string[] {
  const words = normaliseQuery(q)
    .toLowerCase()
    .split(/[^\p{L}\p{N}'’]+/u)
    .map((w) => w.replace(/^['’]+|['’]+$/g, ''))
    .filter((w) => w.length >= 2)
  return [...new Set(words)].slice(0, MAX_TERMS)
}

export type SearchHit = {
  kind: 'page' | 'programme' | 'category' | 'post'
  path: string
  title: string
  text: string
  date?: string | null
}

/** Ranks hits: every term in the title first, then some, then body-only matches; ties keep their kind order. */
export function rankHits(hits: SearchHit[], terms: string[]): SearchHit[] {
  const score = (h: SearchHit) => {
    const title = h.title.toLowerCase()
    const inTitle = terms.filter((t) => title.includes(t)).length
    return (inTitle === terms.length ? 100 : 0) + inTitle * 10
  }
  const seen = new Set<string>()
  return hits
    .map((h, i) => ({ h, i, s: score(h) }))
    .toSorted((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.h)
    .filter((h) => !seen.has(h.path) && seen.add(h.path))
    .slice(0, MAX_RESULTS)
}

const STOP = new Set(['the', 'and', 'of', 'for', 'in', 'a', 'to', 'page', 'html', 'php', 'www', 'wp', 'index'])

/** The words of a path, for the 404 page's search box and suggestions: "/thursday-night-fixtures/" -> ["thursday", "night", "fixtures"]. */
export function pathWords(path: string): string[] {
  let p = path
  try {
    p = decodeURIComponent(path)
  } catch {
    // keep as is
  }
  return normalisePath(p)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w) && !/^\d{5,}$/.test(w))
}

export type Candidate = { path: string; title: string }

/** Edit distance, capped (only short words are compared). */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]!
}

/**
 * Pages worth suggesting on a 404: candidates whose path or title shares words with the requested path (a typo of
 * a word counts too: "fixturs"), best first, at most `limit`. Nothing for a path with no usable words.
 */
export function suggestPages(path: string, candidates: Candidate[], limit = 5): Candidate[] {
  const words = pathWords(path)
  if (words.length === 0) return []
  const here = normalisePath(path)
  const seen = new Set<string>()
  return candidates
    .filter((c) => c.path.startsWith('/') && c.path !== here && !seen.has(c.path) && seen.add(c.path))
    .map((c) => {
      const theirs = new Set([...pathWords(c.path), ...c.title.toLowerCase().split(/[^a-z0-9]+/)].filter((w) => w.length >= 2))
      let score = 0
      for (const w of words) {
        if (theirs.has(w)) score += 3
        else if (w.length >= 4 && [...theirs].some((t) => t.length >= 4 && distance(w, t) <= 1)) score += 2
        else if (w.length >= 4 && [...theirs].some((t) => t.length >= 4 && (t.startsWith(w) || w.startsWith(t)))) score += 1
      }
      return { c, score }
    })
    .filter((x) => x.score > 0)
    .toSorted((a, b) => b.score - a.score || a.c.path.length - b.c.path.length)
    .slice(0, limit)
    .map((x) => x.c)
}

/** The site's own links in the menu (both levels), as suggestion candidates. */
export const menuCandidates = (menu: MenuItem[]): Candidate[] =>
  menu.flatMap((m) => [
    ...(m.href && !m.external ? [{ path: m.href.replace(/#.*$/, ''), title: m.label }] : []),
    ...menuCandidates(m.children),
  ])
