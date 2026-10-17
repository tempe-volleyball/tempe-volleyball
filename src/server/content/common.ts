import { eq, sql } from 'drizzle-orm'
import type { AppDb } from '../db'
import { auditLog, media, redirects, type AuditAction, type NewAuditLogEntry } from '../db/schema'
import { HttpError } from '../http'
import type { PurgeTargets } from '../cache'

// Shared bits of the content admin (pages, posts, menu, media, settings).

/** Who is acting, and from where (audit_log.ip). */
export type Editor = { id: string; ip?: string | null }

/** What a mutation changed, for the route to purge from the edge cache. */
export type Changed<T> = { result: T; purge: PurgeTargets }

export const invalid = (message: string) => new HttpError(400, 'invalid_input', message)
export const notFound = (what: string) => new HttpError(404, 'not_found', `That ${what} doesn't exist (it may have been deleted).`)
export const conflict = (message: string) => new HttpError(409, 'conflict', message)

export const auditEntry = (
  actor: Editor,
  action: AuditAction,
  target: { type: string; id: string },
  before: unknown,
  after: unknown,
  at: string,
): NewAuditLogEntry => ({
  at,
  actorUserId: actor.id,
  action,
  targetType: target.type,
  targetId: target.id,
  before: before ?? null,
  after: after ?? null,
  ip: actor.ip ?? null,
})

export const audit = (db: AppDb, ...args: Parameters<typeof auditEntry>) => db.insert(auditLog).values(auditEntry(...args))

const errorText = (e: unknown): string => {
  let text = ''
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof Error) text += ` ${cur.message}`
    cur = (cur as { cause?: unknown }).cause
  }
  return text
}

/** Drizzle wraps SQLite errors ("Failed query"), so look through the causes. */
export const isUniqueFailure = (e: unknown, column?: string) => {
  const t = errorText(e)
  return /UNIQUE constraint failed/i.test(t) && (!column || t.includes(column))
}

export async function assertMedia(db: AppDb, id: string | null | undefined, label: string) {
  if (!id) return
  const row = await db.select({ id: media.id }).from(media).where(eq(media.id, id)).get()
  if (!row) throw invalid(`${label}: that image is no longer in the media library.`)
}

/**
 * The batch statements for moving published content from one path to another (see planMove in
 * src/lib/content/paths.ts): drop any redirect from the new path, repoint redirects that led to the old path,
 * and upsert old -> new.
 */
export function moveRedirectStatements(db: AppDb, move: { from: string; to: string }, actor: Editor, at: string) {
  return [
    db.delete(redirects).where(eq(redirects.fromPath, move.to)),
    db.update(redirects).set({ toPath: move.to, updatedAt: at, updatedBy: actor.id }).where(eq(redirects.toPath, move.from)),
    db
      .insert(redirects)
      .values({ fromPath: move.from, toPath: move.to, status: 301, source: 'manual', updatedBy: actor.id })
      .onConflictDoUpdate({ target: redirects.fromPath, set: { toPath: move.to, status: 301, updatedAt: at, updatedBy: actor.id } }),
  ]
}

/** A redirect from `path` would never fire once content lives there; drop it so the table stays truthful. */
export const clearRedirectFrom = (db: AppDb, path: string) => db.delete(redirects).where(eq(redirects.fromPath, path))

/** SQL LIKE pattern for a search box, with % and _ escaped (use with ESCAPE '\'). */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export const likeEscaped = (column: unknown, pattern: string) => sql`${column} like ${pattern} escape '\\'`

export const optionalText = (v: unknown, label: string, max: number): string | null => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw invalid(`${label} must be text.`)
  const s = v.trim().replace(/\s+/g, ' ')
  if (s.length > max) throw invalid(`${label} is too long (at most ${max} characters).`)
  return s || null
}

export const requiredText = (v: unknown, label: string, max: number): string => {
  const s = optionalText(v, label, max)
  if (!s) throw invalid(`${label} is required.`)
  return s
}
