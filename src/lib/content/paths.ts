import { LEAGUES_ROUTE, NEWS_ROUTE, normalisePath } from '../wp-import/routes'

// URL rules for editable pages and news posts, and the redirect a path change leaves behind.

export { normalisePath }

/** Path prefixes owned by routes, so no page may live at or under them. */
export const RESERVED_PREFIXES = [
  '/admin',
  '/api',
  '/media',
  '/_astro',
  '/_image',
  '/cdn-cgi',
  LEAGUES_ROUTE,
  NEWS_ROUTE,
  // Programme pages by kind (src/lib/programmes.ts PROGRAMME_PATH_PREFIX; /leagues is LEAGUES_ROUTE).
  '/training',
  '/programs',
  '/events',
] as const
/** Exact paths owned by routes or files. */
export const RESERVED_PATHS = [
  '/enrol/offer',
  '/search',
  '/robots.txt',
  '/sitemap.xml',
  '/sitemap-index.xml',
  '/favicon.ico',
  '/favicon.svg',
  '/rss.xml',
] as const

/**
 * Routes whose editable intro is a published page at the very same path (docs/admin.md §3.13): /enrol, and the
 * kind index pages /training, /programs and /events. A page may live exactly there (not under the prefixes), and
 * no category may take these slugs, since the route would hide its landing page.
 */
export const INTRO_PAGE_PATHS = ['/enrol', '/training', '/programs', '/events'] as const

export const isIntroPagePath = (path: string) => (INTRO_PAGE_PATHS as readonly string[]).includes(path)

/** Prefixes the trailing-slash redirect leaves alone: APIs, files, the admin app and Cloudflare's own paths. */
const SLASH_EXEMPT = ['/api', '/media', '/admin', '/_astro', '/_image', '/cdn-cgi'] as const

const underPrefix = (path: string, prefixes: readonly string[]) => prefixes.some((p) => path === p || path.startsWith(`${p}/`))

/**
 * Where a request path with a trailing slash should be sent: the same path without it ("/contact/" -> "/contact"),
 * as stored in pages.path and redirects.from_path. Every old WordPress URL ends in a slash, so this gives each page
 * one URL. null when there's nothing to do: no trailing slash, "/", or a path under SLASH_EXEMPT. Repeated slashes
 * collapse too, so "//evil.example/" becomes "/evil.example", never a protocol-relative Location.
 */
export function trailingSlashTarget(pathname: string): string | null {
  if (pathname.length <= 1 || !pathname.endsWith('/')) return null
  const target = normalisePath(pathname)
  if (/^\/[/\\]/.test(target) || underPrefix(target, SLASH_EXEMPT)) return null
  return target
}

const SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_PATH_LENGTH = 200
export const MAX_SLUG_LENGTH = 100

/** "Junior Dev Program (JDP)!" -> "junior-dev-program-jdp". */
export function slugify(text: string, max = MAX_SLUG_LENGTH): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
}

export type PathCheck = { ok: true; path: string } | { ok: false; message: string }

/**
 * Validates a page path typed in the admin. Accepts "about", "/About/", "/about/rules"; returns the stored form
 * ("/about/rules"): leading slash, lower case, no trailing slash, segments of a–z, 0–9 and single hyphens, at most
 * three levels deep. "/" is the home page.
 */
export function checkPagePath(input: string): PathCheck {
  const raw = input.trim()
  if (!raw) return { ok: false, message: 'Enter a path, like /about.' }
  if (/[?#]/.test(raw)) return { ok: false, message: 'A path can’t contain ? or #.' }
  const path = normalisePath(raw.toLowerCase())
  if (path === '/') return { ok: true, path }
  if (path.length > MAX_PATH_LENGTH) return { ok: false, message: `Keep the path under ${MAX_PATH_LENGTH} characters.` }
  const segments = path.slice(1).split('/')
  if (segments.length > 3) return { ok: false, message: 'Paths can be at most three levels deep.' }
  if (!segments.every((s) => SEGMENT.test(s)))
    return { ok: false, message: 'Use lower-case letters, numbers and single hyphens between slashes, like /about/rules.' }
  if ((RESERVED_PATHS as readonly string[]).includes(path)) return { ok: false, message: `${path} is used by the site itself.` }
  if (isIntroPagePath(path)) return { ok: true, path }
  const reserved = RESERVED_PREFIXES.find((p) => path === p || path.startsWith(`${p}/`))
  if (reserved) return { ok: false, message: `Paths under ${reserved} are used by the site itself.` }
  return { ok: true, path }
}

export type SlugCheck = { ok: true; slug: string } | { ok: false; message: string }

/** Validates a news post slug ("Season starts!" is not one; "season-starts" is). */
export function checkSlug(input: string): SlugCheck {
  const slug = input.trim().toLowerCase()
  if (!slug) return { ok: false, message: 'Enter a slug, like season-starts.' }
  if (slug.length > MAX_SLUG_LENGTH) return { ok: false, message: `Keep the slug under ${MAX_SLUG_LENGTH} characters.` }
  if (!SEGMENT.test(slug)) return { ok: false, message: 'Use lower-case letters, numbers and single hyphens, like season-starts.' }
  return { ok: true, slug }
}

/**
 * What to do to the redirects table when published content moves from `from` to `to`:
 *  - add (or repoint) `from` -> `to` as a 301;
 *  - repoint redirects that led to `from`, so there are no chains;
 *  - drop any redirect *from* `to`, since a page lives there now (this also breaks a would-be loop when a page is
 *    moved back to an old path).
 * Returns null when nothing moved.
 */
export function planMove(fromPath: string, toPath: string): { from: string; to: string } | null {
  const from = normalisePath(fromPath)
  const to = normalisePath(toPath)
  return from === to ? null : { from, to }
}
