import { Node, mergeAttributes, type Extensions } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import TextAlign from '@tiptap/extension-text-align'
import StarterKit from '@tiptap/starter-kit'
import { safeEmbedSrc } from '../../lib/content/render'

// The editor's schema. It must stay in step with src/lib/content/render.ts, which turns the saved JSON into the
// public HTML on the server: every node and mark here has a case there, and anything else is dropped on save. The
// page editor adds the data blocks (data-blocks.ts), which render at view time from live data.

/** Images keep srcset/sizes so library images stay responsive. */
const ResponsiveImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      srcset: { default: null, parseHTML: (el) => el.getAttribute('srcset'), renderHTML: (a) => (a.srcset ? { srcset: a.srcset } : {}) },
      sizes: { default: null, parseHTML: (el) => el.getAttribute('sizes'), renderHTML: (a) => (a.sizes ? { sizes: a.sizes } : {}) },
    }
  },
}).configure({ inline: false, allowBase64: false })

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
    heading: { levels: [1, 2, 3, 4] },
    codeBlock: false,
    code: false,
    link: { openOnClick: false, autolink: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener', target: null } },
  }),
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
