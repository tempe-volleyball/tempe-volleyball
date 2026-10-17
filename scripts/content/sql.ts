// The content map as guarded SQL (docs/content-map.md). Every statement is a no-op unless its row is still exactly
// as the importer (or migration 0003) left it: no admin edits (updated_by IS NULL, no page revisions), the original
// title or an empty field. So the file can run against staging now and production in Phase 8, any number of times,
// and it never overwrites anything Michael has written.
//
// It doesn't depend on the clock (timestamps come from SQLite's 'now'), so the same drafts always give the same SQL
// and scripts/content/content-map.sql can be checked in and tested for drift.
//
// What it writes:
// - new programmes as drafts (programme.create audit rows);
// - empty category intros, the empty TVSL description and empty league times (category/programme.update audits);
// - empty venue directions (venue.update audits);
// - for each kept page, its proposed version as a revision just behind a copy of the live version, so the admin's
//   Revisions list offers it under View → Restore this version, and nothing changes on the live page;
// - a draft page at /enrol (the /enrol intro) with its first revision;
// - archives clearly stale pages (page.unpublish audits) and adds their redirects;
// - redirects for pages that move later, which wait behind the published page until it's archived.

import { stableId } from '../wp/ids'
import { sqlLiteral, type SqlValue } from '../../src/lib/wp-import/sql'
import { programmePath } from '../../src/lib/programmes'
import type { ContentBody } from '../../src/server/db/schema/columns'
import {
  ARCHIVE,
  CATEGORY_INTROS,
  DRAFT_PROGRAMMES,
  ENROL_PAGE,
  LATER_REDIRECTS,
  LEAGUE_UPDATES,
  PAGE_DRAFTS,
  VENUE_DIRECTIONS,
  programmeSlug,
} from './drafts'

export const SOURCE = 'scripts/content (content map)'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
/** A second before NOW, so a proposed revision sorts just behind the copy of the live version written after it. */
const JUST_BEFORE = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')`

const q = (v: SqlValue) => sqlLiteral(v)
const json = (v: unknown) => sqlLiteral(JSON.stringify(v))
const bodyJson = (b: ContentBody) => json(b)

/** An audit_log row (actor NULL = a script), written only while `where` holds. Put it before the change it records. */
const audit = (action: string, type: string, id: string, before: unknown, after: unknown, where: string) =>
  `INSERT INTO "audit_log" ("id", "at", "actor_user_id", "action", "target_type", "target_id", "before", "after", "ip") SELECT lower(hex(randomblob(16))), ${NOW}, NULL, ${q(action)}, ${q(type)}, ${id}, ${before === null ? 'NULL' : json(before)}, ${json({ ...(after as object), source: SOURCE })}, NULL WHERE ${where};`

/** Deterministic ids, so production gets the same rows in Phase 8 and a re-run finds them. */
export const contentId = (kind: string, key: string) => stableId(`content-map:${kind}`, key)

export function programmeStatements(): string[] {
  return DRAFT_PROGRAMMES.flatMap((d) => {
    const id = contentId('programme', d.code)
    const slug = programmeSlug(d)
    const free = `NOT EXISTS (SELECT 1 FROM "leagues" WHERE "id" = ${q(id)} OR "code" = ${q(d.code)} OR "slug" = ${q(slug)})`
    const venue = d.venueSlug ? `(SELECT "id" FROM "venues" WHERE "slug" = ${q(d.venueSlug)})` : 'NULL'
    const cols: [string, string][] = [
      ['id', q(id)],
      ['code', q(d.code)],
      ['name', q(d.name)],
      ['slug', q(slug)],
      ['weekday', String(d.weekday)],
      ['default_venue_id', venue],
      ['sort', String(d.sort)],
      ['active', '0'],
      ['kind', q(d.kind)],
      ['category_id', q(d.categoryId)],
      ['status', q('draft')],
      ['start_time', q(d.startTime)],
      ['end_time', q(d.endTime)],
      ['schedule_label', q(d.scheduleLabel)],
      ['description', bodyJson(d.description)],
      ['age_min', q(d.ageMin ?? null)],
      ['age_max', q(d.ageMax ?? null)],
      ['cap_players', q(d.capPlayers ?? null)],
      ['price_cents', q(d.priceCents ?? null)],
      ['allow_free_agents', d.allowFreeAgents === false ? '0' : '1'],
    ]
    return [
      audit(
        'programme.create',
        'programme',
        q(id),
        null,
        { name: d.name, code: d.code, slug, kind: d.kind, status: 'draft', categoryId: d.categoryId, description: '(rich text)' },
        `${free} AND EXISTS (SELECT 1 FROM "categories" WHERE "id" = ${q(d.categoryId)})`,
      ),
      `INSERT INTO "leagues" (${cols.map(([c]) => `"${c}"`).join(', ')}) SELECT ${cols.map(([, v]) => v).join(', ')} WHERE ${free} AND EXISTS (SELECT 1 FROM "categories" WHERE "id" = ${q(d.categoryId)});`,
    ]
  })
}

