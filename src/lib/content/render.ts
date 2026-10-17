// Renders the rich-text editor's JSON (TipTap / ProseMirror documents) to HTML for the public site.
//
// This is the server-side sanitiser: the server never trusts HTML from the browser. It walks the editor's JSON and
// writes HTML itself, from an allowlist of node types, marks and attributes. Text and attribute values are always
// escaped, URLs are checked by scheme, and anything unknown is dropped (its text content is kept). That makes it
// safe by construction and cheap: one linear pass, no HTML parser, well inside the Worker's 10 ms CPU budget.
//
// Node and mark names are TipTap 3's (StarterKit + Image + TableKit + TextAlign, and our own `embed` for iframes).
// The admin editor (src/admin/editor/) registers exactly these.

export type JsonMark = { type: string; attrs?: Record<string, unknown> }
export type JsonNode = { type: string; attrs?: Record<string, unknown>; content?: JsonNode[]; text?: string; marks?: JsonMark[] }

/** Limits that keep a single save cheap to validate and render. */
export const BODY_LIMITS = { maxJsonBytes: 600_000, maxNodes: 30_000, maxDepth: 40 } as const

/** Hosts an `embed` (iframe) may load. Matches the importer's allowlist (scripts/wp/content.ts). */
export const EMBED_HOSTS = [
  'www.youtube.com',
  'www.youtube-nocookie.com',
  'player.vimeo.com',
  'www.google.com',
  'docs.google.com',
  'maps.google.com',
] as const

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!)

// Control characters and whitespace browsers ignore inside a URL scheme ("java\tscript:").
// oxlint-disable-next-line no-control-regex
const URL_JUNK = /[\u0000- \u007f-\u009f]/g

/**
 * A link target that's safe in href: http(s), mailto, tel, a root-relative path, a fragment or a query. Returns
 * null for anything else (javascript:, data:, protocol-relative "//host", …).
 */
export function safeHref(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v || v.length > 2000) return null
  const probe = v.replace(URL_JUNK, '')
  if (probe.startsWith('//') || probe.startsWith('/\\')) return null
  if (/^[/#?]/.test(probe)) return v
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(probe)?.[1]?.toLowerCase()
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') return v
  return null
}

/** An image source: root-relative (our /media/ files) or https. */
export function safeImageSrc(value: unknown): string | null {
  const v = safeHref(value)
  if (!v) return null
  if (v.startsWith('/') && !v.startsWith('//')) return v
  return /^https:\/\//i.test(v) ? v : null
}

/** srcset: every candidate must be a safe image URL with a width or density descriptor. */
export function safeSrcset(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parts = value.split(',').map((p) => p.trim())
  const out: string[] = []
  for (const p of parts) {
    const m = /^(\S+)(?:\s+(\d+w|\d+(?:\.\d+)?x))?$/.exec(p)
    if (!m || !safeImageSrc(m[1])) return null
    out.push(m[2] ? `${m[1]} ${m[2]}` : m[1]!)
  }
  return out.join(', ')
}

const SIZES_RE = /^[\w\s().,:%-]{1,200}$/

/** An iframe src on one of EMBED_HOSTS, https only. */
export function safeEmbedSrc(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const u = new URL(value.trim())
    if (u.protocol !== 'https:' || !(EMBED_HOSTS as readonly string[]).includes(u.hostname)) return null
    return u.toString()
  } catch {
    return null
  }
}

const int = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : Number.NaN
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

const ALIGNS = new Set(['left', 'center', 'right', 'justify'])

type Attrs = [name: string, value: string | number | null | undefined | boolean][]

const attrs = (list: Attrs) => {
  let s = ''
  for (const [k, v] of list) {
    if (v === null || v === undefined || v === false) continue
    s += v === true ? ` ${k}` : ` ${k}="${escapeHtml(String(v))}"`
  }
  return s
}

const alignStyle = (a: Record<string, unknown> | undefined): Attrs => {
  const align = a?.textAlign
  return typeof align === 'string' && ALIGNS.has(align) && align !== 'left' ? [['style', `text-align: ${align}`]] : []
}

