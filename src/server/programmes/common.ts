import { and, eq, inArray, like, or, sql } from 'drizzle-orm'
import { checkPagePath, checkSlug, isIntroPagePath } from '../../lib/content/paths'
import { checkBlocks, renderBlocks, safeHref } from '../../lib/content/render'
import { tags, type PurgeTargets } from '../cache'
import type { AppDb } from '../db'
import { pageDataRefs, pages, redirects, type ContentBody } from '../db/schema'
import { conflict, invalid, optionalText, type Editor } from '../content/common'
import { chunkByParams } from '../competition/draw'

// Shared bits of the programmes admin (programmes, categories, venues and courts, sessions, terms and events):
// input checks, URL moves with their 301s, and the edge-cache tags a change purges. See docs/api/programmes.md.

export { conflict, invalid }

const ID = /^[A-Za-z0-9_-]{1,64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** Absent (undefined) means "keep the current value"; these helpers only run on fields the client sent. */
export const has = (input: Record<string, unknown>, key: string) => input[key] !== undefined

export function idOrNull(v: unknown, label: string): string | null {
  if (v === null || v === '') return null
  if (typeof v !== 'string' || !ID.test(v)) throw invalid(`${label} must be an id.`)
  return v
}

export function requiredId(v: unknown, label: string): string {
  const id = idOrNull(v, label)
  if (!id) throw invalid(`${label} is required.`)
  return id
}

export function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

export function date(v: unknown, label: string): string {
  if (!isDate(v)) throw invalid(`${label} must be a date, YYYY-MM-DD.`)
  return v
}

export const dateOrNull = (v: unknown, label: string): string | null => (v === null || v === '' ? null : date(v, label))

export function timeOrNull(v: unknown, label: string): string | null {
  if (v === null || v === '') return null
  if (typeof v !== 'string' || !TIME.test(v)) throw invalid(`${label} must be a time, HH:MM (24-hour).`)
  return v
}

export function bool(v: unknown, label: string): boolean {
  if (typeof v !== 'boolean') throw invalid(`${label} must be true or false.`)
  return v
}

export function int(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw invalid(`${label} must be a whole number from ${min} to ${max}.`)
  return v
}

export const intOrNull = (v: unknown, label: string, min: number, max: number): number | null =>
  v === null || v === '' ? null : int(v, label, min, max)

/** A UTC ISO instant (what the admin sends after converting Sydney time), normalised to toISOString(). */
export function instantOrNull(v: unknown, label: string): string | null {
  if (v === null || v === '') return null
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v) || Number.isNaN(Date.parse(v)))
    throw invalid(`${label} must be a date and time.`)
  return new Date(v).toISOString()
}

/** Multi-line plain text (directions, notes): trimmed, line breaks kept, runs of blank lines collapsed. */
export function longText(v: unknown, label: string, max: number): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw invalid(`${label} must be text.`)
  const s = v
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (s.length > max) throw invalid(`${label} is too long (at most ${max} characters).`)
  return s || null
}

/** A link: a root-relative path or an http(s)/mailto/tel URL (safeHref). */
export function linkOrNull(v: unknown, label: string): string | null {
  const s = optionalText(v, label, 2000)
  if (!s) return null
  const safe = safeHref(s)
  if (!safe || safe.startsWith('#') || safe.startsWith('?')) throw invalid(`${label} must be a path like /about or a full https:// link.`)
  return safe
}

/** Rich text from the editor (TipTap JSON) -> the stored body, sanitised and rendered on the server. */
export function richText(blocks: unknown): ContentBody {
  const checked = checkBlocks(blocks ?? [])
  if (!checked.ok) throw invalid(checked.message)
  return { blocks: checked.blocks, html: renderBlocks(checked.blocks) }
}

/** A URL slug: lower-case letters, digits and single hyphens. */
export function slug(v: unknown, label = 'URL'): string {
  if (typeof v !== 'string') throw invalid(`${label}: enter a slug, like tnl.`)
  const checked = checkSlug(v)
  if (!checked.ok) throw invalid(`${label}: ${checked.message}`)
  return checked.slug
}