export function leagueStatements(): string[] {
  return LEAGUE_UPDATES.flatMap((u) => {
    const row = `"code" = ${q(u.code)} AND "kind" = 'league' AND "updated_by" IS NULL`
    const target = `(SELECT "id" FROM "leagues" WHERE "code" = ${q(u.code)})`
    const out: string[] = []
    if (u.startTime && u.endTime) {
      const where = `${row} AND "start_time" IS NULL AND "end_time" IS NULL`
      out.push(
        audit(
          'programme.update',
          'programme',
          target,
          { startTime: null, endTime: null },
          { startTime: u.startTime, endTime: u.endTime },
          `EXISTS (SELECT 1 FROM "leagues" WHERE ${where})`,
        ),
        `UPDATE "leagues" SET "start_time" = ${q(u.startTime)}, "end_time" = ${q(u.endTime)}, "updated_at" = ${NOW} WHERE ${where};`,
      )
    }
    if (u.description) {
      const where = `${row} AND json_extract("description", '$.html') = '' AND json_array_length(json_extract("description", '$.blocks')) = 0`
      out.push(
        audit(
          'programme.update',
          'programme',
          target,
          { description: '(empty)' },
          { description: '(rich text)' },
          `EXISTS (SELECT 1 FROM "leagues" WHERE ${where})`,
        ),
        `UPDATE "leagues" SET "description" = ${bodyJson(u.description)}, "updated_at" = ${NOW} WHERE ${where};`,
      )
    }
    return out
  })
}

export function categoryStatements(): string[] {
  return Object.entries(CATEGORY_INTROS).flatMap(([id, intro]) => {
    const where = `"id" = ${q(id)} AND "updated_by" IS NULL AND json_extract("intro", '$.html') = '' AND json_array_length(json_extract("intro", '$.blocks')) = 0`
    return [
      audit(
        'category.update',
        'category',
        q(id),
        { intro: '(empty)' },
        { intro: '(rich text)' },
        `EXISTS (SELECT 1 FROM "categories" WHERE ${where})`,
      ),
      `UPDATE "categories" SET "intro" = ${bodyJson(intro)}, "updated_at" = ${NOW} WHERE ${where};`,
    ]
  })
}

export function venueStatements(): string[] {
  return Object.entries(VENUE_DIRECTIONS).flatMap(([slug, directions]) => {
    const where = `"slug" = ${q(slug)} AND "updated_by" IS NULL AND ("directions" IS NULL OR "directions" = '')`
    return [
      audit(
        'venue.update',
        'venue',
        `(SELECT "id" FROM "venues" WHERE "slug" = ${q(slug)})`,
        { directions: null },
        { directions },
        `EXISTS (SELECT 1 FROM "venues" WHERE ${where})`,
      ),
      `UPDATE "venues" SET "directions" = ${q(directions)}, "updated_at" = ${NOW} WHERE ${where};`,
    ]
  })
}

/** The page as the importer left it: same path, WordPress id and title, never saved in the admin. */
const untouchedPage = (path: string, wpId: number, title: string) =>
  `"pages"."path" = ${q(path)} AND "pages"."wp_id" = ${wpId} AND "pages"."title" = ${q(title)} AND "pages"."updated_by" IS NULL AND NOT EXISTS (SELECT 1 FROM "page_revisions" r WHERE r."page_id" = "pages"."id" AND r."id" NOT IN (${q(contentId('revision-proposed', path))}, ${q(contentId('revision-current', path))}))`

