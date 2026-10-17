// Render-time touches on stored page/post HTML (already sanitised by the importer or the editor). Pure string work,
// cheap enough for the Worker's CPU budget, and the output is edge-cached.
//
// - Heading levels never skip (an H4 straight after the page's H1 becomes an H2), and body H1s become H2s, since the
//   page title is the only H1 (Lighthouse heading-order, one H1 per page).
// - Vague link text ("here", "click here") gets the target page's title as visually hidden text, so screen readers
//   and search engines know where it goes (Lighthouse link-text).
// - Iframes get a title (Lighthouse frame-title), and images and iframes load lazily.

import { decodeEntities } from './wp-import/text'

const VAGUE = /^(?:click\s+)?(?:here|this|this link|link|more|read more)\.?$/i

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const stripTags = (s: string) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;| /g, ' ')
    .trim()

const hostOf = (href: string) => {
  try {
    return new URL(href).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

const normalise = (href: string) => {
  const p = href.replace(/[?#].*$/, '')
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

export type PrepareOptions = {
  /** Page titles by path ("/contact" -> "Contact"), for describing vague internal links. */
  titles?: Map<string, string>
  /** The heading level the body starts under (1 = the page's H1). */
  baseLevel?: number
}

/** Heading levels follow on from the page title without gaps; body H1s become H2s. */
export function fixHeadings(html: string, baseLevel = 1): string {
  // Open sections as [level in the source, level we output]; a heading nests one below the nearest shallower one.
  const open: [number, number][] = []
  let last = baseLevel + 1
  return html.replace(/<(\/?)h([1-6])(\b[^>]*)>/gi, (_m, close: string, level: string, rest: string) => {
    if (close) return `</h${last}>`
    const src = Number(level)
    while (open.length > 0 && open.at(-1)![0] >= src) open.pop()
    last = Math.min(6, open.length > 0 ? open.at(-1)![1] + 1 : baseLevel + 1)
    open.push([src, last])
    return `<h${last}${rest}>`
  })
}

/** Adds the target's title, visually hidden, to links that only say "here". */
export function describeVagueLinks(html: string, titles: Map<string, string>): string {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs: string, inner: string) => {
    if (!VAGUE.test(stripTags(inner))) return whole
    const href = /\bhref="([^"]*)"/i.exec(attrs)?.[1]
    if (!href) return whole
    let title: string | undefined
    if (href.startsWith('/')) title = titles.get(normalise(href))
    else if (/^https?:\/\//i.test(href)) title = hostOf(href)
    if (!title) return whole
    return `<a${attrs}>${inner}<span class="sr-only"> (${escapeHtml(title)})</span></a>`
  })
}

/** Titles iframes that have none, and lazy-loads images and iframes. */
export function fixEmbeds(html: string): string {
  return html
    .replace(/<iframe\b([^>]*)>/gi, (_m, attrs: string) => {
      let a = attrs
      if (!/\btitle=/i.test(a)) {
        const src = /\bsrc="([^"]*)"/i.exec(a)?.[1] ?? ''
        const what = /docs\.google\.com\/forms/i.test(src)
          ? 'Google Form'
          : /google\.[^/]+\/maps|maps\.google/i.test(src)
            ? 'Map'
            : 'Embedded content'
        a += ` title="${what}"`
      }
      if (!/\bloading=/i.test(a)) a += ' loading="lazy"'
      return `<iframe${a}>`
    })
    .replace(/<img\b([^>]*?)(\s*\/?)>/gi, (_m, attrs: string, end: string) => {
      let a = attrs
      if (!/\bloading=/i.test(a)) a += ' loading="lazy"'
      if (!/\bdecoding=/i.test(a)) a += ' decoding="async"'
      if (!/\balt=/i.test(a)) a += ' alt=""'
      return `<img${a}${end}>`
    })
}

export function prepareHtml(html: string, opts: PrepareOptions = {}): string {
  let out = fixHeadings(html, opts.baseLevel ?? 1)
  if (opts.titles) out = describeVagueLinks(out, opts.titles)
  return fixEmbeds(out)
}

export const DEFAULT_DESCRIPTION =
  'Social mixed volleyball leagues, junior and adult development programs and training in Tempe, Burwood and Five Dock, Sydney.'

