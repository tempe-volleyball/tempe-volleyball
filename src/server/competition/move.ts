import { and, desc, eq } from 'drizzle-orm'
import { courtClashes, courtName, formatAU, isOffStatus, moveToNight, refName, type Game } from '../../lib/fixtures'
import { runBatch, type AppDb } from '../db'
import { auditLog, matchDays, matches, seasons, type Match } from '../db/schema'
import { HttpError } from '../http'
import { audit, isUniqueFailure, notFound, type Changed, type Editor } from '../content/common'
import { toCompetition } from './adapter'
import { clashDraws } from './clashes'
import { baseUpdatedAt, date, id, int, invalid } from './input'
import { archived, conflict, getSeason, loadSeason, resolverFor, seasonPurge, type LoadedSeason, type SeasonView } from './seasons'

// Moving one game to another night (docs/admin.md §1 "Matches", §3.11): typically a postponed game replayed later.
// The plan is the lib's moveToNight(), the same function the admin previews with; the server runs it on its own copy
// of the draw, then checks court clashes with the other leagues at the venue on that date (courtClashes). One batch,
// audited as match.move with everything needed to put it back; "undo" (match.move_undo) does that while the game is
// still where the move put it and has no published result. Admins only: it changes a published draw.

export type MoveMatchInput = {
  baseUpdatedAt?: unknown
  /** A night already in the season… */
  toWeekId?: unknown
  /** …or a date: that season's night on the date, or a new catch-up night. */
  date?: unknown
  session?: unknown
  position?: unknown
}

export type MoveMatchResult = SeasonView & { warnings: string[]; created: boolean }

/** What match.move records, so the move can be undone exactly. */
type MoveRecord = {
  season: string
  game: string
  matchDayId: string
  date: string
  session: number
  position: number
  startTime: string | null
  courtId: string | null
  status: Match['status']
  statusNote: string | null
  originalMatchDayId: string | null
  createdDay?: boolean
}

const cannotMove = (message: string) => new HttpError(409, 'cannot_move', message)

function assertOpen(d: LoadedSeason, base: string) {
  if (d.season.status === 'archived') throw archived()
  if (d.season.status !== 'published')
    throw new HttpError(409, 'season_not_published', 'On a draft season, drag the game on the Fixtures tab instead.')
  if (base !== d.season.updatedAt) throw conflict()
}

const gameLabel = (d: LoadedSeason, g: Pick<Game, 'home' | 'away'>) => {
  const s = toCompetition(d).settings
  return `${refName(s, g.home)} v ${refName(s, g.away)}`
}

/** Moves one game to another night of the same season (existing or new). Admins. Audited as match.move. */
export async function moveMatch(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  matchId: string,
  input: MoveMatchInput,
  now = new Date(),
): Promise<Changed<MoveMatchResult>> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  id(matchId, 'Match')
  const toWeekId = input.toWeekId === undefined || input.toWeekId === null ? undefined : id(input.toWeekId, 'Night')
  const day = toWeekId ? undefined : date(input.date, 'Date')
  const session = int(input.session, 'Session', 0, 7)
  const position = int(input.position, 'Court position', 0, 11)
  const d = await loadSeason(db, seasonId)
  assertOpen(d, base)
  const match = d.matches.find((m) => m.id === matchId)
  if (!match) throw notFound('game')
  const c = toCompetition(d)
  const newWeekId = crypto.randomUUID()
  const r = moveToNight(c.settings, c.weeks, matchId, { weekId: toWeekId, date: day, newWeekId, session, position })
  if (!r.plan) throw cannotMove(r.problem)
  const { plan } = r

  // Courts the other leagues at this venue use that night.
  const others = await clashDraws(db, seasonId, { from: plan.to.date, to: plan.to.date })
  const clash = courtClashes([
    { seasonId, label: d.season.name, venue: others.venue ?? '', settings: c.settings, weeks: [plan.to] },
    ...others.draws,
  ]).find((x) => x.bookings.some((b) => b.gameId === matchId))
  if (clash) throw cannotMove(`That court is taken: ${clash.message}`)

  const resolver = resolverFor(d)
  const courtId = resolver.id(courtName(c.settings, plan.to, session, position), 'Court') || null
  const from = d.matchDays.find((m) => m.id === match.matchDayId)!
  const off = isOffStatus(match.status)
  const at = now.toISOString()
  const label = gameLabel(d, plan.game)
  const before: MoveRecord = {
    season: d.season.name,
    game: label,
    matchDayId: match.matchDayId,
    date: from.date,
    session: match.session,
    position: match.position,
    startTime: match.startTime,
    courtId: match.courtId,
    status: match.status,
    statusNote: match.statusNote,
    originalMatchDayId: match.originalMatchDayId,
  }
  try {
    await runBatch(db, [
      ...(plan.created
        ? [
            db.insert(matchDays).values({
              id: plan.to.id,
              seasonId,
              date: plan.to.date,
              kind: plan.to.kind,
              number: plan.to.matchDay,
              courtOverrides: {},
              status: 'scheduled',
              createdAt: at,
              updatedAt: at,
              updatedBy: actor.id,
            }),
          ]
        : []),
      db
        .update(matches)
        .set({
          matchDayId: plan.to.id,
          session,
          position,
          startTime: c.settings.sessions[session] ?? null,
          courtId,
          originalMatchDayId: plan.game.originalWeekId ?? null,
          ...(off ? { status: 'scheduled' as const, statusNote: null } : {}),
          updatedAt: at,
          updatedBy: actor.id,
        })
        .where(eq(matches.id, matchId)),
      db.update(matchDays).set({ updatedAt: at, updatedBy: actor.id }).where(eq(matchDays.id, from.id)),
      ...(plan.created ? [] : [db.update(matchDays).set({ updatedAt: at, updatedBy: actor.id }).where(eq(matchDays.id, plan.to.id))]),
      db.update(seasons).set({ updatedAt: at, updatedBy: actor.id }).where(eq(seasons.id, seasonId)),
      audit(
        db,
        actor,
        'match.move',
        { type: 'match', id: matchId },
        before,
        {
          season: d.season.name,
          game: label,
          matchDayId: plan.to.id,
          date: plan.to.date,
          session,
          position,
          createdDay: plan.created,
          warnings: plan.warnings,
        },
        at,
      ),
    ])
  } catch (e) {
    if (isUniqueFailure(e)) throw cannotMove('This season already has a night on that date. Pick it from the list instead.')
    throw e
  }
  return { result: { ...(await getSeason(db, seasonId)), warnings: plan.warnings, created: plan.created }, purge: seasonPurge(d) }
}

