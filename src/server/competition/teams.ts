import { and, asc, desc, eq, gte, inArray, isNotNull, like, or, sql } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import { slugify } from '../../lib/content/paths'
import { teamPath } from '../../lib/teams'
import { tags } from '../cache'
import { runBatch, type AppDb } from '../db'
import {
  auditLog,
  groups,
  interestProgrammes,
  ladderAdjustments,
  leagues,
  matches,
  redirects,
  seasons,
  seasonTeamPlayers,
  seasonTeams,
  teams,
  type Season,
  type Team,
} from '../db/schema'
import { audit, isUniqueFailure, notFound, type Changed, type Editor } from '../content/common'
import { HttpError } from '../http'
import { id as idOf, text } from './input'

// Teams persist across seasons (SportsPress had 88). Admins create, rename and merge them (Admin → Teams); who plays
// in a season is season_teams (seasons.ts setSeasonTeams). A team's page is /teams/<slug> (docs/public-site.md
// "Team pages"): renaming moves the slug to the new name and leaves a 301 from the old page (the
// redirects that pointed at the old page are re-pointed, so there are no chains and old /team/<slug>/ links from
// the WordPress site still reach the team they were imported from). A new team may take a freed slug: its page then
// stops redirecting.

/** One season a team played in, for its history. */
export type TeamSeason = Pick<Season, 'id' | 'name' | 'year' | 'quarter' | 'leagueId' | 'status'> & {
  leagueCode: string
  withdrawnAt: string | null
}

export type TeamListItem = Pick<Team, 'id' | 'name' | 'slug' | 'createdAt' | 'updatedAt'> & {
  /** The newest season the team is in, if any. */
  lastSeason: { id: string; name: string; year: number; quarter: number; leagueId: string } | null
  seasons: number
  /** Every season it's been in, newest first. */
  history: TeamSeason[]
}

const newestFirst = (a: Pick<Season, 'year' | 'quarter'>, b: Pick<Season, 'year' | 'quarter'>) => b.year - a.year || b.quarter - a.quarter

export async function listTeams(db: AppDb): Promise<TeamListItem[]> {
  // Joined columns are named so none share a column name (D1's batch keys rows by column name).
  const [teamRows, memberRows] = (await runBatch(db, [
    db
      .select({ id: teams.id, name: teams.name, slug: teams.slug, createdAt: teams.createdAt, updatedAt: teams.updatedAt })
      .from(teams)
      .orderBy(asc(sql`lower(${teams.name})`)),
    db
      .select({
        teamId: seasonTeams.teamId,
        withdrawnAt: seasonTeams.withdrawnAt,
        id: seasons.id,
        name: seasons.name,
        year: seasons.year,
        quarter: seasons.quarter,
        leagueId: seasons.leagueId,
        status: seasons.status,
        leagueCode: leagues.code,
      })
      .from(seasonTeams)
      .innerJoin(seasons, eq(seasons.id, seasonTeams.seasonId))
      .innerJoin(leagues, eq(leagues.id, seasons.leagueId)),
  ])) as unknown as [Pick<Team, 'id' | 'name' | 'slug' | 'createdAt' | 'updatedAt'>[], ({ teamId: string } & TeamSeason)[]]
  const history = new Map<string, TeamSeason[]>()
  for (const { teamId, ...s } of memberRows) history.set(teamId, [...(history.get(teamId) ?? []), s])
  return teamRows.map((t) => {
    const mine = (history.get(t.id) ?? []).toSorted(newestFirst)
    const last = mine[0]
    return {
      ...t,
      lastSeason: last ? { id: last.id, name: last.name, year: last.year, quarter: last.quarter, leagueId: last.leagueId } : null,
      seasons: mine.length,
      history: mine,
    }
  })
}

const MAX_NAME = 80

const teamName = (v: unknown) => text(v, 'Team name', MAX_NAME, { required: true })

const exists = (name: string) => new HttpError(409, 'team_exists', `There's already a team called “${name}”.`)

async function assertNameFree(db: AppDb, name: string, exceptId?: string) {
  const same = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(sql`lower(${teams.name}) = ${name.toLowerCase()}`)
    .all()
  const other = same.find((t) => t.id !== exceptId)
  if (other) throw exists(other.name)
}

