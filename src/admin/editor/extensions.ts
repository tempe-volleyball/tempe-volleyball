import { Mark, Node, mergeAttributes, type Extensions } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { TableKit } from '@tiptap/extension-table'
import TextAlign from '@tiptap/extension-text-align'
import StarterKit from '@tiptap/starter-kit'
import { IMAGE_ALIGNS, IMAGE_SIZES, MAX_CAPTION_LENGTH, safeEmbedSrc } from '../../lib/content/render'

// The editor's schema. It must stay in step with src/lib/content/render.ts, which turns the saved JSON into the
// public HTML on the server: every node and mark here has a case there, and anything else is dropped on save. The
// page editor adds the data blocks (data-blocks.ts), which render at view time from live data. What an imported
// page's HTML loses on its first save is listed by src/lib/content/import-check.ts, which must match this file.

/** The <img> a parse rule matched: the element itself, or the one inside a <figure> or <a>. */
const imgOf = (el: HTMLElement): HTMLElement | null => (el.tagName === 'IMG' ? el : el.querySelector('img[src]'))

const imgAttrs = (img: HTMLElement) => ({
  src: img.getAttribute('src'),
  alt: img.getAttribute('alt'),
  title: img.getAttribute('title'),
  width: img.getAttribute('width'),
  height: img.getAttribute('height'),
})

const classOf = (el: HTMLElement, map: Record<string, string>) => {
  for (const [cls, value] of Object.entries(map)) if (el.classList.contains(cls)) return value
  return null
}

/** Our figure-* classes, and WordPress's align* ones (imported pages). */
const ALIGN_CLASSES: Record<string, string> = Object.fromEntries([
  ...IMAGE_ALIGNS.map((a) => [`figure-${a}`, a]),
  ['aligncenter', 'center'],
  ['alignleft', 'left'],
  ['alignright', 'right'],
])
const SIZE_CLASSES: Record<string, string> = Object.fromEntries(IMAGE_SIZES.map((s) => [`figure-${s}`, s]))

/**
 * Images keep srcset/sizes so library images stay responsive, plus a caption, a size, an alignment and a link
 * (image settings; render.ts writes them as a <figure>). Imported <figure>s with a <figcaption>, and images inside
 * a link, parse into the same attributes, so a first save keeps them.
 */
export const ResponsiveImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      srcset: {
        default: null,
        parseHTML: (el) => imgOf(el)?.getAttribute('srcset') ?? null,
        renderHTML: (a) => (a.srcset ? { srcset: a.srcset } : {}),
      },
      sizes: {
        default: null,
        parseHTML: (el) => imgOf(el)?.getAttribute('sizes') ?? null,
        renderHTML: (a) => (a.sizes ? { sizes: a.sizes } : {}),
      },
      caption: {
        default: null,
        rendered: false,
        parseHTML: (el) =>
          el.tagName === 'FIGURE' ? el.querySelector('figcaption')?.textContent?.trim().slice(0, MAX_CAPTION_LENGTH) || null : null,
      },
      align: { default: null, rendered: false, parseHTML: (el) => (el.tagName === 'FIGURE' ? classOf(el, ALIGN_CLASSES) : null) },
      size: { default: null, rendered: false, parseHTML: (el) => (el.tagName === 'FIGURE' ? classOf(el, SIZE_CLASSES) : null) },
      href: {
        default: null,
        rendered: false,
        parseHTML: (el) =>
          el.tagName === 'A'
            ? el.getAttribute('href')
            : el.tagName === 'FIGURE'
              ? (el.getAttribute('data-href') ?? el.querySelector('a[href]')?.getAttribute('href') ?? null)
              : null,
      },
    }
  },
  parseHTML() {
    return [
      { tag: 'figure', getAttrs: (el) => (imgOf(el) ? imgAttrs(imgOf(el)!) : false) },
      {
        // <a href><img></a> (nothing else inside): the image with a link. Ahead of the link mark's rule.
        tag: 'a[href]',
        priority: 1000,
        getAttrs: (el) => {
          const only = el.children.length === 1 && el.firstElementChild?.tagName === 'IMG' && !el.textContent?.trim()
          return only ? imgAttrs(el.firstElementChild as HTMLElement) : false
        },
      },
      { tag: 'img[src]:not([src^="data:"])' },
    ]
  },
  renderHTML({ node, HTMLAttributes }) {
    const img: [string, Record<string, unknown>] = ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)]
    const { caption, align, size, href } = node.attrs as Record<string, string | null>
    if (!caption && !align && !size && !href) return img
    const cls = ['figure', align ? `figure-${align}` : '', size ? `figure-${size}` : ''].filter(Boolean).join(' ')
    // No <a> in the editor (a click would follow it); data-href carries the link through copy and paste.
    return ['figure', { class: cls, ...(href ? { 'data-href': href } : {}) }, img, ...(caption ? [['figcaption', {}, caption]] : [])]
  },
}).configure({ inline: false, allowBase64: false })

