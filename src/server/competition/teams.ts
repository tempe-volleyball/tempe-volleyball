import { asc, eq, inArray, like, or, sql } from 'drizzle-orm'
import { slugify } from '../../lib/content/paths'
import { teamCalendarPath } from '../../lib/fixture-lists'
import { tags } from '../cache'
import { runBatch, type AppDb } from '../db'
import { groups, ladderAdjustments, leagues, matches, redirects, seasons, seasonTeams, teams, type Season, type Team } from '../db/schema'
import { audit, isUniqueFailure, notFound, type Changed, type Editor } from '../content/common'
import { HttpError } from '../http'
import { id as idOf, text } from './input'

// Teams persist across seasons (SportsPress had 88). Admins create, rename and merge them (Admin → Teams); who plays
// in a season is season_teams (seasons.ts setSeasonTeams). Renaming keeps the slug, so old /team/<slug>/ redirects
// and team calendar feeds keep working.

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

/** A slug for a new team: from its name, with -2, -3 … if taken. */
async function freeSlug(db: AppDb, name: string) {
  const base = slugify(name, 60) || 'team'
  const taken = new Set(
    (
      await db
        .select({ slug: teams.slug })
        .from(teams)
        .where(or(eq(teams.slug, base), like(teams.slug, `${base}-%`)))
        .all()
    ).map((r) => r.slug),
  )
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

export async function createTeam(db: AppDb, actor: Editor, input: { name?: unknown }, now = new Date()): Promise<TeamListItem> {
  const name = teamName(input.name)
  await assertNameFree(db, name)
  const row = { id: crypto.randomUUID(), name, slug: await freeSlug(db, name) }
  const at = now.toISOString()
  try {
    await runBatch(db, [
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
  await runBatch(db, [
    db.update(teams).set({ name, updatedAt: at, updatedBy: actor.id }).where(eq(teams.id, teamId)),
    audit(db, actor, 'team.rename', { type: 'team', id: teamId }, { name: team.name }, { name }, at),
  ])
  return { result: { id: teamId, name, slug: team.slug, updatedAt: at }, purge: { tags: [tags.site] } }
}

export type MergeTeamsInput = { mergeId?: unknown }
export type MergeResult = { team: Pick<Team, 'id' | 'name' | 'slug' | 'updatedAt'>; merged: { id: string; name: string }; seasons: number }

/** A team's calendar feed (src/pages/leagues/[league]/teams/[team].ics.ts). */
const teamFeedPath = teamCalendarPath

/**
 * Merges duplicate team B (`mergeId`) into team A (`keepId`): every season B played in, its games (home, away and
 * duty), ladder adjustments and enrolment groups now point at A, and B is deleted. Refused when the two were in the
 * same season (that's two real teams). A keeps its name and slug; B's team calendar feeds 301 to A's, and B's
 * WordPress id moves to A when A has none (so a re-import finds it). One batch whatever the number of games: each
 * re-point is a single UPDATE … WHERE team_id = B (2 parameters). Admins. Audited as team.merge; purges the site.
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
  const [teamRows, memberRows] = (await runBatch(db, [
    db
      .select()
      .from(teams)
      .where(inArray(teams.id, [keepId, mergeId])),
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
      .where(inArray(seasonTeams.teamId, [keepId, mergeId])),
  ])) as unknown as [Team[], { teamId: string; seasonId: string; seasonName: string; leagueSlug: string }[]]
  const keep = teamRows.find((t) => t.id === keepId)
  const gone = teamRows.find((t) => t.id === mergeId)
  if (!keep || !gone) throw notFound('team')
  const keepSeasons = new Set(memberRows.filter((m) => m.teamId === keepId).map((m) => m.seasonId))
  const theirs = memberRows.filter((m) => m.teamId === mergeId)
  const shared = theirs.filter((m) => keepSeasons.has(m.seasonId))
  if (shared.length)
    throw new HttpError(
      409,
      'same_season',
      `${keep.name} and ${gone.name} both played in ${shared.map((m) => m.seasonName).join(', ')}, so they're different teams. Rename one instead.`,
    )
  const at = now.toISOString()
  const by = { updatedAt: at, updatedBy: actor.id }
  const feeds = [...new Set(theirs.map((m) => m.leagueSlug))].map((slug) => ({
    id: crypto.randomUUID(),
    fromPath: teamFeedPath(slug, gone.slug),
    toPath: teamFeedPath(slug, keep.slug),
    status: 301,
    source: 'manual' as const,
    createdAt: at,
    ...by,
  }))
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
    // Feeds that pointed at B's now point at A's (no chains), then B's own feeds redirect.
    db
      .update(redirects)
      .set({ toPath: sql`replace(${redirects.toPath}, ${`/teams/${gone.slug}.ics`}, ${`/teams/${keep.slug}.ics`})`, ...by })
      .where(like(redirects.toPath, `%/teams/${gone.slug}.ics`)),
    // 5 parameters a row (id, from, to, status, source + 3 stamps): ≤ 12 rows a statement keeps under 100.
    ...Array.from({ length: Math.ceil(feeds.length / 12) }, (_, i) =>
      db
        .insert(redirects)
        .values(feeds.slice(i * 12, i * 12 + 12))
        .onConflictDoUpdate({ target: redirects.fromPath, set: { toPath: sql`excluded.to_path`, ...by } }),
    ),
    db.delete(teams).where(eq(teams.id, mergeId)),
    db
      .update(teams)
      .set({ ...(keep.wpId === null && gone.wpId !== null ? { wpId: gone.wpId } : {}), ...by })
      .where(eq(teams.id, keepId)),
    audit(
      db,
      actor,
      'team.merge',
      { type: 'team', id: keepId },
      { id: gone.id, name: gone.name, slug: gone.slug, wpId: gone.wpId, seasons: theirs.map((m) => m.seasonName) },
      { id: keep.id, name: keep.name, slug: keep.slug, seasons: keepSeasons.size + theirs.length },
      at,
    ),
  ])
  return {
    result: {
      team: { id: keep.id, name: keep.name, slug: keep.slug, updatedAt: at },
      merged: { id: gone.id, name: gone.name },
      seasons: keepSeasons.size + theirs.length,
    },
    purge: { tags: [tags.site] },
  }
}
