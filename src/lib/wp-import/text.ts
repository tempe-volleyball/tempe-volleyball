// Small text helpers for the WordPress importer (scripts/import-wp.ts). Pure, no DOM.

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
}

/** Decodes the HTML entities WordPress puts in titles ("&#8211;", "&#038;", "&amp;" …). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : m
    }
    return NAMED[code.toLowerCase()] ?? m
  })
}

/** A WordPress title as plain text: entities decoded, tags stripped, whitespace collapsed. */
export const plainText = (html: string) =>
  decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()

const SMALL = new Set(['and', 'or', 'of', 'the', 'a', 'to', 'vs', 'in', 'at'])

/** "SEMI FINAL 1" -> "Semi Final 1", "3RD PLACE PLAYOFF" -> "3rd Place Playoff". */
export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => (i > 0 && SMALL.has(w) ? w : /^\d/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ')
}

/** URL slug: lower case ASCII letters, digits and single hyphens. */
export const slugify = (s: string) =>
  decodeEntities(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** Team-name key for matching names typed into titles against team records: "KY & CO" ~ "ky-and-co". */
export const nameKey = (s: string) => slugify(s).replace(/-/g, '')