/** A slug for a team's name, with -2, -3 … if another team has it (`selfId`: the team being renamed). */
async function freeSlug(db: AppDb, name: string, selfId?: string) {
  const base = slugify(name, 60) || 'team'
  const taken = new Set(
    (
      await db
        .select({ id: teams.id, slug: teams.slug })
        .from(teams)
        .where(or(eq(teams.slug, base), like(teams.slug, `${base}-%`)))
        .all()
    )
      .filter((r) => r.id !== selfId)
      .map((r) => r.slug),
  )
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

/** A slug's page now belongs to a team: drop the redirect left there by a team that was renamed or merged. */
const claimSlugStatements = (db: AppDb, slug: string) => [db.delete(redirects).where(eq(redirects.fromPath, teamPath(slug)))]

/** The team page moved from one slug to another: re-point redirects to the old page, then 301 the old page. */
const movePageStatements = (db: AppDb, from: string, to: string, by: { updatedAt: string; updatedBy: string }) => [
  db
    .update(redirects)
    .set({ toPath: teamPath(to), ...by })
    .where(eq(redirects.toPath, teamPath(from))),
  db
    .insert(redirects)
    .values({
      id: crypto.randomUUID(),
      fromPath: teamPath(from),
      toPath: teamPath(to),
      status: 301,
      source: 'manual',
      createdAt: by.updatedAt,
      ...by,
    })
    .onConflictDoUpdate({ target: redirects.fromPath, set: { toPath: teamPath(to), status: 301, ...by } }),
]

export async function createTeam(db: AppDb, actor: Editor, input: { name?: unknown }, now = new Date()): Promise<TeamListItem> {
  const name = teamName(input.name)
  await assertNameFree(db, name)
  const row = { id: crypto.randomUUID(), name, slug: await freeSlug(db, name) }
  const at = now.toISOString()
  try {
    await runBatch(db, [
      ...claimSlugStatements(db, row.slug),
      db.insert(teams).values({ ...row, createdAt: at, updatedAt: at, updatedBy: actor.id }),
      audit(db, actor, 'team.create', { type: 'team', id: row.id }, null, row, at),
    ])
  } catch (e) {
    if (isUniqueFailure(e)) throw exists(name)
    throw e
  }
  return { ...row, createdAt: at, updatedAt: at, lastSeason: null, seasons: 0, history: [] }
}

/** Renames a team everywhere it plays (names live on the team). Purges every public page (ladders show names). */
export async function renameTeam(
  db: AppDb,
  actor: Editor,
  teamId: string,
  input: { name?: unknown },
  now = new Date(),
): Promise<Changed<Pick<Team, 'id' | 'name' | 'slug' | 'updatedAt'>>> {
  const name = teamName(input.name)
  const team = await db.select().from(teams).where(eq(teams.id, teamId)).get()
  if (!team) throw notFound('team')
  if (team.name === name) return { result: { id: team.id, name, slug: team.slug, updatedAt: team.updatedAt }, purge: {} }
  if (name.toLowerCase() !== team.name.toLowerCase()) await assertNameFree(db, name, teamId)
  const at = now.toISOString()
  const by = { updatedAt: at, updatedBy: actor.id }
  // The slug follows the name (unless it already fits it, e.g. a change of case).
  const fits = team.slug === slugify(name, 60) || team.slug.startsWith(`${slugify(name, 60)}-`)
  const slug = fits ? team.slug : await freeSlug(db, name, teamId)
  const moved = slug !== team.slug
  await runBatch(db, [
    ...(moved ? claimSlugStatements(db, slug) : []),
    db
      .update(teams)
      .set({ name, slug, ...by })
      .where(eq(teams.id, teamId)),
    ...(moved ? movePageStatements(db, team.slug, slug, by) : []),
    audit(db, actor, 'team.rename', { type: 'team', id: teamId }, { name: team.name, slug: team.slug }, { name, slug }, at),
  ])
  return { result: { id: teamId, name, slug, updatedAt: at }, purge: { tags: [tags.site] } }
}

export type MergeTeamsInput = { mergeId?: unknown }
export type MergeResult = { team: Pick<Team, 'id' | 'name' | 'slug' | 'updatedAt'>; merged: { id: string; name: string }; seasons: number }

/** How long a merge can be undone (Admin → Teams, "Recent merges"). */
export const MERGE_UNDO_DAYS = 30

/**
 * What a merge changed, kept in its audit row (`before.undo`) so undoMerge() can put B back exactly. Rows are
 * re-pointed by season: in B's seasons A wasn't there before (a merge is refused otherwise), so every A row in them
 * was B's, including games added after the merge.
 */
export type MergeUndoRecord = {
  v: 1
  team: Pick<Team, 'id' | 'name' | 'slug' | 'wpId' | 'createdAt'>
  keepId: string
  keepSlug: string
  /** B's WordPress id moved to A. */
  wpIdMoved: boolean
  /** Seasons B was in (season_teams). */
  memberSeasonIds: string[]
  /** Every season with a game or adjustment of B's (a superset of memberSeasonIds in practice). */
  seasonIds: string[]
  /** Seasons B had a roster in (season_team_players). Missing in records made before rosters. */
  rosterSeasonIds?: string[]
  /** EOI programme rows placed into B ("interestId|programmeId"). */
  interestKeys?: string[]
  groupIds: string[]
  /** Redirects that led to one of B's feeds and were re-pointed to A's. */
  repointedRedirectIds: string[]
  /** B's feed paths now redirecting to A's, and what each redirect said before (null: there wasn't one). */
  feeds: { fromPath: string; previousToPath: string | null }[]
  /** Redirects that led to B's page and were re-pointed to A's; and what B's page redirected to before (none: null). */
  pageRedirectIds?: string[]
  pagePreviousToPath?: string | null
}

const inJson = (column: AnySQLiteColumn, values: string[]) => sql`${column} in (select value from json_each(${JSON.stringify(values)}))`
const quoted = (id: string) => JSON.stringify(id)

/**
 * Merges duplicate team B (`mergeId`) into team A (`keepId`): every season B played in, its games (home, away and
 * duty), ladder adjustments and enrolment groups now point at A, and B is deleted. Refused when the two were in the
 * same season, or one has games in the other's season (that's two real teams). A keeps its name and slug; B's team
 * page 301s to A's, and B's WordPress id moves to A when A has none (so a re-import finds it). Seasons'
 * draw keys (generated_from) follow, so B's seasons don't look out of date. One batch whatever the number of games:
 * each re-point is a single UPDATE … WHERE team_id = B. Admins. Audited as team.merge with what undoMerge() needs to
 * put it back; purges the site.
 */
export async function mergeTeams(
  db: AppDb,
  actor: Editor,
  keepId: string,
  input: MergeTeamsInput,
  now = new Date(),
): Promise<Changed<MergeResult>> {
  idOf(keepId, 'Team')
  const mergeId = idOf(input.mergeId, 'Team to merge')
  if (mergeId === keepId) throw new HttpError(400, 'invalid_input', 'Pick a different team to merge in.')
  const both = [keepId, mergeId]
  const [teamRows, memberRows, homeRows, awayRows, dutyRows, adjustmentRows, groupRows, redirectRows, rosterRows, placedRows] =
    (await runBatch(db, [
      db.select().from(teams).where(inArray(teams.id, both)),
      db
        .select({
          teamId: seasonTeams.teamId,
          seasonId: seasonTeams.seasonId,
          seasonName: sql<string>`${seasons.name}`.as('season_name'),
          leagueSlug: sql<string>`${leagues.slug}`.as('league_slug'),
        })
        .from(seasonTeams)
        .innerJoin(seasons, eq(seasons.id, seasonTeams.seasonId))
        .innerJoin(leagues, eq(leagues.id, seasons.leagueId))
        .where(inArray(seasonTeams.teamId, both)),
      db.selectDistinct({ seasonId: matches.seasonId, teamId: matches.homeTeamId }).from(matches).where(inArray(matches.homeTeamId, both)),
      db.selectDistinct({ seasonId: matches.seasonId, teamId: matches.awayTeamId }).from(matches).where(inArray(matches.awayTeamId, both)),
      db.selectDistinct({ seasonId: matches.seasonId, teamId: matches.dutyTeamId }).from(matches).where(inArray(matches.dutyTeamId, both)),
      db
        .selectDistinct({ seasonId: ladderAdjustments.seasonId, teamId: ladderAdjustments.teamId })
        .from(ladderAdjustments)
        .where(inArray(ladderAdjustments.teamId, both)),
      db.select({ id: groups.id }).from(groups).where(eq(groups.teamId, mergeId)),
      db
        .select({ id: redirects.id, fromPath: redirects.fromPath, toPath: redirects.toPath })
        .from(redirects)
        .where(
          or(
            sql`${redirects.toPath} = '/teams/' || (select ${teams.slug} from ${teams} where ${teams.id} = ${mergeId})`,
            sql`${redirects.fromPath} = '/teams/' || (select ${teams.slug} from ${teams} where ${teams.id} = ${mergeId})`,
          ),
        ),
      db
        .selectDistinct({ seasonId: seasonTeamPlayers.seasonId, teamId: seasonTeamPlayers.teamId })
        .from(seasonTeamPlayers)
        .where(inArray(seasonTeamPlayers.teamId, both)),
      db
        .select({ interestId: interestProgrammes.interestId, programmeId: interestProgrammes.programmeId })
        .from(interestProgrammes)
        .where(eq(interestProgrammes.teamId, mergeId)),
    ])) as unknown as [
      Team[],
      { teamId: string; seasonId: string; seasonName: string; leagueSlug: string }[],
      { seasonId: string; teamId: string }[],
      { seasonId: string; teamId: string }[],
      { seasonId: string; teamId: string }[],
      { seasonId: string; teamId: string }[],
      { id: string }[],
      { id: string; fromPath: string; toPath: string }[],
      { seasonId: string; teamId: string }[],
      { interestId: string; programmeId: string }[],
    ]
  const keep = teamRows.find((t) => t.id === keepId)
  const gone = teamRows.find((t) => t.id === mergeId)
  if (!keep || !gone) throw notFound('team')
  const seasonsOf = (teamId: string) =>
    new Set(
      [...memberRows, ...homeRows, ...awayRows, ...dutyRows, ...adjustmentRows, ...rosterRows]
        .filter((r) => r.teamId === teamId)
        .map((r) => r.seasonId),
    )
  const keepSeasons = seasonsOf(keepId)
  const goneSeasons = seasonsOf(mergeId)
  const theirs = memberRows.filter((m) => m.teamId === mergeId)
  const shared = [...goneSeasons].filter((s) => keepSeasons.has(s))
  if (shared.length) {
    const names = [...new Set(shared.map((s) => memberRows.find((m) => m.seasonId === s)?.seasonName ?? 'one season'))]
    throw new HttpError(
      409,
      'same_season',
      `${keep.name} and ${gone.name} both played in ${names.join(', ')}, so they're different teams. Rename one instead.`,
    )
  }
  const at = now.toISOString()
  const by = { updatedAt: at, updatedBy: actor.id }
  const memberSeasonIds = theirs.map((m) => m.seasonId)
  const wpIdMoved = keep.wpId === null && gone.wpId !== null
  const undo: MergeUndoRecord = {
    v: 1,
    team: { id: gone.id, name: gone.name, slug: gone.slug, wpId: gone.wpId, createdAt: gone.createdAt },
    keepId,
    keepSlug: keep.slug,
    wpIdMoved,
    memberSeasonIds,
    seasonIds: [...goneSeasons],
    rosterSeasonIds: [...new Set(rosterRows.filter((r) => r.teamId === mergeId).map((r) => r.seasonId))],
    interestKeys: placedRows.map((r) => `${r.interestId}|${r.programmeId}`),
    groupIds: groupRows.map((g) => g.id),
    // Calendar feeds are gone (2026-10-20); kept empty so undo reads old and new records the same way.
    repointedRedirectIds: [],
    feeds: [],
    pageRedirectIds: redirectRows.filter((r) => r.toPath === teamPath(gone.slug)).map((r) => r.id),
    pagePreviousToPath: redirectRows.find((r) => r.fromPath === teamPath(gone.slug))?.toPath ?? null,
  }
  await runBatch(db, [
    db.update(seasonTeams).set({ teamId: keepId, updatedAt: at }).where(eq(seasonTeams.teamId, mergeId)),
    db
      .update(matches)
      .set({ homeTeamId: keepId, ...by })
      .where(eq(matches.homeTeamId, mergeId)),
    db
      .update(matches)
      .set({ awayTeamId: keepId, ...by })
      .where(eq(matches.awayTeamId, mergeId)),
    db
      .update(matches)
      .set({ dutyTeamId: keepId, ...by })
      .where(eq(matches.dutyTeamId, mergeId)),
    db
      .update(ladderAdjustments)
      .set({ teamId: keepId, ...by })
      .where(eq(ladderAdjustments.teamId, mergeId)),
    db.update(groups).set({ teamId: keepId, updatedAt: at }).where(eq(groups.teamId, mergeId)),
    // Rosters and EOI placements follow (before B is deleted, which would cascade). A roster row that would collide
    // with one of A's (same season and player) is dropped; a merge across one season is refused, so that's only
    // a safety net.
    db
      .delete(seasonTeamPlayers)
      .where(
        and(
          eq(seasonTeamPlayers.teamId, mergeId),
          sql`exists (select 1 from ${seasonTeamPlayers} as k where k.team_id = ${keepId} and k.season_id = ${seasonTeamPlayers.seasonId} and k.player_id = ${seasonTeamPlayers.playerId})`,
        ),
      ),
    db
      .update(seasonTeamPlayers)
      .set({ teamId: keepId, ...by })
      .where(eq(seasonTeamPlayers.teamId, mergeId)),
    db
      .update(interestProgrammes)
      .set({ teamId: keepId, ...by })
      .where(eq(interestProgrammes.teamId, mergeId)),
    // The draw key lists team ids, so B's seasons would otherwise say "Settings changed".
    db
      .update(seasons)
      .set({ generatedFrom: sql`replace(${seasons.generatedFrom}, ${quoted(mergeId)}, ${quoted(keepId)})` })
      .where(and(inJson(seasons.id, memberSeasonIds), isNotNull(seasons.generatedFrom))),
    // B's page redirects to A's, and so does every redirect that led to it (old /team/<slug>/ links included).
    ...movePageStatements(db, gone.slug, keep.slug, by),
    db.delete(teams).where(eq(teams.id, mergeId)),
    db
      .update(teams)
      .set({ ...(wpIdMoved ? { wpId: gone.wpId } : {}), ...by })
      .where(eq(teams.id, keepId)),
    audit(
      db,
      actor,
      'team.merge',
      { type: 'team', id: keepId },
      { id: gone.id, name: gone.name, slug: gone.slug, wpId: gone.wpId, seasons: theirs.map((m) => m.seasonName), undo },
      { id: keep.id, name: keep.name, slug: keep.slug, seasons: keepSeasons.size + goneSeasons.size },
      at,
    ),
  ])
  return {
    result: {
      team: { id: keep.id, name: keep.name, slug: keep.slug, updatedAt: at },
      merged: { id: gone.id, name: gone.name },
      seasons: memberRows.filter((m) => m.teamId === keepId).length + theirs.length,
    },
    purge: { tags: [tags.site] },
  }
}

/** A merge in the last MERGE_UNDO_DAYS days, for Admin → Teams. */
export type RecentMerge = {
  auditId: string
  at: string
  kept: { id: string; name: string }
  merged: { id: string; name: string }
  /** Why it can't be undone (null: it can). */
  blocked: string | null
}

const undoRecordOf = (before: unknown): MergeUndoRecord | null => {
  const r = (before as { undo?: MergeUndoRecord } | null)?.undo
  return r && r.v === 1 && typeof r.team?.id === 'string' ? r : null
}

const undoCutoff = (now: Date) => new Date(now.getTime() - MERGE_UNDO_DAYS * 86_400_000).toISOString()

/** Merges of the last MERGE_UNDO_DAYS days, newest first, with whether each can still be undone. One batch. */
export async function recentMerges(db: AppDb, now = new Date()): Promise<RecentMerge[]> {
  const [rows, present] = (await runBatch(db, [
    db
      .select({ id: auditLog.id, at: auditLog.at, before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'team.merge'), gte(auditLog.at, undoCutoff(now))))
      .orderBy(desc(auditLog.at))
      .limit(20),
    // Which teams exist now (a hundred or so): the kept one must, the merged one mustn't (it's back if undone).
    db.select({ id: teams.id }).from(teams),
  ])) as unknown as [{ id: string; at: string; before: unknown; after: unknown }[], { id: string }[]]
  const exists = new Set(present.map((t) => t.id))
  return rows.map((r) => {
    const before = (r.before ?? {}) as { id?: string; name?: string }
    const after = (r.after ?? {}) as { id?: string; name?: string }
    const record = undoRecordOf(r.before)
    const merged = { id: before.id ?? '', name: before.name ?? '?' }
    const kept = { id: after.id ?? '', name: after.name ?? '?' }
    const blocked = !record
      ? 'This merge was made before merges could be undone.'
      : exists.has(merged.id)
        ? 'Already undone.'
        : !exists.has(kept.id)
          ? `${kept.name} has since been merged or deleted.`
          : null
    return { auditId: r.id, at: r.at, kept, merged, blocked }
  })
}