/** Puts back the game's last move, while it's still where that move put it and has no published result. Admins. */
export async function undoMoveMatch(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  matchId: string,
  input: { baseUpdatedAt?: unknown },
  now = new Date(),
): Promise<Changed<SeasonView>> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  id(matchId, 'Match')
  const d = await loadSeason(db, seasonId)
  assertOpen(d, base)
  const match = d.matches.find((m) => m.id === matchId)
  if (!match) throw notFound('game')
  const entry = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, 'match.move'), eq(auditLog.targetType, 'match'), eq(auditLog.targetId, matchId)))
    .orderBy(desc(auditLog.at))
    .limit(1)
    .get()
  const was = entry?.before as MoveRecord | undefined
  const moved = entry?.after as (Pick<MoveRecord, 'matchDayId' | 'date' | 'session' | 'position'> & { createdDay?: boolean }) | undefined
  const cannot = (why: string) => new HttpError(409, 'cannot_undo', why)
  if (!was || !moved) throw cannot('This game hasn’t been moved.')
  if (match.matchDayId !== moved.matchDayId || match.session !== moved.session || match.position !== moved.position)
    throw cannot('The game has moved again since, so that move can’t be undone. Move it by hand instead.')
  if (d.results.some((x) => x.matchId === matchId && x.kind === 'published'))
    throw cannot('The game has a published result now, so it can’t move back.')
  const home = d.matchDays.find((m) => m.id === was.matchDayId)
  if (!home) throw cannot('The night it came from no longer exists.')
  if (d.matches.some((m) => m.id !== matchId && m.matchDayId === home.id && m.session === was.session && m.position === was.position))
    throw cannot(`Its old slot on ${formatAU(home.date)} has another game in it now.`)
  const emptied = !!moved.createdDay && !d.matches.some((m) => m.id !== matchId && m.matchDayId === moved.matchDayId)
  const at = now.toISOString()
  await runBatch(db, [
    db
      .update(matches)
      .set({
        matchDayId: was.matchDayId,
        session: was.session,
        position: was.position,
        startTime: was.startTime,
        courtId: was.courtId,
        status: was.status,
        statusNote: was.statusNote,
        originalMatchDayId: was.originalMatchDayId,
        updatedAt: at,
        updatedBy: actor.id,
      })
      .where(eq(matches.id, matchId)),
    // The catch-up night it made goes too, once it's empty.
    emptied
      ? db.delete(matchDays).where(and(eq(matchDays.id, moved.matchDayId), eq(matchDays.seasonId, seasonId)))
      : db.update(matchDays).set({ updatedAt: at, updatedBy: actor.id }).where(eq(matchDays.id, moved.matchDayId)),
    db.update(matchDays).set({ updatedAt: at, updatedBy: actor.id }).where(eq(matchDays.id, was.matchDayId)),
    db.update(seasons).set({ updatedAt: at, updatedBy: actor.id }).where(eq(seasons.id, seasonId)),
    audit(
      db,
      actor,
      'match.move_undo',
      { type: 'match', id: matchId },
      { season: d.season.name, game: was.game, date: moved.date },
      { season: d.season.name, game: was.game, date: was.date, removedNight: emptied },
      at,
    ),
  ])
  return { result: await getSeason(db, seasonId), purge: seasonPurge(d) }
}

export const parseMoveAction = (v: unknown): 'move' | 'undo' => {
  if (v === undefined || v === null || v === 'move') return 'move'
  if (v === 'undo') return 'undo'
  throw invalid('action must be move or undo.')
}