/** Opening and closing tags for a mark, or null to drop it (its text stays). */
function markTags(mark: JsonMark): [string, string] | null {
  switch (mark.type) {
    case 'bold':
      return ['<strong>', '</strong>']
    case 'italic':
      return ['<em>', '</em>']
    case 'underline':
      return ['<u>', '</u>']
    case 'strike':
      return ['<s>', '</s>']
    case 'code':
      return ['<code>', '</code>']
    case 'subscript':
      return ['<sub>', '</sub>']
    case 'superscript':
      return ['<sup>', '</sup>']
    case 'link': {
      const href = safeHref(mark.attrs?.href)
      if (!href) return null
      const external = /^https?:/i.test(href)
      const blank = mark.attrs?.target === '_blank'
      return [
        `<a${attrs([['href', href], ...(blank ? ([['target', '_blank']] as Attrs) : []), ['rel', blank || external ? 'noopener' : null]])}>`,
        '</a>',
      ]
    }
    default:
      return null
  }
}

function renderText(node: JsonNode): string {
  let html = escapeHtml(typeof node.text === 'string' ? node.text : '')
  // Marks wrap innermost-first in array order; links go outermost so one <a> spans the formatted text.
  const marks = (node.marks ?? []).toSorted((a, b) => Number(a.type === 'link') - Number(b.type === 'link'))
  for (const m of marks) {
    const tags = markTags(m)
    if (tags) html = tags[0] + html + tags[1]
  }
  return html
}

const children = (node: JsonNode, depth: number) => (node.content ?? []).map((c) => renderNode(c, depth + 1)).join('')

function cellAttrs(a: Record<string, unknown> | undefined): Attrs {
  const colspan = int(a?.colspan, 1, 50)
  const rowspan = int(a?.rowspan, 1, 500)
  return [
    ['colspan', colspan && colspan > 1 ? colspan : null],
    ['rowspan', rowspan && rowspan > 1 ? rowspan : null],
  ]
}

function renderNode(node: JsonNode, depth: number): string {
  if (!node || typeof node !== 'object' || depth > BODY_LIMITS.maxDepth) return ''
  const a = node.attrs
  switch (node.type) {
    case 'text':
      return renderText(node)
    case 'doc':
      return children(node, depth)
    case 'paragraph':
      return `<p${attrs(alignStyle(a))}>${children(node, depth)}</p>`
    case 'heading': {
      // H1 is the page title, so body headings start at H2.
      const level = Math.max(2, int(a?.level, 1, 6) ?? 2)
      return `<h${level}${attrs(alignStyle(a))}>${children(node, depth)}</h${level}>`
    }
    case 'bulletList':
      return `<ul>${children(node, depth)}</ul>`
    case 'orderedList': {
      const start = int(a?.start, 0, 100_000)
      return `<ol${attrs([['start', start !== null && start !== 1 ? start : null]])}>${children(node, depth)}</ol>`
    }
    case 'listItem':
      return `<li>${children(node, depth)}</li>`
    case 'blockquote':
      return `<blockquote>${children(node, depth)}</blockquote>`
    case 'codeBlock':
      return `<pre><code>${children(node, depth)}</code></pre>`
    case 'horizontalRule':
      return '<hr>'
    case 'hardBreak':
      return '<br>'
    case 'image': {
      const src = safeImageSrc(a?.src)
      if (!src) return ''
      const srcset = safeSrcset(a?.srcset)
      const sizes = typeof a?.sizes === 'string' && SIZES_RE.test(a.sizes) ? a.sizes : null
      return `<img${attrs([
        ['src', src],
        ['srcset', srcset],
        ['sizes', srcset ? (sizes ?? '(max-width: 800px) 100vw, 800px') : null],
        ['alt', typeof a?.alt === 'string' ? a.alt : ''],
        ['title', typeof a?.title === 'string' && a.title ? a.title : null],
        ['width', int(a?.width, 1, 10_000)],
        ['height', int(a?.height, 1, 10_000)],
        ['loading', 'lazy'],
        ['decoding', 'async'],
      ])}>`
    }
    case 'embed': {
      const src = safeEmbedSrc(a?.src)
      if (!src) return ''
      const title = typeof a?.title === 'string' && a.title.trim() ? a.title.trim() : 'Embedded content'
      return `<div class="embed"><iframe${attrs([
        ['src', src],
        ['title', title],
        ['width', int(a?.width, 1, 4000)],
        ['height', int(a?.height, 1, 4000)],
        ['loading', 'lazy'],
        ['allowfullscreen', true],
        ['referrerpolicy', 'strict-origin-when-cross-origin'],
      ])}></iframe></div>`
    }
    case 'table':
      return `<div class="table-wrap"><table><tbody>${children(node, depth)}</tbody></table></div>`
    case 'tableRow':
      return `<tr>${children(node, depth)}</tr>`
    case 'tableHeader':
      return `<th${attrs(cellAttrs(a))}>${children(node, depth)}</th>`
    case 'tableCell':
      return `<td${attrs(cellAttrs(a))}>${children(node, depth)}</td>`
    default:
      // Unknown node: keep its content, drop the wrapper.
      return children(node, depth)
  }
}