/**
 * Undoes a team merge from its audit row: B comes back with its id, name, slug and WordPress id, and its seasons,
 * games, duties, adjustments, enrolment groups, feed redirects and draw keys go back to it. Refused after
 * MERGE_UNDO_DAYS days, once undone (B exists again: the insert would fail anyway, so a double click can't apply it
 * twice), when A has gone, or when another team has taken B's name or web address since. One batch. Admins.
 * Audited as team.merge_undo; purges the site.
 */
export async function undoMerge(
  db: AppDb,
  actor: Editor,
  auditId: string,
  now = new Date(),
): Promise<Changed<{ team: Pick<Team, 'id' | 'name' | 'slug'>; kept: Pick<Team, 'id' | 'name'> }>> {
  idOf(auditId, 'Merge')
  const cannot = (why: string) => new HttpError(409, 'cannot_undo', why)
  const entry = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.id, auditId), eq(auditLog.action, 'team.merge')))
    .get()
  if (!entry) throw notFound('merge')
  const r = undoRecordOf(entry.before)
  if (!r) throw cannot('This merge was made before merges could be undone. Its details are in the audit log.')
  if (entry.at < undoCutoff(now)) throw cannot(`Merges can only be undone for ${MERGE_UNDO_DAYS} days.`)
  const b = r.team
  const clashes = await db
    .select({ id: teams.id, name: teams.name, slug: teams.slug, wpId: teams.wpId })
    .from(teams)
    .where(
      or(
        inArray(teams.id, [r.keepId, b.id]),
        eq(teams.slug, b.slug),
        sql`lower(${teams.name}) = ${b.name.toLowerCase()}`,
        ...(b.wpId !== null && !r.wpIdMoved ? [eq(teams.wpId, b.wpId)] : []),
      ),
    )
    .all()
  if (clashes.some((t) => t.id === b.id)) throw cannot(`${b.name} is back already: this merge has been undone.`)
  const keep = clashes.find((t) => t.id === r.keepId)
  if (!keep) throw cannot('The team it was merged into has since been merged or deleted, so this can’t be undone automatically.')
  const other = clashes.find((t) => t.id !== r.keepId)
  if (other)
    throw cannot(
      other.slug === b.slug
        ? `Another team (${other.name}) now has ${b.name}’s web address, so it can’t come back. Merge or rename that team first.`
        : `There's a team called “${other.name}” now. Rename it first.`,
    )
  const at = now.toISOString()
  const by = { updatedAt: at, updatedBy: actor.id }
  const keepFeed = `/teams/${r.keepSlug}.ics`
  const goneFeed = `/teams/${b.slug}.ics`
  const createdFeeds = r.feeds.filter((f) => f.previousToPath === null).map((f) => f.fromPath)
  const restoredFeeds = r.feeds.filter((f) => f.previousToPath !== null)
  const undoSeasonIds = [...new Set([...r.seasonIds, ...r.memberSeasonIds, ...(r.rosterSeasonIds ?? [])])]
  await runBatch(db, [
    // The WordPress id is unique, so A gives it back before B returns.
    ...(r.wpIdMoved && b.wpId !== null
      ? [
          db
            .update(teams)
            .set({ wpId: null })
            .where(and(eq(teams.id, r.keepId), eq(teams.wpId, b.wpId))),
        ]
      : []),
    db.insert(teams).values({ id: b.id, name: b.name, slug: b.slug, wpId: b.wpId, createdAt: b.createdAt, ...by }),
    db
      .update(seasonTeams)
      .set({ teamId: b.id, updatedAt: at })
      .where(and(eq(seasonTeams.teamId, r.keepId), inJson(seasonTeams.seasonId, r.memberSeasonIds))),
    db
      .update(matches)
      .set({ homeTeamId: b.id, ...by })
      .where(and(eq(matches.homeTeamId, r.keepId), inJson(matches.seasonId, r.seasonIds))),
    db
      .update(matches)
      .set({ awayTeamId: b.id, ...by })
      .where(and(eq(matches.awayTeamId, r.keepId), inJson(matches.seasonId, r.seasonIds))),
    db
      .update(matches)
      .set({ dutyTeamId: b.id, ...by })
      .where(and(eq(matches.dutyTeamId, r.keepId), inJson(matches.seasonId, r.seasonIds))),
    db
      .update(ladderAdjustments)
      .set({ teamId: b.id, ...by })
      .where(and(eq(ladderAdjustments.teamId, r.keepId), inJson(ladderAdjustments.seasonId, r.seasonIds))),
    db
      .update(groups)
      .set({ teamId: b.id, updatedAt: at })
      .where(and(eq(groups.teamId, r.keepId), inJson(groups.id, r.groupIds))),
    // Rosters and EOI placements go back by season: in B's seasons, A's rows are B's (a merge across a shared season
    // is refused), including players added or EOIs placed into "A" there since the merge.
    db
      .update(seasonTeamPlayers)
      .set({ teamId: b.id, ...by })
      .where(and(eq(seasonTeamPlayers.teamId, r.keepId), inJson(seasonTeamPlayers.seasonId, undoSeasonIds))),
    db
      .update(interestProgrammes)
      .set({ teamId: b.id, ...by })
      .where(
        and(
          eq(interestProgrammes.teamId, r.keepId),
          or(
            inJson(interestProgrammes.seasonId, undoSeasonIds),
            // Placements recorded without a season (programmes with none) go back by key, as merged.
            sql`(${interestProgrammes.interestId} || '|' || ${interestProgrammes.programmeId}) in (select value from json_each(${JSON.stringify(r.interestKeys ?? [])}))`,
          ),
        ),
      ),
    db
      .update(seasons)
      .set({ generatedFrom: sql`replace(${seasons.generatedFrom}, ${quoted(r.keepId)}, ${quoted(b.id)})` })
      .where(and(inJson(seasons.id, r.memberSeasonIds), isNotNull(seasons.generatedFrom))),
    db
      .update(redirects)
      .set({ toPath: sql`replace(${redirects.toPath}, ${keepFeed}, ${goneFeed})`, ...by })
      .where(and(inJson(redirects.id, r.repointedRedirectIds), like(redirects.toPath, `%${keepFeed}`))),
    db.delete(redirects).where(and(inJson(redirects.fromPath, createdFeeds), like(redirects.toPath, `%${keepFeed}`))),
    ...restoredFeeds.map((f) =>
      db
        .update(redirects)
        .set({ toPath: f.previousToPath!, ...by })
        .where(eq(redirects.fromPath, f.fromPath)),
    ),
    // B's page is B's again: redirects that led to it go back, and its own redirect to A's page goes (or is restored).
    ...(r.pageRedirectIds
      ? [
          db
            .update(redirects)
            .set({ toPath: teamPath(b.slug), ...by })
            .where(and(inJson(redirects.id, r.pageRedirectIds), eq(redirects.toPath, teamPath(r.keepSlug)))),
          r.pagePreviousToPath
            ? db
                .update(redirects)
                .set({ toPath: r.pagePreviousToPath, ...by })
                .where(eq(redirects.fromPath, teamPath(b.slug)))
            : db.delete(redirects).where(and(eq(redirects.fromPath, teamPath(b.slug)), eq(redirects.toPath, teamPath(r.keepSlug)))),
        ]
      : []),
    db.update(teams).set(by).where(eq(teams.id, r.keepId)),
    audit(
      db,
      actor,
      'team.merge_undo',
      { type: 'team', id: b.id },
      { id: keep.id, name: keep.name },
      { id: b.id, name: b.name, slug: b.slug, mergeAuditId: auditId },
      at,
    ),
  ])
  return {
    result: { team: { id: b.id, name: b.name, slug: b.slug }, kept: { id: keep.id, name: keep.name } },
    purge: { tags: [tags.site] },
  }
}
