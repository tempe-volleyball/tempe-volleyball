import { and, asc, eq, inArray } from 'drizzle-orm'
import { runBatch, type AppDb } from '../db'
import { ladderAdjustments, leagues, seasons, seasonTeams, type LadderAdjustment, type League, type Season } from '../db/schema'
import { audit, notFound, type Changed, type Editor } from '../content/common'
import { int, invalid, isId, text } from './input'
import { archived, seasonPurge } from './seasons'

// Ladder adjustments: points added to (or taken off) a team's ladder total, with a reason. Penalties, and the
// importer's reconciliation with hand-adjusted SportsPress tables. Admins only; archived seasons are read-only.
// Each change is audited as ladder.adjust and purges the season's pages (once it's public).

export type AdjustmentRow = Pick<LadderAdjustment, 'id' | 'teamId' | 'points' | 'reason' | 'createdAt' | 'updatedAt'>

const columns = {
  id: ladderAdjustments.id,
  teamId: ladderAdjustments.teamId,
  points: ladderAdjustments.points,
  reason: ladderAdjustments.reason,
  createdAt: ladderAdjustments.createdAt,
  updatedAt: ladderAdjustments.updatedAt,
}

export const listAdjustments = (db: AppDb, seasonId: string): Promise<AdjustmentRow[]> =>
  db.select(columns).from(ladderAdjustments).where(eq(ladderAdjustments.seasonId, seasonId)).orderBy(asc(ladderAdjustments.createdAt)).all()

async function loadSeason(db: AppDb, seasonId: string) {
  const [seasonRows, leagueRows, memberRows, adjustmentRows] = (await runBatch(db, [
    db.select().from(seasons).where(eq(seasons.id, seasonId)),
    db
      .select()
      .from(leagues)
      .where(inArray(leagues.id, db.select({ id: seasons.leagueId }).from(seasons).where(eq(seasons.id, seasonId)))),
    db.select({ teamId: seasonTeams.teamId }).from(seasonTeams).where(eq(seasonTeams.seasonId, seasonId)),
    db.select().from(ladderAdjustments).where(eq(ladderAdjustments.seasonId, seasonId)),
  ])) as unknown as [Season[], League[], { teamId: string }[], LadderAdjustment[]]
  const season = seasonRows[0]
  const league = leagueRows[0]
  if (!season || !league) throw notFound('season')
  if (season.status === 'archived') throw archived()
  return { season, league, members: new Set(memberRows.map((r) => r.teamId)), adjustments: adjustmentRows }
}

const points = (v: unknown) => {
  const n = int(v, 'Points', -100, 100)
  if (n === 0) throw invalid('An adjustment of 0 points does nothing.')
  return n
}
const reason = (v: unknown) => text(v, 'Reason', 200, { required: true })

const snapshot = (a: Pick<LadderAdjustment, 'teamId' | 'points' | 'reason'>) => ({ teamId: a.teamId, points: a.points, reason: a.reason })

export type AdjustmentInput = { teamId?: unknown; points?: unknown; reason?: unknown }

export async function addAdjustment(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  input: AdjustmentInput,
  now = new Date(),
): Promise<Changed<AdjustmentRow[]>> {
  const s = await loadSeason(db, seasonId)
  if (!isId(input.teamId) || !s.members.has(input.teamId)) throw invalid('That team isn’t in this season.')
  const row = { id: crypto.randomUUID(), seasonId, teamId: input.teamId, points: points(input.points), reason: reason(input.reason) }
  const at = now.toISOString()
  await runBatch(db, [
    db.insert(ladderAdjustments).values({ ...row, createdAt: at, updatedAt: at, updatedBy: actor.id }),
    audit(db, actor, 'ladder.adjust', { type: 'ladder_adjustment', id: row.id }, null, { season: s.season.name, ...snapshot(row) }, at),
  ])
  return { result: await listAdjustments(db, seasonId), purge: seasonPurge(s) }
}

export async function updateAdjustment(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  adjustmentId: string,
  input: AdjustmentInput,
  now = new Date(),
): Promise<Changed<AdjustmentRow[]>> {
  const s = await loadSeason(db, seasonId)
  const current = s.adjustments.find((a) => a.id === adjustmentId)
  if (!current) throw notFound('adjustment')
  const next = {
    points: input.points === undefined ? current.points : points(input.points),
    reason: input.reason === undefined ? current.reason : reason(input.reason),
  }
  const at = now.toISOString()
  await runBatch(db, [
    db
      .update(ladderAdjustments)
      .set({ ...next, updatedAt: at, updatedBy: actor.id })
      .where(and(eq(ladderAdjustments.id, adjustmentId), eq(ladderAdjustments.seasonId, seasonId))),
    audit(
      db,
      actor,
      'ladder.adjust',
      { type: 'ladder_adjustment', id: adjustmentId },
      { season: s.season.name, ...snapshot(current) },
      { season: s.season.name, ...snapshot({ ...current, ...next }) },
      at,
    ),
  ])
  return { result: await listAdjustments(db, seasonId), purge: seasonPurge(s) }
}

export async function deleteAdjustment(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  adjustmentId: string,
  now = new Date(),
): Promise<Changed<AdjustmentRow[]>> {
  const s = await loadSeason(db, seasonId)
  const current = s.adjustments.find((a) => a.id === adjustmentId)
  if (!current) throw notFound('adjustment')
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(ladderAdjustments).where(and(eq(ladderAdjustments.id, adjustmentId), eq(ladderAdjustments.seasonId, seasonId))),
    audit(
      db,
      actor,
      'ladder.adjust',
      { type: 'ladder_adjustment', id: adjustmentId },
      { season: s.season.name, ...snapshot(current) },
      null,
      at,
    ),
  ])
  return { result: await listAdjustments(db, seasonId), purge: seasonPurge(s) }
}