/** A category slug becomes a root path (/mixed-leagues), so it must also be a valid, unreserved page path. */
export function categorySlug(v: unknown): string {
  const s = slug(v)
  const checked = checkPagePath(`/${s}`)
  if (!checked.ok) throw invalid(`URL: ${checked.message}`)
  if (isIntroPagePath(checked.path)) throw invalid(`URL: /${s} is used by the site itself.`)
  return s
}

/** Fails when a content page already lives at `path` (a category or programme would hide it, or vice versa). */
export async function assertNoPageAt(db: AppDb, path: string) {
  const page = await db.select({ title: pages.title }).from(pages).where(eq(pages.path, path)).get()
  if (page) throw conflict(`${path} is already used by the page “${page.title}”.`)
}

// ── URL moves ─────────────────────────────────────────────────────────────────

/**
 * The batch statements for moving a public URL and everything under it (a programme's season, term or event pages)
 * from `from` to `to`, leaving 301s, as pages do (moveRedirectStatements in src/server/content/common.ts):
 *  - drop redirects from `to` or under it (content lives there now; also breaks loops when moved back);
 *  - repoint redirects that led to `from`, under it or to one of its #tabs (`/results` -> `/leagues/tnl#fixtures`),
 *    so there are no chains;
 *  - upsert `from` -> `to` and `from/<child>` -> `to/<child>` for each child slug.
 * Three statements plus one per chunk of children. Slugs are [a-z0-9-], so LIKE needs no escaping.
 */
export function moveTreeStatements(db: AppDb, move: { from: string; to: string }, children: string[], actor: Editor, at: string) {
  const { from, to } = move
  const rows = [{ fromPath: from, toPath: to }, ...children.map((c) => ({ fromPath: `${from}/${c}`, toPath: `${to}/${c}` }))].map((r) => ({
    ...r,
    id: crypto.randomUUID(),
    status: 301,
    source: 'manual' as const,
    updatedBy: actor.id,
  }))
  return [
    db.delete(redirects).where(or(eq(redirects.fromPath, to), like(redirects.fromPath, `${to}/%`))),
    db
      .update(redirects)
      .set({ toPath: sql`${to} || substr(${redirects.toPath}, ${from.length + 1})`, updatedAt: at, updatedBy: actor.id })
      .where(or(eq(redirects.toPath, from), like(redirects.toPath, `${from}/%`), like(redirects.toPath, `${from}#%`))),
    ...chunkByParams(rows).map((chunk) =>
      db
        .insert(redirects)
        .values(chunk)
        .onConflictDoUpdate({
          target: redirects.fromPath,
          set: { toPath: sql`excluded.to_path`, status: 301, updatedAt: at, updatedBy: actor.id },
        }),
    ),
  ]
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/**
 * Pages whose data blocks read programmes (any Programme list) or one league (Ladder, Fixtures), from
 * page_data_refs. Their tags.page(path) purge them even if the block renderer forgot to add tags.programmes.
 */
export async function blockPageTags(db: AppDb, programmeIds: string[]): Promise<string[]> {
  const rows = await db
    .select({ path: pages.path })
    .from(pageDataRefs)
    .innerJoin(pages, eq(pages.id, pageDataRefs.pageId))
    .where(
      or(
        eq(pageDataRefs.kind, 'programme_list'),
        programmeIds.length
          ? and(inArray(pageDataRefs.kind, ['ladder', 'fixtures']), inArray(pageDataRefs.refId, programmeIds))
          : undefined,
      ),
    )
    .limit(200)
    .all()
  return [...new Set(rows.map((r) => tags.page(r.path)))]
}

/** A programme's own page tags: tags.programme(slug), plus tags.league(slug) for leagues. */
export const programmeTags = (p: { kind: string; slug: string }) =>
  p.kind === 'league' ? [tags.programme(p.slug), tags.league(p.slug)] : [tags.programme(p.slug)]

/** Purge targets from a tag list (deduplicated); an empty list means nothing to purge. */
export const purgeOf = (list: string[]): PurgeTargets => (list.length ? { tags: [...new Set(list)] } : {})
