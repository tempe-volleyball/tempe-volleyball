/** Small seeded PRNG (mulberry32) so a seed always reproduces the same draw. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

/**
 * A new id for a week, game, team or competition: a random UUID (crypto.randomUUID exists in browsers, Node and
 * Workers). The server stores these as the match_days/matches row ids, so ids made in the browser survive a save and
 * results stay attached to their matches.
 */
export const uid = (): string => crypto.randomUUID()
