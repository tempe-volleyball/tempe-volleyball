// What an imported page or post loses when it's first saved in the editor.
//
// Imported bodies are HTML only (`blocks: []`, from the importer's sanitiser). Opening one in the editor parses
// that HTML into the editor's schema (src/admin/editor/extensions.ts), and saving writes the HTML again from the
// blocks (render.ts), so anything the schema has no place for is dropped or simplified. The editor shows this list
// before the first save. Most of what the old site used is supported (tables, embeds, image captions and links,
// WordPress buttons, sub/superscript, screen-reader text, H5/H6); these rules cover the rest, and must match what
// the editor really keeps.
//
// A regex scan over sanitised HTML: no parser, so it runs the same in the browser and in tests.

export type ImportLoss = {
  /** What the person will recognise, e.g. "Column layouts". */
  label: string
  /** What happens to it on save. */
  effect: string
  count: number
}

type Rule = { label: string; effect: string; re: RegExp }

const RULES: Rule[] = [
  { label: 'Videos', effect: 'removed; add them again as a YouTube or Vimeo embed', re: /<video\b/gi },
  { label: 'Audio', effect: 'removed', re: /<audio\b/gi },
  { label: 'Image galleries', effect: 'each image is kept, one under another', re: /\bwp-block-gallery\b/gi },
  { label: 'Column layouts', effect: 'the columns stack one under another', re: /\bwp-block-columns\b/gi },
  {
    label: 'Colours, backgrounds and font sizes',
    effect: 'the site’s normal text style is used',
    re: /\bhas-(?:[\w-]+-(?:color|background-color|font-size)|text-color|background)\b/gi,
  },
  { label: 'Button groups’ layout (centred or side by side)', effect: 'the buttons are kept, one per line', re: /\bwp-block-buttons\b/gi },
  {
    label: 'Anchors (links that jump to a spot on the page)',
    effect: 'the spot is removed, so “#…” links to it stop jumping',
    re: /<(?:h[1-6]|p|div|span|section|li|table)\b[^>]*\bid="/gi,
  },
  { label: 'Definition lists', effect: 'become ordinary paragraphs', re: /<dl\b/gi },
  { label: 'Code blocks', effect: 'become ordinary text', re: /<(?:pre|code)\b/gi },
  { label: 'Table captions', effect: 'removed', re: /<caption\b/gi },
  {
    label: 'Text alignment on lists, quotes and table cells',
    effect: 'aligned left (alignment is kept on paragraphs and headings)',
    re: /<(?:li|blockquote|td|th|div|figure)\b[^>]*\bstyle="[^"]*text-align/gi,
  },
  {
    label: 'Embeds from sites the editor doesn’t allow',
    effect: 'removed (only YouTube, Vimeo and Google Maps/Docs can be embedded)',
    re: /<iframe\b(?![^>]*\bsrc=)[^>]*>/gi,
  },
  { label: 'Images from outside the site over plain http', effect: 'removed', re: /<img\b[^>]*\bsrc="http:\/\//gi },
]

/** What `html` loses on its first save in the editor, most frequent first. Empty when everything is kept. */
export function importLosses(html: string): ImportLoss[] {
  const out: ImportLoss[] = []
  for (const r of RULES) {
    const count = html.match(r.re)?.length ?? 0
    if (count) out.push({ label: r.label, effect: r.effect, count })
  }
  return out.toSorted((a, b) => b.count - a.count)
}

/** An imported body that has never been saved in the editor (HTML only, no blocks). */
export const isUnconvertedImport = (body: { blocks?: readonly unknown[] | null; html?: string | null }) =>
  (!body.blocks || body.blocks.length === 0) && !!body.html?.trim()
