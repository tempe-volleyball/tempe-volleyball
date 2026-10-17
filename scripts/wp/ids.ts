import { createHash } from 'node:crypto'

/**
 * A deterministic UUID-shaped id for an imported row, from its kind and WordPress key, so re-running the importer
 * upserts the same rows (and foreign keys between them line up) without reading the database first.
 */
export function stableId(kind: string, key: string | number): string {
  const h = createHash('sha256').update(`tempevb-wp-import:${kind}:${key}`).digest('hex')
  // Version 8 (custom) UUID layout, variant 10xx.
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
