import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { nightNote, pushBack, type SkipDate } from '../../lib/fixtures'
import { runBatch, type AppDb } from '../db'
import { auditLog, matchDays, matches, matchResults, seasons, type AuditAction, type Match, type MatchDay } from '../db/schema'
import { HttpError } from '../http'
import { audit, notFound, type Changed, type Editor } from '../content/common'
import { toCompetition } from './adapter'
import { MAX_PARAMS } from './draw'
import { baseUpdatedAt, bool, invalid, text } from './input'
import { archived, conflict, getSeason, loadSeason, seasonPurge, type LoadedSeason, type SeasonView } from './seasons'

// A whole game night at once (docs/admin.md §1 "Bulk postpone or cancel"): postpone or cancel every game on a match
// day, optionally pushing the rest of the season back a week, and restore (undo) either.
//
//  - postpone / cancel: the night (match_days.status) and every game on it that isn't already off. The reason is the
//    night's public note. Cancelling also throws away the games' draft results (as cancelling one game does).
//  - with pushBack: the games aren't marked at all. The night and every later playing night move a week (the lib's
//    pushBack(), which the admin previews with the same code), and the old date becomes a week off whose status and
//    note say why. Results, duty and courts stay attached because the games keep their ids.
//  - restore: undoes the latest postpone/cancel of that night, or the push-back that made that week off, using what
//    the audit log recorded. A push-back can only be undone while the nights are still where it put them.
//
// Published seasons only (a draft's dates change in Setup); archived ones are read-only. The token is the season's
// updatedAt; the season and every match day touched get new tokens, and the response is the whole season view.
// Dates are moved in two statements whatever the number of nights: first to a unique temporary value, then to their
// new dates, so the (season_id, date) unique index never sees two nights on one date mid-update.

export type NightAction = 'postpone' | 'cancel' | 'restore'
export type NightInput = { baseUpdatedAt?: unknown; action?: unknown; note?: unknown; pushBack?: unknown }

/** What a postpone/cancel recorded in the audit log, so restore can put it back. */
type NightAudit = { status: MatchDay['status']; note: string | null; matchStatuses: Record<string, Match['status']> }
/** What a push-back recorded. */
type PushAudit = {
  dates: Record<string, string>
  originalDates: Record<string, string | null>
  skipDates: SkipDate[]
  skipDayIds: string[]
}

const cannotUndo = (message: string) => new HttpError(409, 'cannot_undo', message)
const notPublished = () =>
  new HttpError(409, 'season_not_published', 'Only a published season’s nights can be postponed. On a draft, change the dates in Setup.')

/** The latest audit entry of these actions for a match day: what restore undoes. */
async function latestAudit(db: AppDb, dayId: string, actions: AuditAction[]) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.targetType, 'match_day'), eq(auditLog.targetId, dayId), inArray(auditLog.action, actions)))
    .orderBy(desc(auditLog.at))
    .limit(1)
    .get()
}

/** Moves match days to new dates without ever putting two on one date (see the header). */
function moveDays(db: AppDb, moves: { id: string; date: string; originalDate: string | null | undefined }[], actorId: string, at: string) {
  if (moves.length === 0) return []
  const out = []
  const ids = moves.map((m) => m.id)
  for (let i = 0; i < ids.length; i += MAX_PARAMS - 2)
    out.push(
      db
        .update(matchDays)
        .set({ date: sql`'~' || ${matchDays.date}` })
        .where(inArray(matchDays.id, ids.slice(i, i + MAX_PARAMS - 2))),
    )
  // Each row binds 5 values (id + date, id + original date, id in the where clause), plus updatedAt/updatedBy.
  const per = Math.floor((MAX_PARAMS - 2) / 5)
  for (let i = 0; i < moves.length; i += per) {
    const chunk = moves.slice(i, i + per)
    const dateCase = sql.join(
      chunk.map((m) => sql`when ${m.id} then ${m.date}`),
      sql` `,
    )
    // undefined = keep (or set, the first time a night moves, to where it was); null = clear.
    const originalCase = sql.join(
      chunk.map((m) =>
        m.originalDate === undefined
          ? sql`when ${m.id} then coalesce(${matchDays.originalDate}, substr(${matchDays.date}, 2))`
          : sql`when ${m.id} then ${m.originalDate}`,
      ),
      sql` `,
    )
    out.push(
      db
        .update(matchDays)
        .set({
          date: sql`case ${matchDays.id} ${dateCase} end`,
          originalDate: sql`case ${matchDays.id} ${originalCase} end`,
          updatedAt: at,
          updatedBy: actorId,
        })
        .where(
          inArray(
            matchDays.id,
            chunk.map((m) => m.id),
          ),
        ),
    )
  }
  return out
}

