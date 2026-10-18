// Tiny builders for TipTap JSON, so the drafted content in drafts.ts reads like text and is stored exactly as the page
// editor would store it: { blocks, html } with html from renderBlocks() (src/lib/content/render.ts). Inline text takes
// **bold** and [label](href).

import {
  DEFAULT_CONTACT_FORM_ATTRS,
  DEFAULT_PROGRAMME_LIST_ATTRS,
  type ContactFormAttrs,
  type ProgrammeListAttrs,
} from '../../src/lib/content/blocks'
import { normaliseDataBlocks } from '../../src/lib/content/data-blocks'
import { checkBlocks, renderBlocks, type JsonMark, type JsonNode } from '../../src/lib/content/render'
import type { ContentBody } from '../../src/server/db/schema/columns'

const INLINE = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g

/** "Read the **rules** or [contact Michael](/contact)" -> text nodes with bold and link marks. */
export function inline(s: string): JsonNode[] {
  const out: JsonNode[] = []
  const text = (t: string, marks?: JsonMark[]) => {
    if (t) out.push(marks ? { type: 'text', text: t, marks } : { type: 'text', text: t })
  }
  let last = 0
  for (const m of s.matchAll(INLINE)) {
    text(s.slice(last, m.index))
    if (m[1] !== undefined) text(m[1], [{ type: 'bold' }])
    else {
      const href = m[3]!
      const external = /^https?:/i.test(href)
      text(m[2]!, [{ type: 'link', attrs: external ? { href, target: '_blank' } : { href } }])
    }
    last = m.index + m[0].length
  }
  text(s.slice(last))
  return out
}

export const p = (s: string): JsonNode => ({ type: 'paragraph', content: inline(s) })
export const h2 = (s: string): JsonNode => ({ type: 'heading', attrs: { level: 2 }, content: inline(s) })
export const h3 = (s: string): JsonNode => ({ type: 'heading', attrs: { level: 3 }, content: inline(s) })
export const ul = (...items: string[]): JsonNode => ({
  type: 'bulletList',
  content: items.map((i) => ({ type: 'listItem', content: [p(i)] })),
})

/** A Programme list block (docs/admin.md §3.4): one line per active programme matching the filter. */
export const programmeList = (attrs: Partial<ProgrammeListAttrs>): JsonNode => ({
  type: 'programmeList',
  attrs: { ...DEFAULT_PROGRAMME_LIST_ATTRS, ...attrs } as unknown as Record<string, unknown>,
})

/** A Contact form block (docs/admin.md §3.15): the form, with its topics and notifications from Settings → Contact form. */
export const contactForm = (attrs: Partial<ContactFormAttrs> = {}): JsonNode => ({
  type: 'contactForm',
  attrs: { ...DEFAULT_CONTACT_FORM_ATTRS, ...attrs } as unknown as Record<string, unknown>,
})

/** The stored body for some blocks, checked and rendered the way a save in the admin does it. */
export function body(blocks: JsonNode[]): ContentBody {
  const checked = checkBlocks(blocks)
  if (!checked.ok) throw new Error(`content-map: ${checked.message}`)
  const clean = normaliseDataBlocks(checked.blocks)
  return { blocks: clean, html: renderBlocks(clean) }
}