/** HTML for a list of top-level blocks (ContentBody.blocks). */
export const renderBlocks = (blocks: readonly JsonNode[]) => blocks.map((b) => renderNode(b, 1)).join('')

export type BodyCheck = { ok: true; blocks: JsonNode[] } | { ok: false; message: string }

/**
 * Checks that `blocks` is a list of editor nodes within BODY_LIMITS. Shape only: renderBlocks() then ignores
 * anything it doesn't know, so unknown types and attributes are harmless.
 */
export function checkBlocks(blocks: unknown): BodyCheck {
  if (!Array.isArray(blocks)) return { ok: false, message: 'The page body is missing.' }
  let nodes = 0
  const stack: [unknown, number][] = blocks.map((b) => [b, 1])
  while (stack.length) {
    const [n, depth] = stack.pop()!
    if (++nodes > BODY_LIMITS.maxNodes) return { ok: false, message: 'The page is too long. Split it into several pages.' }
    if (depth > BODY_LIMITS.maxDepth) return { ok: false, message: 'The page is nested too deeply.' }
    if (!n || typeof n !== 'object' || Array.isArray(n)) return { ok: false, message: 'The page body is malformed.' }
    const node = n as Record<string, unknown>
    if (typeof node.type !== 'string') return { ok: false, message: 'The page body is malformed.' }
    if (node.text !== undefined && typeof node.text !== 'string') return { ok: false, message: 'The page body is malformed.' }
    if (node.marks !== undefined && !Array.isArray(node.marks)) return { ok: false, message: 'The page body is malformed.' }
    if (node.attrs !== undefined && (typeof node.attrs !== 'object' || node.attrs === null || Array.isArray(node.attrs)))
      return { ok: false, message: 'The page body is malformed.' }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return { ok: false, message: 'The page body is malformed.' }
      for (const c of node.content) stack.push([c, depth + 1])
    }
  }
  return { ok: true, blocks: blocks as JsonNode[] }
}

/** Plain text of the blocks (for excerpts and search), whitespace collapsed. */
export function blocksText(blocks: readonly JsonNode[], max = 500): string {
  let out = ''
  const walk = (n: JsonNode) => {
    if (out.length > max) return
    if (typeof n.text === 'string') out += n.text
    for (const c of n.content ?? []) walk(c)
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem' || n.type === 'hardBreak') out += ' '
  }
  for (const b of blocks) walk(b)
  return out.replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Media ids referenced by /media/<id>/… URLs in HTML (image src/srcset, links to files). */
export function mediaIdsInHtml(html: string): Set<string> {
  const ids = new Set<string>()
  for (const m of html.matchAll(/\/media\/([0-9a-f-]{8,64})\//gi)) ids.add(m[1]!.toLowerCase())
  return ids
}
