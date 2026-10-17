// Enrolment references: short, easy to read aloud and to type as a PayID description, e.g. "TVB-7K3Q".
// No 0/O, 1/I/L or U, so nobody mistypes one. 30^4 = 810,000 combinations; registrations.reference is unique and
// the insert retries with a new one on the (rare) clash.

export const REFERENCE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
export const REFERENCE_PREFIX = 'TVB-'
export const REFERENCE_PATTERN = /^TVB-[2-9A-HJKMNP-TV-Z]{4}$/

/** A random reference. `random` fills a byte array (crypto.getRandomValues by default). */
export function newReference(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const bytes = random(new Uint8Array(4))
  let out = REFERENCE_PREFIX
  // 256 isn't a multiple of 30; the bias (≤ 1 in 9) doesn't matter for a non-secret reference.
  for (const b of bytes) out += REFERENCE_ALPHABET[b % REFERENCE_ALPHABET.length]
  return out
}

/** "tvb 7k3q" → "TVB-7K3Q" (for search boxes). Null if it isn't one. */
export function parseReference(input: string): string | null {
  const s = input.trim().toUpperCase().replace(/\s+/g, '-')
  const withDash = /^TVB-?/.test(s) ? `TVB-${s.replace(/^TVB-?/, '')}` : `TVB-${s}`
  return REFERENCE_PATTERN.test(withDash) ? withDash : null
}