const hasPublishedResults = (d: LoadedSeason, dayId: string) => {
  const day = d.matchDays.find((m) => m.id === dayId)
  const ids = new Set(d.matches.filter((m) => m.matchDayId === dayId).map((m) => m.id))
  return !!day?.resultsPublishedAt || d.results.some((r) => r.kind === 'published' && ids.has(r.matchId))
}

/**
 * Postpones, cancels or restores a whole night. Admins. Audited as match_day.postpone / match_day.cancel /
 * match_day.restore, or season.push_back; purges the season's public pages.
 */
export async function setNightStatus(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  dayId: string,
  input: NightInput,
  now = new Date(),
): Promise<Changed<SeasonView>> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  const action = input.action
  if (action !== 'postpone' && action !== 'cancel' && action !== 'restore') throw invalid('action must be postpone, cancel or restore.')
  const reason = text(input.note, 'Reason')
  const push = input.pushBack === undefined || input.pushBack === null ? false : bool(input.pushBack, 'pushBack')
  if (push && action === 'restore') throw invalid('pushBack goes with postpone or cancel.')

  const d = await loadSeason(db, seasonId)
  if (d.season.status === 'archived') throw archived()
  if (d.season.status !== 'published') throw notPublished()
  if (base !== d.season.updatedAt) throw conflict()
  const day = d.matchDays.find((m) => m.id === dayId)
  if (!day) throw notFound('match day')
  const at = now.toISOString()
  const touchSeason = db.update(seasons).set({ updatedAt: at, updatedBy: actor.id }).where(eq(seasons.id, seasonId))
  const label = { season: d.season.name, date: day.date, matchDay: day.number }

  let statements
  if (action === 'restore') statements = await restoreStatements(db, actor, d, day, at, label)
  else {
    const status = action === 'postpone' ? ('postponed' as const) : ('cancelled' as const)
    if (day.kind === 'skip') throw invalid('That’s a week off: there are no games to postpone.')
    if (hasPublishedResults(d, dayId))
      throw new HttpError(
        409,
        'has_results',
        'This night already has published results. Mark its games one at a time instead, or undo the results first.',
      )
    if (push) {
      const c = toCompetition(d)
      const skipId = crypto.randomUUID()
      const note = nightNote(status, reason)
      let plan
      try {
        plan = pushBack(c.weeks, dayId, { skipId, note, status, skipDates: c.settings.skipDates })
      } catch (e) {
        throw new HttpError(409, 'cannot_move', e instanceof Error ? e.message : 'Those nights can’t move.')
      }
      const newSkips = plan.weeks.filter((w) => w.kind === 'skip' && !d.matchDays.some((m) => m.id === w.id))
      const skipDates = [...c.settings.skipDates.filter((s) => s.date !== plan.skipDate), { date: plan.skipDate, reason: note }].toSorted(
        (a, b) => a.date.localeCompare(b.date),
      )
      const before: PushAudit = {
        dates: Object.fromEntries(plan.moves.map((m) => [m.weekId, m.from])),
        originalDates: Object.fromEntries(
          plan.moves.map((m) => [m.weekId, d.matchDays.find((x) => x.id === m.weekId)?.originalDate ?? null]),
        ),
        skipDates: c.settings.skipDates,
        skipDayIds: [],
      }
      statements = [
        ...moveDays(
          db,
          plan.moves.map((m) => ({ id: m.weekId, date: m.to, originalDate: undefined })),
          actor.id,
          at,
        ),
        db.insert(matchDays).values(
          newSkips.map((w) => ({
            id: w.id,
            seasonId,
            date: w.date,
            kind: 'skip' as const,
            number: 0,
            note: w.note ?? null,
            courtOverrides: {},
            status: w.id === skipId ? status : ('scheduled' as const),
            updatedAt: at,
            updatedBy: actor.id,
          })),
        ),
        db
          .update(seasons)
          .set({ settings: { ...d.season.settings, skipDates }, updatedAt: at, updatedBy: actor.id })
          .where(eq(seasons.id, seasonId)),
        audit(
          db,
          actor,
          'season.push_back',
          { type: 'match_day', id: skipId },
          before,
          {
            ...label,
            night: dayId,
            status,
            note,
            dates: Object.fromEntries(plan.moves.map((m) => [m.weekId, m.to])),
            skipDayIds: newSkips.map((w) => w.id),
            skipDates,
          },
          at,
        ),
      ]
    } else {
      if (day.status === status) return { result: await getSeason(db, seasonId), purge: {} }
      const dayMatches = d.matches.filter((m) => m.matchDayId === dayId)
      const changing = dayMatches.filter((m) => m.status !== status)
      const before: NightAudit = {
        status: day.status,
        note: day.note,
        matchStatuses: Object.fromEntries(changing.map((m) => [m.id, m.status])),
      }
      const ids = changing.map((m) => m.id)
      statements = [
        db
          .update(matchDays)
          .set({ status, note: reason || null, updatedAt: at, updatedBy: actor.id })
          .where(eq(matchDays.id, dayId)),
        ...(ids.length ? [db.update(matches).set({ status, updatedAt: at, updatedBy: actor.id }).where(inArray(matches.id, ids))] : []),
        ...(status === 'cancelled' && ids.length
          ? [db.delete(matchResults).where(and(eq(matchResults.kind, 'draft'), inArray(matchResults.matchId, ids)))]
          : []),
        touchSeason,
        audit(
          db,
          actor,
          action === 'postpone' ? 'match_day.postpone' : 'match_day.cancel',
          { type: 'match_day', id: dayId },
          before,
          { ...label, status, note: reason || null, games: ids.length },
          at,
        ),
      ]
    }
  }
  await runBatch(db, statements)
  return { result: await getSeason(db, seasonId), purge: seasonPurge(d) }
}

