import { asc, eq, like, or, sql } from 'drizzle-orm'
import { slugify } from '../../lib/content/paths'
import { tags } from '../cache'
import { runBatch, type AppDb } from '../db'
import { seasons, seasonTeams, teams, type Team } from '../db/schema'
import { audit, isUniqueFailure, notFound, type Changed, type Editor } from '../content/common'
import { HttpError } from '../http'
import { text } from './input'

// Teams persist across seasons (SportsPress had 88). Admins create and rename them; who plays in a season is
// season_teams (seasons.ts setSeasonTeams). Renaming keeps the slug, so old /team/<slug>/ redirects keep working.

export type TeamListItem = Pick<Team, 'id' | 'name' | 'slug' | 'createdAt' | 'updatedAt'> & {
  /** The newest season the team is in, if any. */
  lastSeason: { id: string; name: string; year: number; quarter: number; leagueId: string } | null
  seasons: number
}

export async function listTeams(db: AppDb): Promise<TeamListItem[]> {
  const [teamRows, memberRows] = (await runBatch(db, [
    db
      .select({ id: teams.id, name: teams.name, slug: teams.slug, createdAt: teams.createdAt, updatedAt: teams.updatedAt })
      .from(teams)
      .orderBy(asc(sql`lower(${teams.name})`)),
    db
      .select({
        teamId: seasonTeams.teamId,
        id: seasons.id,
        name: seasons.name,
        year: seasons.year,
        quarter: seasons.quarter,
        leagueId: seasons.leagueId,
      })
      .from(seasonTeams)
      .innerJoin(seasons, eq(seasons.id, seasonTeams.seasonId)),
  ])) as unknown as [
    Pick<Team, 'id' | 'name' | 'slug' | 'createdAt' | 'updatedAt'>[],
    ({ teamId: string } & NonNullable<TeamListItem['lastSeason']>)[],
  ]
  const last = new Map<string, NonNullable<TeamListItem['lastSeason']>>()
  const count = new Map<string, number>()
  for (const { teamId, ...s } of memberRows) {
    count.set(teamId, (count.get(teamId) ?? 0) + 1)
    const prev = last.get(teamId)
    if (!prev || s.year * 10 + s.quarter > prev.year * 10 + prev.quarter) last.set(teamId, s)
  }
  return teamRows.map((t) => ({ ...t, lastSeason: last.get(t.id) ?? null, seasons: count.get(t.id) ?? 0 }))
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
  return { ...row, createdAt: at, updatedAt: at, lastSeason: null, seasons: 0 }
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