/** Links, plus `variant: 'button'` (shown as a button; imported WordPress buttons parse into it). */
const ButtonLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      variant: {
        default: null,
        parseHTML: (el) => (el.classList.contains('button') || el.classList.contains('wp-block-button__link') ? 'button' : null),
        renderHTML: (a) => (a.variant === 'button' ? { class: 'button' } : {}),
      },
    }
  },
})

const simpleMark = (name: string, tag: string, attrs: Record<string, string> = {}, match?: string) =>
  Mark.create({
    name,
    parseHTML: () => [{ tag: match ?? tag }],
    renderHTML: ({ HTMLAttributes }) => [tag, mergeAttributes(attrs, HTMLAttributes), 0],
  })

/** Sub/superscript (render.ts has them) and text only screen readers read (the importer adds it to vague links). */
export const Subscript = simpleMark('subscript', 'sub')
export const Superscript = simpleMark('superscript', 'sup')
export const SrOnly = simpleMark('srOnly', 'span', { class: 'sr-only', title: 'Only read out by screen readers' }, 'span.sr-only')

/** An iframe from an allowed host (YouTube, Vimeo, Google Maps/Docs). */
export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      title: { default: null },
      width: { default: null },
      height: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'iframe', getAttrs: (el) => (safeEmbedSrc((el as HTMLElement).getAttribute('src')) ? null : false) }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { class: 'embed' }, ['iframe', mergeAttributes(HTMLAttributes, { loading: 'lazy', allowfullscreen: 'true' })]]
  },
})

export const editorExtensions = (): Extensions => [
  StarterKit.configure({
    // H1 is the page title; imported H1s are kept and shown as H2 on the site (render.ts). The toolbar offers 2–4.
    // Imported H5/H6 stay headings (render.ts keeps up to H6).
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    codeBlock: false,
    code: false,
    link: false,
  }),
  ButtonLink.configure({ openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener', target: null } }),
  Subscript,
  Superscript,
  SrOnly,
  ResponsiveImage,
  TableKit.configure({ table: { resizable: false } }),
  TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right'] }),
  Embed,
]

/** Turns a pasted YouTube/Vimeo link or a whole <iframe> snippet into an embed URL, or null if it isn't allowed. */
export function embedUrl(input: string): string | null {
  const s = input.trim()
  const fromIframe = /<iframe[^>]+src=["']([^"']+)["']/i.exec(s)?.[1]
  const raw = (fromIframe ?? s).replaceAll('&amp;', '&')
  try {
    const u = new URL(raw)
    if (u.hostname === 'youtu.be') return safeEmbedSrc(`https://www.youtube-nocookie.com/embed/${u.pathname.slice(1)}`)
    if (/(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === '/watch' && u.searchParams.get('v'))
      return safeEmbedSrc(`https://www.youtube-nocookie.com/embed/${u.searchParams.get('v')}`)
    if (u.hostname === 'vimeo.com' && /^\/\d+/.test(u.pathname)) return safeEmbedSrc(`https://player.vimeo.com/video${u.pathname}`)
  } catch {
    return null
  }
  return safeEmbedSrc(raw)
}