export function pageDraftStatements(): string[] {
  return PAGE_DRAFTS.flatMap((d) => {
    const proposed = contentId('revision-proposed', d.path)
    const current = contentId('revision-current', d.path)
    const page = `${untouchedPage(d.path, d.wpId, d.importedTitle)} AND "pages"."status" = 'published'`
    const none = (id: string) => `NOT EXISTS (SELECT 1 FROM "page_revisions" WHERE "id" = ${q(id)})`
    return [
      // 1. The proposal, a second in the past.
      `INSERT INTO "page_revisions" ("id", "page_id", "title", "body", "created_by", "created_at") SELECT ${q(proposed)}, "id", ${q(d.title)}, ${bodyJson(d.body)}, NULL, ${JUST_BEFORE} FROM "pages" WHERE ${page} AND ${none(proposed)} AND ${none(current)};`,
      // 2. The live version on top, so the Revisions list shows it as current and the proposal as the one to restore.
      `INSERT INTO "page_revisions" ("id", "page_id", "title", "body", "created_by", "created_at") SELECT ${q(current)}, "id", "title", "body", "updated_by", ${NOW} FROM "pages" WHERE ${page} AND ${none(current)} AND EXISTS (SELECT 1 FROM "page_revisions" WHERE "id" = ${q(proposed)} AND "page_id" = "pages"."id");`,
    ]
  })
}

export function enrolPageStatements(): string[] {
  const id = contentId('page', ENROL_PAGE.path)
  return [
    `INSERT INTO "pages" ("id", "path", "title", "meta_description", "template", "body", "status") SELECT ${q(id)}, ${q(ENROL_PAGE.path)}, ${q(ENROL_PAGE.title)}, ${q(ENROL_PAGE.metaDescription)}, 'content', ${bodyJson(ENROL_PAGE.body)}, 'draft' WHERE NOT EXISTS (SELECT 1 FROM "pages" WHERE "path" = ${q(ENROL_PAGE.path)} OR "id" = ${q(id)});`,
    // Its first revision, as createPage writes one.
    `INSERT INTO "page_revisions" ("id", "page_id", "title", "body", "created_by", "created_at") SELECT ${q(contentId('revision-current', ENROL_PAGE.path))}, "id", "title", "body", NULL, ${NOW} FROM "pages" WHERE "id" = ${q(id)} AND "updated_by" IS NULL AND NOT EXISTS (SELECT 1 FROM "page_revisions" WHERE "page_id" = ${q(id)});`,
  ]
}

/** Our redirect rows: new ones are inserted, and only a row the importer wrote is taken over (never Michael's). */
const redirectStatement = (from: string, to: string) =>
  `INSERT INTO "redirects" ("id", "from_path", "to_path", "status", "source") VALUES (${q(stableId('redirect', from))}, ${q(from)}, ${q(to)}, 301, 'manual') ON CONFLICT ("from_path") DO UPDATE SET "to_path" = excluded."to_path", "status" = 301, "source" = 'manual', "updated_at" = ${NOW} WHERE "redirects"."source" = 'wp-import';`

export function archiveStatements(): string[] {
  return ARCHIVE.flatMap((a) => {
    const where = `${untouchedPage(a.path, a.wpId, a.importedTitle)} AND "pages"."status" = 'published'`
    return [
      audit(
        'page.unpublish',
        'page',
        `(SELECT "id" FROM "pages" WHERE "path" = ${q(a.path)})`,
        { status: 'published', path: a.path, title: a.importedTitle },
        { status: 'archived', path: a.path, title: a.importedTitle, redirectTo: a.to },
        `EXISTS (SELECT 1 FROM "pages" WHERE ${where})`,
      ),
      `UPDATE "pages" SET "status" = 'archived', "updated_at" = ${NOW} WHERE ${where};`,
      redirectStatement(a.path, a.to),
    ]
  })
}

export const laterRedirectStatements = () => LATER_REDIRECTS.map((r) => redirectStatement(r.from, r.to))

/** Everything, in order: rows that others reference come first. */
export function contentMapStatements(): string[] {
  return [
    ...programmeStatements(),
    ...leagueStatements(),
    ...categoryStatements(),
    ...venueStatements(),
    ...pageDraftStatements(),
    ...enrolPageStatements(),
    ...archiveStatements(),
    ...laterRedirectStatements(),
  ]
}

export const HEADER = `-- Generated by scripts/content/apply.ts from scripts/content/drafts.ts: don't edit by hand (npx tsx scripts/content/apply.ts --write).
-- The content map (docs/content-map.md). Every statement is guarded and idempotent; see scripts/content/sql.ts.
`

export const contentMapSql = () => `${HEADER}${contentMapStatements().join('\n')}\n`

/** For the docs and the report: the new programme pages. */
export const draftProgrammePaths = () => DRAFT_PROGRAMMES.map((d) => ({ name: d.name, path: programmePath(d.kind, programmeSlug(d)) }))
