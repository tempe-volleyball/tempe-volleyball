import {
  effectiveResult,
  MAX_SETS,
  setScoresProblem,
  type Game,
  type Points,
  type Ref,
  type Result,
  type SetScore,
  type Week,
} from '../../lib/fixtures'
import { matchDayKinds, tieBreakRules, type MatchDayKind, type TieBreakRule, type WithdrawnPolicy } from '../db/schema'
import { HttpError } from '../http'

// Parsing the admin's JSON into the fixtures library's shapes. Nothing here trusts the browser: every field is
// type-checked and bounded before the season code looks at it. Pure, so it's tested without a database.

export const invalid = (message: string) => new HttpError(400, 'invalid_input', message)

/** Limits that keep one draw save inside a request's 50 D1 queries (see draw.ts) and the payload small. */
export const LIMITS = {
  weeks: 30,
  gamesPerWeek: 40,
  games: 160,
  sessions: 8,
  courts: 12,
  meetings: 4,
  teams: 40,
  skipDates: 20,
  text: 200,
  label: 40,
  setPoints: 99,
  totalPoints: 999,
} as const

/** Row ids: the lib's crypto.randomUUID() ids, the importer's UUID-shaped ids, or anything similarly tame. */
const ID = /^[A-Za-z0-9_-]{1,64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

export function id(v: unknown, label: string): string {
  if (!isId(v)) throw invalid(`${label} must be an id (letters, digits, - or _).`)
  return v
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

export function int(v: unknown, label: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw invalid(`${label} must be a whole number from ${min} to ${max}.`)
  return v
}

export function bool(v: unknown, label: string): boolean {
  if (typeof v !== 'boolean') throw invalid(`${label} must be true or false.`)
  return v
}

export function text(v: unknown, label: string, max: number = LIMITS.text, { required = false } = {}): string {
  if (v === undefined || v === null) v = ''
  if (typeof v !== 'string') throw invalid(`${label} must be text.`)
  const s = v.trim().replace(/\s+/g, ' ')
  if (s.length > max) throw invalid(`${label} is too long (at most ${max} characters).`)
  if (required && !s) throw invalid(`${label} is required.`)
  return s
}

const record = (v: unknown, label: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw invalid(`${label} must be an object.`)
  return v as Record<string, unknown>
}

const array = (v: unknown, label: string, max: number): unknown[] => {
  if (!Array.isArray(v)) throw invalid(`${label} must be a list.`)
  if (v.length > max) throw invalid(`${label} has too many entries (at most ${max}).`)
  return v
}

/** The concurrency token every season write needs: the updatedAt the client last loaded. */
export function baseUpdatedAt(v: unknown): string {
  if (typeof v !== 'string' || !v) throw invalid('baseUpdatedAt is required: send the updatedAt you loaded.')
  return v
}

// ── Settings ──────────────────────────────────────────────────────────────────

/** The settings fields a client may send (the lib's Settings minus teams, plus setsPerMatch). All optional. */
export type SettingsPatch = {
  name?: string
  startDate?: string
  skipDates?: { date: string; reason: string }[]
  /** Default court name per slot position. */
  courts?: string[]
  sessions?: string[]
  sessionMinutes?: number
  meetings?: number
  includeFinals?: boolean
  seed?: number
  points?: Points
  duty?: boolean
  setsPerMatch?: number
  /** Only checked: teams change through PUT /teams. */
  teams?: string[]
  /** Ladder order after points (tieBreakRules); `name` is added last if missing. Allowed on published seasons. */
  tieBreaks?: TieBreakRule[]
  /** How withdrawn teams show. Allowed on published seasons. */
  withdrawn?: WithdrawnPolicy
}

export function parseSettingsPatch(input: unknown): SettingsPatch {
  const o = record(input ?? {}, 'settings')
  const out: SettingsPatch = {}
  if (o.name !== undefined) out.name = text(o.name, 'Name', 80, { required: true })
  if (o.startDate !== undefined) out.startDate = date(o.startDate, 'Start date')
  if (o.skipDates !== undefined) {
    const seen = new Set<string>()
    out.skipDates = array(o.skipDates, 'Skip dates', LIMITS.skipDates).map((d, i) => {
      const r = record(d, `Skip date ${i + 1}`)
      const day = date(r.date, `Skip date ${i + 1}`)
      if (seen.has(day)) throw invalid(`${day} is skipped twice.`)
      seen.add(day)
      return { date: day, reason: text(r.reason, 'Skip reason') || 'No games' }
    })
    out.skipDates.sort((a, b) => a.date.localeCompare(b.date))
  }
  if (o.courts !== undefined) out.courts = array(o.courts, 'Courts', LIMITS.courts).map((c, i) => text(c, `Court ${i + 1}`, LIMITS.label))
  if (o.sessions !== undefined)
    out.sessions = array(o.sessions, 'Session times', LIMITS.sessions).map((t, i) => {
      if (typeof t !== 'string' || !TIME.test(t)) throw invalid(`Session ${i + 1} must be a time, HH:MM.`)
      return t
    })
  if (o.sessionMinutes !== undefined) out.sessionMinutes = int(o.sessionMinutes, 'Session length', 15, 240)
  if (o.meetings !== undefined) out.meetings = int(o.meetings, 'Meetings', 1, LIMITS.meetings)
  if (o.includeFinals !== undefined) out.includeFinals = bool(o.includeFinals, 'Include finals')
  if (o.seed !== undefined) out.seed = int(o.seed, 'Seed', 0, 2 ** 32 - 1)
  if (o.points !== undefined) {
    const p = record(o.points, 'Points')
    out.points = {
      win: int(p.win, 'Points for a win', 0, 10),
      draw: int(p.draw, 'Points for a draw', 0, 10),
      loss: int(p.loss, 'Points for a loss', 0, 10),
    }
  }
  if (o.duty !== undefined) out.duty = bool(o.duty, 'Duty')
  if (o.setsPerMatch !== undefined) out.setsPerMatch = int(o.setsPerMatch, 'Sets per match', 1, MAX_SETS)
  if (o.teams !== undefined)
    out.teams = array(o.teams, 'Teams', LIMITS.teams).map((t, i) =>
      id(t && typeof t === 'object' ? (t as { id?: unknown }).id : t, `Team ${i + 1}`),
    )
  if (o.tieBreaks !== undefined) {
    const rules = array(o.tieBreaks, 'Tie-break order', tieBreakRules.length).map((r, i) => {
      if (typeof r !== 'string' || !(tieBreakRules as readonly string[]).includes(r))
        throw invalid(`Tie-break ${i + 1} must be one of ${tieBreakRules.join(', ')}.`)
      return r as TieBreakRule
    })
    if (new Set(rules).size !== rules.length) throw invalid('A tie-break is listed twice.')
    out.tieBreaks = [...rules.filter((r) => r !== 'name'), 'name']
  }
  if (o.withdrawn !== undefined) {
    const w = record(o.withdrawn, 'Withdrawn teams')
    const pick = <T extends string>(v: unknown, allowed: readonly T[], label: string): T => {
      if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw invalid(`${label} must be ${allowed.join(' or ')}.`)
      return v as T
    }
    out.withdrawn = {
      ladder: pick(w.ladder, ['mark', 'hide'] as const, 'Withdrawn teams on the ladder'),
      results: pick(w.results, ['keep', 'void'] as const, 'Withdrawn teams’ results'),
      fixtures: w.fixtures === undefined ? 'cancelled' : pick(w.fixtures, ['bye', 'cancelled'] as const, 'Withdrawn teams’ fixtures'),
    }
  }
  return out
}

// ── The draw ──────────────────────────────────────────────────────────────────

function ref(v: unknown, label: string): Ref {
  const r = record(v, label)
  if (r.team !== undefined) return { team: id(r.team, `${label} team`) }
  if (r.label !== undefined) return { label: text(r.label, `${label} label`, LIMITS.label, { required: true }) }
  throw invalid(`${label} needs a team or a label.`)
}

function game(v: unknown, where: string): Game {
  const o = record(v, where)
  const g: Game = {
    id: id(o.id, `${where} id`),
    session: int(o.session, `${where} session`, 0, LIMITS.sessions - 1),
    court: int(o.court, `${where} court position`, 0, LIMITS.courts - 1),
    home: ref(o.home, `${where} home`),
    away: ref(o.away, `${where} away`),
    duty: o.duty === null || o.duty === undefined ? null : ref(o.duty, `${where} duty`),
  }
  const title = text(o.title, `${where} title`, 60)
  if (title) g.title = title
  return g
}

const SLOT = /^(\d{1,2}):(\d{1,2})$/

/**
 * The client's weeks, shape-checked. Results in the payload are ignored (they're saved per match day), and so is
 * resultsPublishedAt. Ids must be unique across weeks and games, and dates across weeks.
 */
export function parseWeeks(input: unknown): Week[] {
  const list = array(input, 'weeks', LIMITS.weeks)
  const ids = new Set<string>()
  const dates = new Set<string>()
  let games = 0
  const unique = (x: string, what: string) => {
    if (ids.has(x)) throw invalid(`The ${what} id ${x} is used twice.`)
    ids.add(x)
  }
  return list.map((v, i) => {
    const o = record(v, `Week ${i + 1}`)
    const where = `Week ${i + 1}`
    if (typeof o.kind !== 'string' || !(matchDayKinds as readonly string[]).includes(o.kind)) throw invalid(`${where} has an unknown kind.`)
    const w: Week = {
      id: id(o.id, `${where} id`),
      kind: o.kind as MatchDayKind,
      date: date(o.date, `${where} date`),
      matchDay: int(o.matchDay, `${where} match day`, 0, 99),
      games: array(o.games ?? [], `${where} games`, LIMITS.gamesPerWeek).map((g, j) => game(g, `${where} game ${j + 1}`)),
    }
    unique(w.id, 'week')
    if (dates.has(w.date)) throw invalid(`Two weeks are on ${w.date}.`)
    dates.add(w.date)
    if (w.kind === 'skip' && w.games.length) throw invalid(`${where} is a week off but has games.`)
    for (const g of w.games) unique(g.id, 'game')
    games += w.games.length
    if (games > LIMITS.games) throw invalid(`A season can have at most ${LIMITS.games} games.`)
    const note = text(o.note, `${where} note`)
    if (note) w.note = note
    if (o.courtOverrides !== undefined && o.courtOverrides !== null) {
      const overrides: Record<string, string> = {}
      for (const [key, name] of Object.entries(record(o.courtOverrides, `${where} court overrides`))) {
        if (!SLOT.test(key)) throw invalid(`${where}: ${key} isn't a slot ("session:position").`)
        const value = text(name, `${where} court`, LIMITS.label)
        if (value) overrides[key] = value
      }
      w.courtOverrides = overrides
    }
    return w
  })
}

// ── Results ───────────────────────────────────────────────────────────────────

const optInt = (v: unknown, label: string, max: number): number | null => (v === null || v === undefined ? null : int(v, label, 0, max))

/** The draft row's values for a result, or null to clear it. */
export type ResultValues = {
  homeSets: number | null
  awaySets: number | null
  setScores: SetScore[] | null
  homePoints: number | null
  awayPoints: number | null
}

/**
 * One result as typed in. null (or all blank) clears it. With set scores, sets won and point totals are derived from
 * them (effectiveResult), so the stored totals always agree with the sets. Checked against the season's sets per
 * match (setScoresProblem with maxSets = sets_per_match).
 */
export function parseResult(v: unknown, setsPerMatch: number, label = 'Result'): ResultValues | null {
  if (v === null || v === undefined) return null
  const o = record(v, label)
  let sets: SetScore[] | undefined
  if (o.sets !== undefined && o.sets !== null) {
    sets = array(o.sets, `${label} sets`, MAX_SETS).map((s, i) => {
      if (!Array.isArray(s) || s.length !== 2) throw invalid(`${label}: set ${i + 1} must be [home, away].`)
      return [int(s[0], `${label} set ${i + 1}`, 0, LIMITS.setPoints), int(s[1], `${label} set ${i + 1}`, 0, LIMITS.setPoints)] as SetScore
    })
    const problem = setScoresProblem(sets, setsPerMatch)
    if (problem) throw invalid(`${label}: ${problem}`)
    if (sets.length === 0) sets = undefined
  }
  const r: Result = {
    home: optInt(o.home, `${label} home sets`, setsPerMatch),
    away: optInt(o.away, `${label} away sets`, setsPerMatch),
    homePoints: optInt(o.homePoints, `${label} home points`, LIMITS.totalPoints),
    awayPoints: optInt(o.awayPoints, `${label} away points`, LIMITS.totalPoints),
    ...(sets ? { sets } : {}),
  }
  const e = effectiveResult(r)!
  const values: ResultValues = {
    homeSets: e.home,
    awaySets: e.away,
    setScores: sets ?? null,
    homePoints: e.homePoints ?? null,
    awayPoints: e.awayPoints ?? null,
  }
  if (values.homeSets !== null && values.awaySets !== null && values.homeSets + values.awaySets > setsPerMatch)
    throw invalid(`${label}: a match has at most ${setsPerMatch} sets.`)
  const blank = [values.homeSets, values.awaySets, values.homePoints, values.awayPoints].every((x) => x === null) && !sets
  return blank ? null : values
}