async function restoreStatements(db: AppDb, actor: Editor, d: LoadedSeason, day: MatchDay, at: string, label: Record<string, unknown>) {
  const touchSeason = db.update(seasons).set({ updatedAt: at, updatedBy: actor.id }).where(eq(seasons.id, d.season.id))
  if (day.status === 'scheduled') throw new HttpError(409, 'bad_transition', 'That night isn’t postponed or cancelled.')

  if (day.kind === 'skip') {
    // A week off made by "push the season back": move the nights back to where they were.
    const entry = await latestAudit(db, day.id, ['season.push_back'])
    if (!entry)
      throw cannotUndo('This week off wasn’t made by pushing the season back, so there’s nothing to undo. Edit the season’s dates instead.')
    const before = entry.before as PushAudit
    const after = entry.after as { dates: Record<string, string>; skipDayIds: string[] }
    const moved = Object.keys(before.dates)
    for (const id of moved) {
      const now = d.matchDays.find((m) => m.id === id)
      if (!now || now.date !== after.dates[id])
        throw cannotUndo('Some of the nights have moved again since the season was pushed back, so it can’t be undone automatically.')
      if (hasPublishedResults(d, id))
        throw cannotUndo(`Match day ${now.number} has published results since, so the nights can’t move back.`)
    }
    // Weeks off the push-back added for skip dates it stepped over go too, if they're still empty weeks off.
    const extra = (after.skipDayIds ?? []).filter((id) => id !== day.id && d.matchDays.some((m) => m.id === id && m.kind === 'skip'))
    return [
      db.delete(matchDays).where(inArray(matchDays.id, [day.id, ...extra])),
      ...moveDays(
        db,
        moved.map((id) => ({ id, date: before.dates[id]!, originalDate: before.originalDates[id] ?? null })),
        actor.id,
        at,
      ),
      db
        .update(seasons)
        .set({ settings: { ...d.season.settings, skipDates: before.skipDates }, updatedAt: at, updatedBy: actor.id })
        .where(eq(seasons.id, d.season.id)),
      audit(
        db,
        actor,
        'match_day.restore',
        { type: 'match_day', id: day.id },
        { ...label, status: day.status, pushedBack: true, dates: after.dates },
        { ...label, dates: before.dates },
        at,
      ),
    ]
  }

  // A postponed or cancelled night: back to scheduled, and each game back to what it was.
  const entry = await latestAudit(db, day.id, ['match_day.postpone', 'match_day.cancel'])
  const before = (entry?.before ?? null) as NightAudit | null
  const published = new Set(d.results.filter((r) => r.kind === 'published').map((r) => r.matchId))
  const groups = new Map<Match['status'], string[]>()
  for (const m of d.matches.filter((x) => x.matchDayId === day.id && x.status === day.status)) {
    const to = before?.matchStatuses[m.id] ?? (published.has(m.id) ? 'played' : 'scheduled')
    groups.set(to, [...(groups.get(to) ?? []), m.id])
  }
  return [
    db
      .update(matchDays)
      .set({ status: 'scheduled', note: before ? before.note : null, updatedAt: at, updatedBy: actor.id })
      .where(eq(matchDays.id, day.id)),
    ...[...groups].map(([status, ids]) =>
      db.update(matches).set({ status, updatedAt: at, updatedBy: actor.id }).where(inArray(matches.id, ids)),
    ),
    touchSeason,
    audit(
      db,
      actor,
      'match_day.restore',
      { type: 'match_day', id: day.id },
      { ...label, status: day.status, note: day.note },
      { ...label, status: 'scheduled', note: before?.note ?? null },
      at,
    ),
  ]
}
