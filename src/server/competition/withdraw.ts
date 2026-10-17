import { and, desc, eq, inArray } from 'drizzle-orm'
import { sydneyDate } from '../../lib/time'
import { runBatch, type AppDb } from '../db'
import { auditLog, matches, matchResults, seasons, seasonTeams, type Match } from '../db/schema'
import { HttpError } from '../http'
import { audit, notFound, type Changed, type Editor } from '../content/common'
import { MAX_PARAMS } from './draw'
import { baseUpdatedAt, bool, date, id, invalid, text } from './input'
import { archived, conflict, getSeason, loadSeason, seasonPurge, type SeasonView } from './seasons'

// Withdrawn teams (docs/admin.md §1 "Ladders"). A team that pulls out mid-season stays in the season (its history
// and results stay), marked withdrawn with a reason. How it then shows is the season's policy (settings.withdrawn:
// marked or hidden on the ladder, its results kept or voided, its cancelled games shown as cancelled or as byes),
// which can change at any time without touching the data.
//
// Withdrawing can cancel its remaining games: every game it plays from `from` (default: today, Sydney) that has no
// published result and isn't already off. Reinstating undoes exactly those (as the audit log recorded them), if
// they're still cancelled. Games it has duty on are left alone and counted, so the admin can sort out a referee.

export type WithdrawInput = { baseUpdatedAt?: unknown; reason?: unknown; cancelFixtures?: unknown; from?: unknown }
export type WithdrawResult = SeasonView & { cancelled: number; dutyGames: number }
export type ReinstateResult = SeasonView & { restored: number }

const target = (seasonId: string, teamId: string) => ({ type: 'season_team', id: `${seasonId}:${teamId}` })

async function loadWritable(db: AppDb, seasonId: string, teamId: string, base: string) {
  const d = await loadSeason(db, seasonId)
  if (d.season.status === 'archived') throw archived()
  if (d.season.status !== 'published')
    throw new HttpError(409, 'season_not_published', 'On a draft season, take the team off the team list instead.')
  if (base !== d.season.updatedAt) throw conflict()
  const team = d.teams.find((t) => t.id === teamId)
  if (!team) throw notFound('team in this season')
  return { d, team }
}

const chunks = <T>(list: T[], size = MAX_PARAMS - 4) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size))

/** Marks a team withdrawn from a published season, optionally cancelling its remaining games. Admins. Audited as team.withdraw. */
export async function withdrawTeam(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  teamId: string,
  input: WithdrawInput,
  now = new Date(),
): Promise<Changed<WithdrawResult>> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  id(teamId, 'Team')
  const reason = text(input.reason, 'Reason', 200, { required: true })
  const cancelFixtures = input.cancelFixtures === undefined ? true : bool(input.cancelFixtures, 'cancelFixtures')
  const from = input.from === undefined || input.from === null ? sydneyDate(now) : date(input.from, 'From')
  const { d, team } = await loadWritable(db, seasonId, teamId, base)
  if (team.withdrawnAt) throw new HttpError(409, 'already_withdrawn', `${team.name} has already withdrawn.`)

  const dayDate = new Map(d.matchDays.map((m) => [m.id, m.date]))
  const published = new Set(d.results.filter((r) => r.kind === 'published').map((r) => r.matchId))
  const remaining = (m: Match) => (dayDate.get(m.matchDayId) ?? '') >= from && !published.has(m.id)
  const playing = d.matches.filter((m) => m.homeTeamId === teamId || m.awayTeamId === teamId)
  const toCancel = cancelFixtures
    ? playing.filter((m) => remaining(m) && m.status !== 'cancelled' && m.status !== 'postponed' && m.status !== 'tbd')
    : []
  const dutyGames = d.matches.filter((m) => m.dutyTeamId === teamId && remaining(m) && m.status !== 'cancelled').length
  const at = now.toISOString()
  const ids = toCancel.map((m) => m.id)
  const note = `${team.name} withdrew`
  await runBatch(db, [
    db
      .update(seasonTeams)
      .set({ withdrawnAt: at, withdrawnReason: reason, updatedAt: at })
      .where(and(eq(seasonTeams.seasonId, seasonId), eq(seasonTeams.teamId, teamId))),
    ...chunks(ids).flatMap((chunk) => [
      db
        .update(matches)
        .set({ status: 'cancelled', statusNote: note, updatedAt: at, updatedBy: actor.id })
        .where(inArray(matches.id, chunk)),
      db.delete(matchResults).where(and(eq(matchResults.kind, 'draft'), inArray(matchResults.matchId, chunk))),
    ]),
    db.update(seasons).set({ updatedAt: at, updatedBy: actor.id }).where(eq(seasons.id, seasonId)),
    audit(
      db,
      actor,
      'team.withdraw',
      target(seasonId, teamId),
      { season: d.season.name, team: team.name },
      {
        season: d.season.name,
        team: team.name,
        reason,
        from,
        cancelled: Object.fromEntries(toCancel.map((m) => [m.id, m.status])),
        dutyGames,
      },
      at,
    ),
  ])
  return { result: { ...(await getSeason(db, seasonId)), cancelled: ids.length, dutyGames }, purge: seasonPurge(d) }
}

/** Undoes a withdrawal: the team is back in, and the games the withdrawal cancelled (if still cancelled) are restored. */
export async function reinstateTeam(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  teamId: string,
  input: { baseUpdatedAt?: unknown },
  now = new Date(),
): Promise<Changed<ReinstateResult>> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  id(teamId, 'Team')
  const { d, team } = await loadWritable(db, seasonId, teamId, base)
  if (!team.withdrawnAt) throw invalid(`${team.name} hasn’t withdrawn.`)
  const t = target(seasonId, teamId)
  const entry = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'team.withdraw'), eq(auditLog.targetType, t.type), eq(auditLog.targetId, t.id)))
    .orderBy(desc(auditLog.at))
    .limit(1)
    .get()
  const cancelled = ((entry?.after ?? {}) as { cancelled?: Record<string, Match['status']> }).cancelled ?? {}
  const published = new Set(d.results.filter((r) => r.kind === 'published').map((r) => r.matchId))
  const groups = new Map<Match['status'], string[]>()
  for (const m of d.matches) {
    const was = cancelled[m.id]
    if (!was || m.status !== 'cancelled') continue
    const to = was === 'played' && !published.has(m.id) ? 'scheduled' : was
    groups.set(to, [...(groups.get(to) ?? []), m.id])
  }
  const at = now.toISOString()
  await runBatch(db, [
    db
      .update(seasonTeams)
      .set({ withdrawnAt: null, withdrawnReason: null, updatedAt: at })
      .where(and(eq(seasonTeams.seasonId, seasonId), eq(seasonTeams.teamId, teamId))),
    ...[...groups].flatMap(([status, ids]) =>
      chunks(ids).map((chunk) =>
        db.update(matches).set({ status, statusNote: null, updatedAt: at, updatedBy: actor.id }).where(inArray(matches.id, chunk)),
      ),
    ),
    db.update(seasons).set({ updatedAt: at, updatedBy: actor.id }).where(eq(seasons.id, seasonId)),
    audit(
      db,
      actor,
      'team.reinstate',
      t,
      { season: d.season.name, team: team.name, reason: team.withdrawnReason },
      { season: d.season.name, team: team.name, restored: [...groups.values()].flat().length },
      at,
    ),
  ])
  const restored = [...groups.values()].flat().length
  return { result: { ...(await getSeason(db, seasonId)), restored }, purge: seasonPurge(d) }
}
