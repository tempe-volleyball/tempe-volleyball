import { and, eq, inArray } from 'drizzle-orm'
import { refKey, slotKey, type Ref, type Settings, type Week } from '../../lib/fixtures'
import type { AppDb } from '../db'
import {
  matchDays,
  matches,
  type Court,
  type CourtOverrides,
  type Match,
  type MatchDay,
  type NewMatch,
  type NewMatchDay,
} from '../db/schema'
import { invalid } from './input'

// The write direction: the fixtures library's Settings + Week[] -> match_days and matches rows, with court names
// mapped back to court ids. The read direction is adapter.ts (toCompetition); ids are kept both ways, so a draw
// survives a round trip and results stay attached to their matches.

/** D1 allows 100 bound parameters per statement. */
export const MAX_PARAMS = 100

/**
 * Splits rows for multi-row inserts so no statement binds more than MAX_PARAMS values. Drizzle binds the values a
 * row sets plus JS-side defaults (`.default('x')`, `$defaultFn`); missing columns with no default or an SQL default
 * become literals. So set every column that has a JS default, and a row costs its defined fields.
 */
export function chunkByParams<T extends Record<string, unknown>>(rows: T[], max = MAX_PARAMS): T[][] {
  const out: T[][] = []
  let chunk: T[] = []
  let used = 0
  for (const row of rows) {
    const cost = Object.values(row).filter((v) => v !== undefined).length
    if (chunk.length > 0 && used + cost > max) {
      out.push(chunk)
      chunk = []
      used = 0
    }
    chunk.push(row)
    used += cost
  }
  if (chunk.length > 0) out.push(chunk)
  return out
}

/** Drops undefined and null fields, so they don't use up bound parameters (the columns default to null). */
export const compact = <T extends Record<string, unknown>>(row: T): T =>
  Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null)) as T

const norm = (s: string) => s.trim().toLowerCase()

/**
 * Court name -> id. The lib works in names; the database in ids. Names are unique within a venue but not across
 * venues ("Court 1"), so courts the season already uses win, then the league's venue, then any other court.
 */
export function courtResolver(all: Pick<Court, 'id' | 'name' | 'venueId'>[], venueId: string | null, usedIds: Iterable<string>) {
  const used = new Set(usedIds)
  const rank = (c: Pick<Court, 'id' | 'venueId'>) => (used.has(c.id) ? 0 : c.venueId === venueId ? 1 : 2)
  const byName = new Map<string, string>()
  for (const c of all.toSorted((a, b) => rank(a) - rank(b))) if (!byName.has(norm(c.name))) byName.set(norm(c.name), c.id)
  const names = new Map(all.map((c) => [c.id, c.name]))
  return {
    /** '' means no court. An unknown name is a 400. */
    id(name: string, where: string): string {
      if (!name.trim()) return ''
      const found = byName.get(norm(name))
      if (!found) throw invalid(`${where}: there's no court called “${name}”.`)
      return found
    },
    name: (courtId: string | null | undefined) => (courtId ? (names.get(courtId) ?? '') : ''),
  }
}

export type CourtResolver = ReturnType<typeof courtResolver>

/** Court ids used by a season's settings and draw, so they keep priority when names are looked up. */
export const usedCourtIds = (defaultCourtIds: string[], days: Pick<MatchDay, 'courtOverrides'>[], ms: Pick<Match, 'courtId'>[]) => [
  ...defaultCourtIds,
  ...days.flatMap((d) => Object.values(d.courtOverrides ?? {})),
  ...ms.map((m) => m.courtId).filter((x): x is string => !!x),
]

/** A week's court overrides as court ids, dropping ones that match the slot's default court. */
export function overrideIds(w: Week, defaultCourtIds: string[], courts: CourtResolver): CourtOverrides {
  const out: CourtOverrides = {}
  for (const [key, name] of Object.entries(w.courtOverrides ?? {})) {
    const courtId = courts.id(name, `Match day on ${w.date}`)
    const position = Number(key.split(':')[1])
    if (courtId && courtId !== (defaultCourtIds[position] ?? '')) out[key] = courtId
  }
  return out
}

/** The court a slot resolves to: the day's override, else the season default for the position (null for none). */
export const slotCourtId = (overrides: CourtOverrides, defaultCourtIds: string[], session: number, position: number): string | null =>
  overrides[slotKey(session, position)] || defaultCourtIds[position] || null

const side = (r: Ref | null): { teamId?: string; label?: string } => (!r ? {} : 'team' in r ? { teamId: r.team } : { label: r.label })