/** Meta descriptions are cut to about this many characters, on a word boundary. */
export const META_DESCRIPTION_MAX = 155

// Elements whose text isn't content (iframes only hold "Loading…" fallback text).
const NON_TEXT = /<(script|style|iframe|noscript|template|svg|video|audio|object|select|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
// Tags that separate words: block elements and <br>. Inline tags (<strong>, <a> …) don't.
const BLOCK_TAG =
  /<\/?(?:address|article|aside|blockquote|br|caption|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|img|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi
// WordPress shortcodes the old site left in content ("[sp_table id=1]", "[/caption]").
const SHORTCODE = /\[\/?[a-z][\w-]*(?:\s[^\]]*)?\]/gi

/**
 * Plain text of stored HTML, for descriptions and excerpts: block boundaries and <br> become spaces (so
 * "<p>Contact<br>m@x.com</p>" reads "Contact m@x.com", not "Contactm@x.com"), entities are decoded and whitespace is
 * collapsed.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(NON_TEXT, ' ')
      .replace(BLOCK_TAG, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(SHORTCODE, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/** Shortens text to at most `max` characters on a word boundary, ending with "…". Whitespace is collapsed first. */
export function truncateWords(text: string, max = META_DESCRIPTION_MAX): string {
  const s = text.replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const space = cut.lastIndexOf(' ')
  // One very long "word" (a URL): cut it mid-word rather than return almost nothing.
  const head = space >= max * 0.6 ? cut.slice(0, space) : cut.slice(0, max - 1)
  return `${head.replace(/[\s,.;:–—-]+$/, '')}…`
}

/** A description (or excerpt) from HTML: its text, cut on a word boundary; null if it has no text. */
export function describeHtml(html: string, max = META_DESCRIPTION_MAX): string | null {
  const t = htmlToText(html)
  return t ? truncateWords(t, max) : null
}

/**
 * A usable meta description: the stored one unless it's empty, too short to say anything, or a placeholder the old
 * site leaked ("Loading…" from embedded Google Forms); otherwise the body's text (`bodyHtml`, if given); otherwise
 * the fallback. Whitespace is collapsed and it's cut to META_DESCRIPTION_MAX characters on a word boundary.
 */
export function metaDescription(
  stored: string | null | undefined,
  { bodyHtml, fallback = DEFAULT_DESCRIPTION }: { bodyHtml?: string | null; fallback?: string } = {},
): string {
  const usable = (s: string) => s.length >= 40 && !/^loading/i.test(s)
  const s = (stored ?? '').replace(/\s+/g, ' ').trim()
  if (usable(s)) return truncateWords(s)
  const body = bodyHtml ? htmlToText(bodyHtml) : ''
  return usable(body) ? truncateWords(body) : fallback
}

/** "<title> | Tempe Volleyball", without repeating the site name. Shouting titles ("CONTACT") are title-cased. */
export function documentTitle(title: string, site = 'Tempe Volleyball'): string {
  const t = title.trim()
  const pretty = t.length > 3 && t === t.toUpperCase() && /[A-Z]/.test(t) ? titleCase(t) : t
  return pretty.toLowerCase().includes(site.toLowerCase()) ? pretty : `${pretty} | ${site}`
}

const KEEP_UPPER = new Set(['TNL', 'FNL', 'SNL', 'SAL', 'TVSL', 'SSL', 'JDP', 'ADP', 'FAQ', 'VNSW', 'VB', 'USYD', 'NSW', 'YSVL', 'MNL'])
const SMALL = new Set(['and', 'or', 'of', 'the', 'a', 'an', 'in', 'on', 'for', 'to', 'at', 'by'])

function titleCase(s: string): string {
  return s
    .split(/(\s+|[()/&-])/)
    .map((w, i) => {
      if (!/[A-Z]/i.test(w)) return w
      const bare = w.replace(/[^A-Z]/gi, '').toUpperCase()
      if (KEEP_UPPER.has(bare)) return w
      const lower = w.toLowerCase()
      if (i > 0 && SMALL.has(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')
}

/** A post's date in Sydney, "8 December 2023". */
export const formatPostDate = (iso: string) =>
  new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso))
