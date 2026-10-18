import { lte, sql } from 'drizzle-orm'
import { runBatch, type AppDb } from './db'
import { rateLimits } from './db/schema'

// Fixed-window rate limits stored in D1 (rate_limits), for public endpoints that have no session: the enrolment
// form, per IP and per email. Each hit is one atomic upsert (no read-then-write race); several keys go in one batch.
// Keys hold a salted SHA-256 prefix of the IP or email, never the value itself (unsalted, an IPv4 hash could be
// reversed by trying every address), and the hourly cron deletes old windows.

export type Limit = { key: string; max: number; windowMs: number }

/**
 * SHA-256 of salt + value, hex, first 32 characters: enough to tell keys apart without storing the IP or email.
 * The salt (BETTER_AUTH_SECRET) is required: without it an IPv4 hash could be reversed.
 */
export async function hashKey(value: string, salt: string | undefined): Promise<string> {
  if (!salt) throw new Error('hashKey: no salt (BETTER_AUTH_SECRET is not set)')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`tempevb:ratelimit:${salt}:${value}`))
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const hitQuery = (db: AppDb, limit: Limit, at: Date) => {
  const iso = at.toISOString()
  const expires = new Date(at.getTime() + limit.windowMs).toISOString()
  const lapsed = sql`${rateLimits.expiresAt} <= ${iso}`
  return db
    .insert(rateLimits)
    .values({ key: limit.key, count: 1, windowStart: iso, expiresAt: expires })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`case when ${lapsed} then 1 else ${rateLimits.count} + 1 end`,
        windowStart: sql`case when ${lapsed} then ${iso} else ${rateLimits.windowStart} end`,
        expiresAt: sql`case when ${lapsed} then ${expires} else ${rateLimits.expiresAt} end`,
      },
    })
    .returning({ key: rateLimits.key, count: rateLimits.count, expiresAt: rateLimits.expiresAt })
}

export type HitResult = {
  ok: boolean
  /** Seconds until the last exceeded window ends (for Retry-After). */
  retryAfter: number
  /** The keys now over their max. */
  exceeded: string[]
}

/** Counts one request against every limit (one batch). Not ok if any limit is now over its max. */
export async function hit(db: AppDb, limits: Limit[], at = new Date()): Promise<HitResult> {
  if (limits.length === 0) return { ok: true, retryAfter: 0, exceeded: [] }
  const results = (await runBatch(
    db,
    limits.map((l) => hitQuery(db, l, at)),
  )) as { key: string; count: number; expiresAt: string }[][]
  let retryAfter = 0
  const exceeded: string[] = []
  limits.forEach((l, i) => {
    const row = results[i]?.[0]
    if (row && row.count > l.max) {
      exceeded.push(l.key)
      retryAfter = Math.max(retryAfter, Math.max(1, Math.ceil((Date.parse(row.expiresAt) - at.getTime()) / 1000)))
    }
  })
  return { ok: exceeded.length === 0, retryAfter, exceeded }
}

/** Cron: deletes windows that have ended. */
export async function pruneRateLimits(db: AppDb, at = new Date()) {
  const rows = await db.delete(rateLimits).where(lte(rateLimits.expiresAt, at.toISOString())).returning({ key: rateLimits.key })
  return rows.length
}
