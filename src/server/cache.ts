// Edge caching for public pages (Astro route caching with the Cloudflare provider, see astro.config.mjs).
//
// Every public response is tagged; when the admin publishes something it purges the tags that page could show.
// The header, sidebar and footer (menu and ladder widgets) appear on every page, so anything shown there purges
// SITE, which every cached page carries. Purging is a no-op where nothing is cached (dev, *.workers.dev, where
// Cloudflare doesn't cache Worker responses) and a failure never breaks the publish: the pages expire after
// PUBLIC_CACHE.maxAge anyway.

/** Tags. Kept short: Cloudflare allows 16 KB of Cache-Tag per response. */
export const tags = {
  /** On every public page: the menu and the ladder widgets in the sidebar and footer. */
  site: 'site',
  page: (path: string) => `page:${path}`,
  league: (slug: string) => `league:${slug}`,
  season: (slug: string) => `season:${slug}`,
  news: 'news',
  post: (slug: string) => `post:${slug}`,
  media: (id: string) => `media:${id}`,
} as const

/** Public HTML: fresh for 5 minutes at the edge, then served stale for up to a day while it revalidates. */
export const PUBLIC_CACHE = { maxAge: 300, swr: 86_400 } as const

/** Media files never change under a URL (a new upload gets a new id). */
export const MEDIA_CACHE = { maxAge: 31_536_000 } as const

export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** What Astro gives routes as `Astro.cache` / `context.cache` (a subset, so tests can pass a fake). */
export type RouteCache = {
  readonly enabled: boolean
  set(options: { maxAge?: number; swr?: number; tags?: string[] } | false): void
  invalidate(options: { tags?: string | string[]; path?: string }): Promise<void>
}

/** Marks a public response cacheable, tagged with SITE plus the page's own tags. */
export function cachePublic(cache: RouteCache, ...pageTags: string[]) {
  cache.set({ ...PUBLIC_CACHE, tags: [tags.site, ...pageTags] })
}

export type PurgeResult = { ok: boolean; tags: string[]; error?: string }

/** Purges tags, logging instead of throwing: a failed purge must not fail the admin's save. */
export async function purgeTags(cache: RouteCache, list: string[]): Promise<PurgeResult> {
  const unique = [...new Set(list)]
  if (!cache.enabled || unique.length === 0) return { ok: true, tags: unique }
  try {
    await cache.invalidate({ tags: unique })
    return { ok: true, tags: unique }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error('cache purge failed', { tags: unique, error })
    return { ok: false, tags: unique, error }
  }
}

/** A content page was published, edited or unpublished. Its path may also be in the menu, so purge SITE when it is. */
export const purgePage = (cache: RouteCache, path: string, { inMenu = false } = {}) =>
  purgeTags(cache, [tags.page(path), ...(inMenu ? [tags.site] : [])])

/** A season's draw or results changed: its own page, its league's page and every page with ladder widgets. */
export const purgeSeason = (cache: RouteCache, leagueSlug: string, seasonSlug: string) =>
  purgeTags(cache, [tags.season(seasonSlug), tags.league(leagueSlug), tags.site])

/** The menu (or anything else in the header and footer) changed. */
export const purgeSite = (cache: RouteCache) => purgeTags(cache, [tags.site])

/** A news post changed: the post and the news index (and the home page, should it list news later). */
export const purgePost = (cache: RouteCache, slug: string) => purgeTags(cache, [tags.post(slug), tags.news, tags.page('/')])

/** What an admin content change (src/server/content/*) needs purged. */
export type PurgeTargets = { tags?: string[] }

/** The outcome reported back to the admin: 'failed' means the live site may lag until the cache entry expires. */
export type PurgeOutcome = 'purged' | 'disabled' | 'failed' | 'nothing'

/** purgeTags() for the admin's content routes. Never throws. */
export async function purge(cache: RouteCache, targets: PurgeTargets): Promise<PurgeOutcome> {
  const list = targets.tags ?? []
  if (list.length === 0) return 'nothing'
  if (!cache.enabled) return 'disabled'
  return (await purgeTags(cache, list)).ok ? 'purged' : 'failed'
}