/** Every row of a draw, ready to insert. Results aren't part of it. */
export function drawRows(
  seasonId: string,
  settings: Pick<Settings, 'sessions'>,
  defaultCourtIds: string[],
  weeks: Week[],
  courts: CourtResolver,
  actorId: string,
  at: string,
): { days: NewMatchDay[]; matches: NewMatch[] } {
  const days: NewMatchDay[] = []
  const rows: NewMatch[] = []
  for (const w of weeks) {
    const overrides = overrideIds(w, defaultCourtIds, courts)
    days.push(
      compact({
        id: w.id,
        seasonId,
        date: w.date,
        kind: w.kind,
        number: w.kind === 'skip' ? 0 : w.matchDay,
        note: w.note || undefined,
        courtOverrides: overrides,
        updatedAt: at,
        updatedBy: actorId,
      }),
    )
    for (const g of w.games) {
      const home = side(g.home)
      const away = side(g.away)
      const duty = side(g.duty)
      rows.push(
        compact({
          id: g.id,
          seasonId,
          matchDayId: w.id,
          session: g.session,
          position: g.court,
          startTime: settings.sessions[g.session],
          courtId: slotCourtId(overrides, defaultCourtIds, g.session, g.court),
          homeTeamId: home.teamId,
          homeLabel: home.label,
          awayTeamId: away.teamId,
          awayLabel: away.label,
          dutyTeamId: duty.teamId,
          dutyLabel: duty.label,
          stageTitle: g.title,
          // Set even though it's the default: Drizzle binds JS-side defaults, and chunkByParams counts what's set.
          status: 'scheduled' as const,
          updatedAt: at,
          updatedBy: actorId,
        }),
      )
    }
  }
  return { days, matches: rows }
}

/** Replaces a season's whole draw. Deleting the match days cascades to their matches (and any results). */
export function replaceDrawStatements(db: AppDb, seasonId: string, rows: ReturnType<typeof drawRows>) {
  return [
    db.delete(matchDays).where(eq(matchDays.seasonId, seasonId)),
    ...chunkByParams(rows.days).map((chunk) => db.insert(matchDays).values(chunk)),
    ...chunkByParams(rows.matches).map((chunk) => db.insert(matches).values(chunk)),
  ]
}

/**
 * Everything about a week except its court overrides and results: what's locked once a season is published.
 * Courts can still move, so they're left out.
 */
export function weekShape(w: Week): string {
  const games = w.games
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((g) => [g.id, g.session, g.court, refKey(g.home), refKey(g.away), refKey(g.duty), g.title ?? ''])
  return JSON.stringify([w.id, w.kind, w.date, w.kind === 'skip' ? 0 : w.matchDay, w.note ?? '', games])
}

/** True when the two draws differ in anything but courts (and results). */
export const drawShapeChanged = (stored: Week[], next: Week[]) =>
  stored.length !== next.length ||
  stored.map(weekShape).join('\n') !==
    next
      .toSorted((a, b) => a.date.localeCompare(b.date))
      .map(weekShape)
      .join('\n')

/**
 * For a season whose draw stays (published, or a draft whose settings changed): the updates that bring each
 * match's denormalised court_id and start_time in line with the settings and each day's overrides, plus the
 * days whose overrides changed. Matches are grouped by their new values, so it's a handful of statements, not one per
 * match.
 */
export function resyncStatements(
  db: AppDb,
  input: {
    sessions: string[]
    defaultCourtIds: string[]
    days: Pick<MatchDay, 'id' | 'courtOverrides'>[]
    matches: Pick<Match, 'id' | 'matchDayId' | 'session' | 'position' | 'courtId' | 'startTime'>[]
    /** New overrides by match day id; days left out keep theirs. */
    overrides?: Map<string, CourtOverrides>
    actorId: string
    at: string
  },
) {
  const statements = []
  const overridesOf = new Map(input.days.map((d) => [d.id, d.courtOverrides ?? {}]))
  for (const [dayId, next] of input.overrides ?? []) {
    const current = overridesOf.get(dayId)
    if (!current) continue
    if (JSON.stringify(sortKeys(current)) !== JSON.stringify(sortKeys(next)))
      statements.push(
        db.update(matchDays).set({ courtOverrides: next, updatedAt: input.at, updatedBy: input.actorId }).where(eq(matchDays.id, dayId)),
      )
    overridesOf.set(dayId, next)
  }
  const groups = new Map<string, string[]>()
  for (const m of input.matches) {
    const courtId = slotCourtId(overridesOf.get(m.matchDayId) ?? {}, input.defaultCourtIds, m.session, m.position)
    // An imported match may have its own time (a one-off late game); keep it unless its session's time changed.
    const startTime = input.sessions[m.session] ?? m.startTime ?? null
    if (courtId === (m.courtId ?? null) && startTime === (m.startTime ?? null)) continue
    const key = JSON.stringify([courtId, startTime])
    const list = groups.get(key)
    if (list) list.push(m.id)
    else groups.set(key, [m.id])
  }
  for (const [key, ids] of groups) {
    const [courtId, startTime] = JSON.parse(key) as [string | null, string | null]
    for (let i = 0; i < ids.length; i += MAX_PARAMS - 4)
      statements.push(
        db
          .update(matches)
          .set({ courtId, startTime, updatedAt: input.at, updatedBy: input.actorId })
          .where(inArray(matches.id, ids.slice(i, i + MAX_PARAMS - 4))),
      )
  }
  return statements
}

const sortKeys = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).toSorted(([a], [b]) => a.localeCompare(b)))

/** The day ids of a season, for scoping updates. */
export const dayMatches = (db: AppDb, seasonId: string, dayId: string) =>
  db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.seasonId, seasonId), eq(matches.matchDayId, dayId)))
