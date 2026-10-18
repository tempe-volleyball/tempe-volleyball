import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import {
  forfeitRule,
  forfeitRuleProblem,
  isStale,
  levelSetsRule,
  settingsErrors,
  tieBreakOrder,
  validate,
  withdrawnPolicy,
  type Competition,
  type Issue,
  type Settings,
  type Week,
} from '../../lib/fixtures'
import { tags, type PurgeTargets } from '../cache'
import { runBatch, type AppDb } from '../db'
import {
  courts,
  ladderAdjustments,
  leagues,
  matchDays,
  matches,
  matchResults,
  seasons,
  seasonTeams,
  teams,
  venues,
  type Court,
  type CourtOverrides,
  type LadderAdjustment,
  type League,
  type Match,
  type MatchDay,
  type MatchResult,
  type NewSeason,
  type Season,
  type SeasonSettings,
  type Team,
  type Venue,
} from '../db/schema'
import { HttpError } from '../http'
import { audit, isUniqueFailure, notFound, type Changed, type Editor } from '../content/common'
import { seasonTeamRow, toCompetition, type SeasonData } from './adapter'
import {
  chunkByParams,
  courtResolver,
  drawRows,
  drawShapeChanged,
  overrideIds,
  replaceDrawStatements,
  resyncStatements,
  usedCourtIds,
  type CourtResolver,
} from './draw'
import { baseUpdatedAt, id, int, invalid, isDate, isId, parseSettingsPatch, parseWeeks, text, type SettingsPatch } from './input'

// Seasons in the admin: list, read as a lib Competition, create, change settings, save the draw, team membership,
// publish/unpublish/archive. Results per match day are in results.ts, ladder adjustments in adjustments.ts.
//
// Rules (CLAUDE.md "Fixtures rules"):
//  - The draw is generated in the browser; the server only checks it (shape, then validate()) and saves it.
//  - A draft season's draw is replaced whole. Once published, the draw and the settings that shape it are locked;
//    session times, default courts and per-day court overrides can still change.
//  - Archived seasons are read-only.
//  - Every write checks seasons.updated_at against the client's baseUpdatedAt (409 conflict if someone else saved).
//  - One db.batch() per write, under D1's 50 queries per request and 100 bound parameters per statement.

// ── Errors ────────────────────────────────────────────────────────────────────

export const conflict = () =>
  new HttpError(409, 'conflict', 'Someone else changed this season while you were working on it. Reload to see their changes.')
export const archived = () => new HttpError(409, 'season_archived', 'This season is archived, so it is read-only.')
export const drawLocked = (what = 'The draw') =>
  new HttpError(409, 'draw_locked', `${what} is locked because the season is published. Only session times and courts can change.`)
const invalidDraw = (issues: Issue[]) =>
  new HttpError(422, 'invalid_draw', issues.find((i) => i.level === 'error')?.message ?? 'The draw has problems.', { issues })

// ── Loading ───────────────────────────────────────────────────────────────────

export type LoadedSeason = SeasonData & { venue: Venue | null }

/** One season with everything the admin needs, in one round trip (8 queries; 6 without the draw and results). */
export async function loadSeason(db: AppDb, seasonId: string, opts: { draw?: boolean; results?: boolean } = {}): Promise<LoadedSeason> {
  const { draw = true, results = true } = opts
  const leagueOf = db.select({ id: seasons.leagueId }).from(seasons).where(eq(seasons.id, seasonId))
  const matchIds = db.select({ id: matches.id }).from(matches).where(eq(matches.seasonId, seasonId))
  const queries = [
    db.select().from(seasons).where(eq(seasons.id, seasonId)),
    db.select().from(leagues).where(inArray(leagues.id, leagueOf)),
    db
      .select({ team: teams, withdrawnAt: seasonTeams.withdrawnAt, withdrawnReason: seasonTeams.withdrawnReason })
      .from(seasonTeams)
      .innerJoin(teams, eq(teams.id, seasonTeams.teamId))
      .where(eq(seasonTeams.seasonId, seasonId))
      .orderBy(asc(seasonTeams.sort), asc(teams.name)),
    db.select().from(courts).orderBy(asc(courts.sort), asc(courts.name)),
    db.select().from(ladderAdjustments).where(eq(ladderAdjustments.seasonId, seasonId)).orderBy(asc(ladderAdjustments.createdAt)),
    db.select().from(venues),
    ...(draw
      ? [
          db.select().from(matchDays).where(eq(matchDays.seasonId, seasonId)).orderBy(asc(matchDays.date)),
          db.select().from(matches).where(eq(matches.seasonId, seasonId)),
        ]
      : []),
    ...(draw && results ? [db.select().from(matchResults).where(inArray(matchResults.matchId, matchIds))] : []),
  ]
  const res = (await runBatch(db, queries)) as unknown as [
    Season[],
    League[],
    { team: Team; withdrawnAt: string | null; withdrawnReason: string | null }[],
    Court[],
    LadderAdjustment[],
    Venue[],
    MatchDay[]?,
    Match[]?,
    MatchResult[]?,
  ]
  const [seasonRows, leagueRows, teamRows, courtRows, adjustments, venueRows, dayRows = [], matchRows = [], resultRows = []] = res
  const season = seasonRows[0]
  const league = leagueRows[0]
  if (!season || !league) throw notFound('season')
  return {
    season,
    league,
    venue: venueRows.find((v) => v.id === league.defaultVenueId) ?? null,
    teams: teamRows.map(seasonTeamRow),
    matchDays: dayRows,
    matches: matchRows,
    results: resultRows,
    adjustments,
    courts: courtRows,
  }
}

/** Court name lookups for a loaded season (its own courts first, then its league's venue). */
export const resolverFor = (d: LoadedSeason): CourtResolver =>
  courtResolver(d.courts, d.league.defaultVenueId, usedCourtIds(d.season.settings.defaultCourtIds ?? [], d.matchDays, d.matches))

// ── The season as the admin sees it ──────────────────────────────────────────

export type SeasonMeta = Pick<
  Season,
  | 'id'
  | 'leagueId'
  | 'name'
  | 'slug'
  | 'year'
  | 'quarter'
  | 'startDate'
  | 'status'
  | 'setsPerMatch'
  | 'dutyEnabled'
  | 'generatedFrom'
  | 'edited'
  | 'publishedAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  /** Came from the old WordPress site (wp_id): its draw didn't follow the generator's rules, so the admin calls them notes. */
  imported: boolean
}

export const seasonMeta = (s: Season): SeasonMeta => ({
  id: s.id,
  leagueId: s.leagueId,
  name: s.name,
  slug: s.slug,
  year: s.year,
  quarter: s.quarter,
  startDate: s.startDate,
  status: s.status,
  setsPerMatch: s.setsPerMatch,
  dutyEnabled: s.dutyEnabled,
  generatedFrom: s.generatedFrom,
  edited: s.edited,
  publishedAt: s.publishedAt,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  imported: s.wpId !== null,
})

export type CourtOption = { id: string; name: string; venueId: string; venueName: string; atLeagueVenue: boolean }

export type SeasonView = {
  season: SeasonMeta
  league: Pick<League, 'id' | 'code' | 'name' | 'slug' | 'weekday' | 'format' | 'defaultVenueId'>
  venue: Pick<Venue, 'id' | 'name' | 'slug'> | null
  /** Courts the settings and overrides can name: the league's venue's courts, plus any other court this season uses. */
  courts: CourtOption[]
  /** The lib's Competition. Draft results are `result`, published ones `publishedResult`. */
  competition: Competition
  /** Per match day (by week id): its updatedAt, the concurrency token for results saves. */
  matchDays: Record<string, { updatedAt: string; resultsPublishedAt: string | null }>
  /** Per match (by game id): what the lib's Game doesn't carry. */
  matches: Record<string, { status: Match['status']; statusNote: string | null; startTime: string | null; courtId: string | null }>
  adjustments: Pick<LadderAdjustment, 'id' | 'teamId' | 'points' | 'reason' | 'createdAt' | 'updatedAt'>[]
}

export function seasonView(d: LoadedSeason): SeasonView {
  const c = toCompetition(d)
  const s = d.season
  const used = new Set(usedCourtIds(s.settings.defaultCourtIds ?? [], d.matchDays, d.matches))
  const venueName = (venueId: string) => (venueId === d.venue?.id ? d.venue.name : '')
  return {
    season: seasonMeta(s),
    league: {
      id: d.league.id,
      code: d.league.code,
      name: d.league.name,
      slug: d.league.slug,
      weekday: d.league.weekday,
      format: d.league.format,
      defaultVenueId: d.league.defaultVenueId,
    },
    venue: d.venue ? { id: d.venue.id, name: d.venue.name, slug: d.venue.slug } : null,
    courts: d.courts
      .filter((ct) => ct.venueId === d.league.defaultVenueId || used.has(ct.id))
      .map((ct) => ({
        id: ct.id,
        name: ct.name,
        venueId: ct.venueId,
        venueName: venueName(ct.venueId),
        atLeagueVenue: ct.venueId === d.league.defaultVenueId,
      })),
    competition: {
      id: s.id,
      settings: c.settings,
      weeks: d.matchDays.length > 0 ? c.weeks : null,
      edited: s.edited,
      ...(s.generatedFrom ? { generatedFrom: s.generatedFrom } : {}),
      status: s.status === 'draft' ? 'draft' : 'published',
      ...(s.publishedAt ? { publishedAt: Date.parse(s.publishedAt) } : {}),
      updatedAt: Date.parse(s.updatedAt),
    },
    matchDays: Object.fromEntries(d.matchDays.map((m) => [m.id, { updatedAt: m.updatedAt, resultsPublishedAt: m.resultsPublishedAt }])),
    matches: Object.fromEntries(
      d.matches.map((m) => [m.id, { status: m.status, statusNote: m.statusNote, startTime: m.startTime, courtId: m.courtId }]),
    ),
    adjustments: d.adjustments.map((a) => ({
      id: a.id,
      teamId: a.teamId,
      points: a.points,
      reason: a.reason,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    })),
  }
}

export const getSeason = async (db: AppDb, seasonId: string) => seasonView(await loadSeason(db, seasonId))

export const seasonPurge = (d: Pick<LoadedSeason, 'season' | 'league'>): PurgeTargets =>
  d.season.status === 'draft' ? {} : { tags: [tags.season(d.season.slug), tags.league(d.league.slug), tags.site] }

/** Archived: read-only. Stale baseUpdatedAt: 409. */
function assertWritable(d: LoadedSeason, base: string) {
  if (d.season.status === 'archived') throw archived()
  if (base !== d.season.updatedAt) throw conflict()
}

// ── Leagues and seasons list ─────────────────────────────────────────────────

export type SeasonListItem = Pick<
  Season,
  'id' | 'leagueId' | 'name' | 'slug' | 'year' | 'quarter' | 'startDate' | 'status' | 'publishedAt' | 'updatedAt'
>

export type LeagueListItem = League & {
  venue: Pick<Venue, 'id' | 'name' | 'slug'> | null
  courts: Pick<Court, 'id' | 'name' | 'sort'>[]
  /** Newest first. */
  seasons: SeasonListItem[]
}

/** Every league with its venue, the venue's courts and its seasons (newest first). One round trip. */
export async function listLeagues(db: AppDb): Promise<LeagueListItem[]> {
  const [leagueRows, venueRows, courtRows, seasonRows] = (await runBatch(db, [
    db.select().from(leagues).where(eq(leagues.kind, 'league')).orderBy(asc(leagues.sort), asc(leagues.code)),
    db.select().from(venues).orderBy(asc(venues.sort)),
    db.select().from(courts).orderBy(asc(courts.sort), asc(courts.name)),
    db
      .select({
        id: seasons.id,
        leagueId: seasons.leagueId,
        name: seasons.name,
        slug: seasons.slug,
        year: seasons.year,
        quarter: seasons.quarter,
        startDate: seasons.startDate,
        status: seasons.status,
        publishedAt: seasons.publishedAt,
        updatedAt: seasons.updatedAt,
      })
      .from(seasons)
      .orderBy(desc(seasons.year), desc(seasons.quarter)),
  ])) as unknown as [League[], Venue[], Court[], SeasonListItem[]]
  return leagueRows.map((l) => {
    const v = venueRows.find((x) => x.id === l.defaultVenueId)
    return {
      ...l,
      venue: v ? { id: v.id, name: v.name, slug: v.slug } : null,
      courts: courtRows.filter((c) => c.venueId === l.defaultVenueId).map((c) => ({ id: c.id, name: c.name, sort: c.sort })),
      seasons: seasonRows.filter((s) => s.leagueId === l.id),
    }
  })
}

// ── Create ────────────────────────────────────────────────────────────────────

export type CreateSeasonInput = {
  leagueId?: unknown
  year?: unknown
  quarter?: unknown
  /** Defaults to the league's first game night in the quarter. */
  startDate?: unknown
  name?: unknown
  /** 'latest' (the default): copy teams and settings from the league's newest season. null: start blank. Or a season id. */
  copyFrom?: unknown
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The first date on `weekday` (0 = Sunday) in a quarter: Q1 starts 1 Jan, Q2 1 Apr … */
export function firstGameNight(year: number, quarter: number, weekday: number): string {
  const d = new Date(Date.UTC(year, (quarter - 1) * 3, 1))
  d.setUTCDate(d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

const randomSeed = () => crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000_000

/** What a blank season starts with, by league format. */
function blankSeason(league: League, venueCourts: Court[]) {
  const superLeague = league.format === 'super'
  return {
    settings: {
      sessions: superLeague ? ['18:00', '19:30'] : ['20:00', '21:00'],
      sessionMinutes: superLeague ? 90 : 60,
      meetings: 1,
      includeFinals: true,
      seed: randomSeed(),
      skipDates: [],
      defaultCourtIds: venueCourts.slice(0, superLeague ? 1 : 2).map((c) => c.id),
    } satisfies SeasonSettings,
    pointsWin: 3,
    pointsDraw: 2,
    pointsLoss: 1,
    setsPerMatch: superLeague ? 5 : 2,
    dutyEnabled: !superLeague,
  }
}

/** A new draft season for a league and quarter, optionally copying the teams and settings of an earlier season. */
export async function createSeason(db: AppDb, actor: Editor, input: CreateSeasonInput, now = new Date()): Promise<SeasonView> {
  const leagueId = id(input.leagueId, 'League')
  const year = int(input.year, 'Year', 2020, 2100)
  const quarter = int(input.quarter, 'Quarter', 1, 4)
  const copyFrom = input.copyFrom === undefined ? 'latest' : input.copyFrom
  if (copyFrom !== null && copyFrom !== 'latest' && !isId(copyFrom)) throw invalid('copyFrom must be "latest", null or a season id.')

  const [leagueRows, courtRows, leagueSeasons, taken] = (await runBatch(db, [
    // Only leagues have seasons; other programme kinds 404 here.
    db
      .select()
      .from(leagues)
      .where(and(eq(leagues.id, leagueId), eq(leagues.kind, 'league'))),
    db.select().from(courts).orderBy(asc(courts.sort), asc(courts.name)),
    db
      .select({ id: seasons.id, year: seasons.year, quarter: seasons.quarter })
      .from(seasons)
      .where(eq(seasons.leagueId, leagueId))
      .orderBy(desc(seasons.year), desc(seasons.quarter)),
    db
      .select({ id: seasons.id, name: seasons.name })
      .from(seasons)
      .where(and(eq(seasons.leagueId, leagueId), eq(seasons.year, year), eq(seasons.quarter, quarter))),
  ])) as unknown as [League[], Court[], { id: string; year: number; quarter: number }[], { id: string; name: string }[]]
  const league = leagueRows[0]
  if (!league) throw invalid('That league doesn’t exist.')
  if (taken[0]) throw new HttpError(409, 'season_exists', `${taken[0].name} already exists.`)

  const sourceId = copyFrom === 'latest' ? leagueSeasons[0]?.id : copyFrom
  const source = sourceId ? await loadSeason(db, sourceId, { draw: false }) : null
  if (source && source.league.id !== league.id) throw invalid('copyFrom must be a season of the same league.')

  const startDate =
    input.startDate === undefined || input.startDate === null ? firstGameNight(year, quarter, league.weekday) : input.startDate
  if (!isDate(startDate)) throw invalid('Start date must be a date, YYYY-MM-DD.')
  const name =
    input.name === undefined || input.name === null
      ? `${league.code} Q${quarter} ${year}`
      : text(input.name, 'Name', 80, { required: true })
  const slug = `${league.code.toLowerCase()}-q${quarter}-${year}`

  const base = source
    ? {
        settings: {
          sessions: source.season.settings.sessions ?? [],
          sessionMinutes: source.season.settings.sessionMinutes ?? 60,
          meetings: source.season.settings.meetings ?? 1,
          includeFinals: source.season.settings.includeFinals ?? true,
          seed: randomSeed(),
          skipDates: [],
          defaultCourtIds: source.season.settings.defaultCourtIds ?? [],
          // The ladder rules carry over with the format.
          ...(source.season.settings.tieBreaks ? { tieBreaks: source.season.settings.tieBreaks } : {}),
          ...(source.season.settings.withdrawn ? { withdrawn: source.season.settings.withdrawn } : {}),
          ...(source.season.settings.levelSets ? { levelSets: source.season.settings.levelSets } : {}),
          ...(source.season.settings.forfeit ? { forfeit: source.season.settings.forfeit } : {}),
        } satisfies SeasonSettings,
        pointsWin: source.season.pointsWin,
        pointsDraw: source.season.pointsDraw,
        pointsLoss: source.season.pointsLoss,
        setsPerMatch: source.season.setsPerMatch,
        dutyEnabled: source.season.dutyEnabled,
      }
    : blankSeason(
        league,
        courtRows.filter((c) => c.venueId === league.defaultVenueId),
      )
  const at = now.toISOString()
  const seasonId = crypto.randomUUID()
  const row: NewSeason = {
    id: seasonId,
    leagueId,
    name,
    slug,
    year,
    quarter,
    startDate,
    status: 'draft',
    ...base,
    createdAt: at,
    updatedAt: at,
    updatedBy: actor.id,
  }
  const members = (source?.teams ?? []).map((t, sort) => ({ seasonId, teamId: t.id, sort }))
  try {
    await runBatch(db, [
      db.insert(seasons).values(row),
      ...chunkByParams(members).map((chunk) => db.insert(seasonTeams).values(chunk)),
      audit(
        db,
        actor,
        'season.create',
        { type: 'season', id: seasonId },
        null,
        { name, slug, copiedFrom: source?.season.name ?? null, teams: members.length },
        at,
      ),
    ])
  } catch (e) {
    if (isUniqueFailure(e)) throw new HttpError(409, 'season_exists', `A season with the slug ${slug} already exists.`)
    throw e
  }
  return getSeason(db, seasonId)
}

// ── Settings ──────────────────────────────────────────────────────────────────

type Merged = {
  settings: Settings
  defaultCourtIds: string[]
  setsPerMatch: number
  columns: Partial<NewSeason>
  /** Field names that changed, for the audit log. */
  changed: string[]
}

/**
 * Applies a settings patch to a season. Court names become court ids. For a published season, anything that would
 * need a new draw is refused (draw_locked); names, session times, session length, points and courts can change.
 */
export function mergeSettings(d: LoadedSeason, current: Settings, patch: SettingsPatch, resolver: CourtResolver): Merged {
  const s = d.season
  if (patch.teams && patch.teams.join() !== current.teams.map((t) => t.id).join())
    throw invalid('Teams change through PUT /api/admin/seasons/:id/teams, not the settings.')
  const currentIds = s.settings.defaultCourtIds ?? []
  const defaultCourtIds = patch.courts
    ? patch.courts.map((name, i) =>
        // An unchanged name keeps its court even if another venue has a court of the same name.
        name === current.courts[i] ? (currentIds[i] ?? '') : resolver.id(name, `Court ${i + 1}`),
      )
    : currentIds
  const settings: Settings = {
    ...current,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.startDate !== undefined ? { startDate: patch.startDate } : {}),
    ...(patch.skipDates !== undefined ? { skipDates: patch.skipDates } : {}),
    ...(patch.sessions !== undefined ? { sessions: patch.sessions } : {}),
    ...(patch.sessionMinutes !== undefined ? { sessionMinutes: patch.sessionMinutes } : {}),
    ...(patch.meetings !== undefined ? { meetings: patch.meetings } : {}),
    ...(patch.includeFinals !== undefined ? { includeFinals: patch.includeFinals } : {}),
    ...(patch.seed !== undefined ? { seed: patch.seed } : {}),
    ...(patch.points !== undefined ? { points: patch.points } : {}),
    ...(patch.duty !== undefined ? { duty: patch.duty } : {}),
    ...(patch.tieBreaks !== undefined ? { tieBreaks: patch.tieBreaks } : {}),
    ...(patch.withdrawn !== undefined ? { withdrawn: patch.withdrawn } : {}),
    ...(patch.levelSets !== undefined ? { levelSets: patch.levelSets } : {}),
    ...(patch.forfeit !== undefined ? { forfeit: patch.forfeit } : {}),
    courts: defaultCourtIds.map((cid, i) => (cid ? resolver.name(cid) || (patch.courts?.[i] ?? '') : '')),
  }
  const setsPerMatch = patch.setsPerMatch ?? s.setsPerMatch
  // A stored forfeit rule must still fit the sets per match (a default one always does: it follows them).
  const forfeitProblem = settings.forfeit ? forfeitRuleProblem(forfeitRule(settings, setsPerMatch), setsPerMatch) : null
  if (forfeitProblem) throw invalid(forfeitProblem)

  const changed: string[] = []
  const diff = (k: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k)
  }
  diff('name', current.name, settings.name)
  diff('startDate', current.startDate, settings.startDate)
  diff('skipDates', current.skipDates, settings.skipDates)
  diff('sessions', current.sessions, settings.sessions)
  diff('sessionMinutes', current.sessionMinutes, settings.sessionMinutes)
  diff('meetings', current.meetings, settings.meetings)
  diff('includeFinals', current.includeFinals, settings.includeFinals)
  diff('seed', current.seed, settings.seed)
  diff('points', current.points, settings.points)
  diff('duty', current.duty !== false, settings.duty !== false)
  diff('courts', currentIds, defaultCourtIds)
  diff('setsPerMatch', s.setsPerMatch, setsPerMatch)
  diff('tieBreaks', tieBreakOrder(current), tieBreakOrder(settings))
  diff('withdrawn', withdrawnPolicy(current), withdrawnPolicy(settings))
  diff('levelSets', levelSetsRule(current), levelSetsRule(settings))
  diff('forfeit', forfeitRule(current, s.setsPerMatch), forfeitRule(settings, setsPerMatch))

  if (s.status !== 'draft') {
    const locked = changed.filter((k) =>
      ['startDate', 'skipDates', 'meetings', 'includeFinals', 'seed', 'duty', 'setsPerMatch'].includes(k),
    )
    if (settings.sessions.length !== current.sessions.length) locked.push('the number of sessions')
    if (defaultCourtIds.length !== currentIds.length) locked.push('the number of courts')
    if (locked.length) throw drawLocked(`Changing ${locked.join(', ')}`)
  }

  const json: SeasonSettings = {
    sessions: settings.sessions,
    sessionMinutes: settings.sessionMinutes,
    meetings: settings.meetings,
    includeFinals: settings.includeFinals,
    seed: settings.seed,
    skipDates: settings.skipDates,
    defaultCourtIds,
    // Ladder policies: missing keys keep today's behaviour, so only store them once set.
    ...(settings.tieBreaks ? { tieBreaks: settings.tieBreaks } : {}),
    ...(settings.withdrawn ? { withdrawn: settings.withdrawn } : {}),
    ...(settings.levelSets ? { levelSets: settings.levelSets } : {}),
    ...(settings.forfeit ? { forfeit: settings.forfeit } : {}),
  }
  return {
    settings,
    defaultCourtIds,
    setsPerMatch,
    changed,
    columns: {
      name: settings.name,
      startDate: settings.startDate,
      settings: json,
      pointsWin: settings.points?.win ?? s.pointsWin,
      pointsDraw: settings.points?.draw ?? s.pointsDraw,
      pointsLoss: settings.points?.loss ?? s.pointsLoss,
      setsPerMatch,
      dutyEnabled: settings.duty !== false,
    },
  }
}

export type UpdateSeasonInput = { baseUpdatedAt?: unknown; settings?: unknown }

/**
 * Saves settings. If the season has a draw, each match's court and start time follow the new defaults (the draw
 * itself isn't touched: to re-lay dates after changing the start date or skip dates, send settings and weeks
 * together to saveDraw).
 */
export async function updateSeason(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  input: UpdateSeasonInput,
  now = new Date(),
): Promise<Changed<SeasonView>> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  const patch = parseSettingsPatch(input.settings)
  const d = await loadSeason(db, seasonId, { results: false })
  assertWritable(d, base)
  const stored = toCompetition(d)
  const resolver = resolverFor(d)
  const merged = mergeSettings(d, stored.settings, patch, resolver)
  const at = now.toISOString()
  await runBatch(db, [
    db
      .update(seasons)
      .set({ ...merged.columns, updatedAt: at, updatedBy: actor.id })
      .where(eq(seasons.id, seasonId)),
    ...resyncStatements(db, {
      sessions: merged.settings.sessions,
      defaultCourtIds: merged.defaultCourtIds,
      days: effectiveDays(d, stored.weeks, resolver),
      matches: d.matches,
      actorId: actor.id,
      at,
    }),
    audit(
      db,
      actor,
      'season.update',
      { type: 'season', id: seasonId },
      { name: d.season.name },
      { name: merged.settings.name, changed: merged.changed },
      at,
    ),
  ])
  return { result: await getSeason(db, seasonId), purge: seasonPurge(d) }
}

// ── The draw ──────────────────────────────────────────────────────────────────

/** Server-side checks on top of the lib's validate(): every team is in the season, and slots exist. */
export function drawProblems(settings: Settings, weeks: Week[]): Issue[] {
  const issues: Issue[] = []
  const members = new Set(settings.teams.map((t) => t.id))
  for (const w of weeks) {
    const where = w.kind === 'skip' ? `The week off on ${w.date}` : `Match day ${w.matchDay}`
    for (const g of w.games) {
      for (const r of [g.home, g.away, g.duty])
        if (r && 'team' in r && !members.has(r.team))
          issues.push({ level: 'error', weekId: w.id, gameIds: [g.id], message: `${where}: a game has a team that isn't in this season.` })
      if (g.session >= settings.sessions.length)
        issues.push({
          level: 'error',
          weekId: w.id,
          gameIds: [g.id],
          message: `${where}: a game is in session ${g.session + 1}, but there are only ${settings.sessions.length}.`,
        })
      if (g.court >= settings.courts.length)
        issues.push({
          level: 'error',
          weekId: w.id,
          gameIds: [g.id],
          message: `${where}: a game is in court slot ${g.court + 1}, but there are only ${settings.courts.length}.`,
        })
    }
  }
  return issues
}

/** Every problem with a draw: ours, then the lib's validate(). */
export const checkDraw = (settings: Settings, weeks: Week[]): Issue[] => [...drawProblems(settings, weeks), ...validate(settings, weeks)]

export type SaveDrawInput = {
  baseUpdatedAt?: unknown
  /** The whole draw, or null to clear it (drafts only). */
  weeks?: unknown
  /** shapeKey() of the settings the draw was generated from. */
  generatedFrom?: unknown
  edited?: unknown
  /** Optional settings saved in the same batch (e.g. a new start date with the re-laid weeks). */
  settings?: unknown
  /** 'csv' when the weeks came from a CSV import (audited as fixtures.import). Drafts only. */
  source?: unknown
}

export type SaveDrawResult = { season: SeasonMeta; issues: Issue[]; matchDays: SeasonView['matchDays'] }

/**
 * Saves the draw. Draft: the weeks replace match_days and matches whole (ids kept). Published: only court changes
 * are accepted (anything else is draw_locked) and the rows are updated in place, so results stay put. Error-level
 * issues are refused (422 invalid_draw); warnings come back in `issues`.
 */
export async function saveDraw(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  input: SaveDrawInput,
  now = new Date(),
): Promise<Changed<SaveDrawResult>> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  const weeks = input.weeks === null ? null : parseWeeks(input.weeks)
  const patch = parseSettingsPatch(input.settings)
  if (input.generatedFrom !== undefined && input.generatedFrom !== null && typeof input.generatedFrom !== 'string')
    throw invalid('generatedFrom must be text.')
  if (input.edited !== undefined && typeof input.edited !== 'boolean') throw invalid('edited must be true or false.')
  if (input.source !== undefined && input.source !== null && input.source !== 'csv') throw invalid('source must be "csv" or left out.')
  const imported = input.source === 'csv'

  const d = await loadSeason(db, seasonId, { results: false })
  assertWritable(d, base)
  if (imported && (d.season.status !== 'draft' || !weeks))
    throw new HttpError(409, 'draw_locked', 'A CSV import replaces the whole draw, so it only works on a draft season.')
  const resolver = resolverFor(d)
  const stored = toCompetition(d)
  const merged = mergeSettings(d, stored.settings, patch, resolver)
  const at = now.toISOString()
  const published = d.season.status !== 'draft'
  // Server-filled fields the checks need: which games were moved from another night (validate allows their double headers).
  const movedFrom = new Map(stored.weeks.flatMap((w) => w.games.flatMap((g) => (g.originalWeekId ? [[g.id, g.originalWeekId]] : []))))
  const sorted =
    weeks
      ?.toSorted((a, b) => a.date.localeCompare(b.date))
      .map((w) => ({
        ...w,
        games: w.games.map((g) => (movedFrom.has(g.id) ? { ...g, originalWeekId: movedFrom.get(g.id)! } : g)),
      })) ?? null

  let issues: Issue[] = []
  let statements
  let current: ReturnType<typeof effectiveDays> = []
  if (published) {
    if (!sorted || drawShapeChanged(stored.weeks, sorted)) throw drawLocked()
    current = effectiveDays(d, stored.weeks, resolver)
    const overrides = new Map(sorted.map((w) => [w.id, overrideIds(w, merged.defaultCourtIds, resolver)]))
    issues = validate(merged.settings, sorted)
    // Moving courts mustn't create a clash; anything else validate() finds was already there (imported seasons).
    const before = new Set(validate(stored.settings, stored.weeks).map((i) => i.message))
    const added = issues.filter((i) => i.level === 'error' && !before.has(i.message))
    if (added.length) throw invalidDraw(added)
    statements = resyncStatements(db, {
      sessions: merged.settings.sessions,
      defaultCourtIds: merged.defaultCourtIds,
      days: current,
      matches: d.matches,
      overrides,
      actorId: actor.id,
      at,
    })
  } else if (sorted) {
    issues = checkDraw(merged.settings, sorted)
    if (issues.some((i) => i.level === 'error')) throw invalidDraw(issues)
    statements = replaceDrawStatements(
      db,
      seasonId,
      drawRows(seasonId, merged.settings, merged.defaultCourtIds, sorted, resolver, actor.id, at),
    )
  } else {
    statements = [db.delete(matchDays).where(eq(matchDays.seasonId, seasonId))]
  }

  const generatedFrom = published
    ? d.season.generatedFrom
    : !sorted
      ? null
      : input.generatedFrom === undefined
        ? d.season.generatedFrom
        : ((input.generatedFrom as string | null) ?? null)
  const edited = published ? d.season.edited : typeof input.edited === 'boolean' ? input.edited : d.season.edited
  try {
    await runBatch(db, [
      ...statements,
      db
        .update(seasons)
        .set({ ...merged.columns, generatedFrom, edited: sorted ? edited : false, updatedAt: at, updatedBy: actor.id })
        .where(eq(seasons.id, seasonId)),
      audit(
        db,
        actor,
        imported ? 'fixtures.import' : 'season.draw_save',
        { type: 'season', id: seasonId },
        { matchDays: d.matchDays.length, matches: d.matches.length },
        {
          matchDays: sorted?.length ?? 0,
          matches: sorted?.reduce((n, w) => n + w.games.length, 0) ?? 0,
          generatedFrom,
          edited,
          ...(published ? { courtsOnly: true } : {}),
          ...(merged.changed.length ? { settings: merged.changed } : {}),
        },
        at,
      ),
    ])
  } catch (e) {
    if (isUniqueFailure(e)) throw invalid('An id in the draw is already used by another season. Regenerate the draw to get new ids.')
    throw e
  }
  const days = sorted ?? []
  const dayRows = new Map(d.matchDays.map((m) => [m.id, m]))
  return {
    result: {
      season: { ...seasonMeta(d.season), ...pickMeta(merged.columns), generatedFrom, edited: sorted ? edited : false, updatedAt: at },
      issues,
      matchDays: Object.fromEntries(
        days.map((w) => [
          w.id,
          // Draft saves rewrite every day; published saves only touch days whose overrides changed.
          {
            updatedAt: published ? dayUpdatedAt(dayRows.get(w.id), current, w, merged.defaultCourtIds, resolver, at) : at,
            resultsPublishedAt: dayRows.get(w.id)?.resultsPublishedAt ?? null,
          },
        ]),
      ),
    },
    purge: seasonPurge(d),
  }
}

const pickMeta = (c: Partial<NewSeason>): Partial<SeasonMeta> => ({
  ...(c.name !== undefined ? { name: c.name } : {}),
  ...(c.startDate !== undefined ? { startDate: c.startDate } : {}),
  ...(c.setsPerMatch !== undefined ? { setsPerMatch: c.setsPerMatch } : {}),
  ...(c.dutyEnabled !== undefined ? { dutyEnabled: c.dutyEnabled } : {}),
})

/**
 * Each match day's court overrides as they really are: the day's own, plus courts that imported matches were
 * played on (only in matches.court_id). Relative to the season's current default courts.
 */
function effectiveDays(d: LoadedSeason, weeks: Week[], resolver: CourtResolver): { id: string; courtOverrides: CourtOverrides }[] {
  const byId = new Map(weeks.map((w) => [w.id, w]))
  return d.matchDays.map((m) => {
    const w = byId.get(m.id)
    return { id: m.id, courtOverrides: w ? overrideIds(w, d.season.settings.defaultCourtIds ?? [], resolver) : (m.courtOverrides ?? {}) }
  })
}

const overridesKey = (o: CourtOverrides) => JSON.stringify(Object.entries(o).toSorted(([x], [y]) => x.localeCompare(y)))
const sameOverrides = (a: CourtOverrides, b: CourtOverrides) => overridesKey(a) === overridesKey(b)

/** A published save only rewrites (and so re-stamps) the days whose overrides changed. */
function dayUpdatedAt(
  row: MatchDay | undefined,
  current: { id: string; courtOverrides: CourtOverrides }[],
  w: Week,
  defaults: string[],
  resolver: CourtResolver,
  at: string,
): string {
  const now = current.find((c) => c.id === w.id)
  if (!row || !now) return at
  return sameOverrides(overrideIds(w, defaults, resolver), now.courtOverrides) ? row.updatedAt : at
}

// ── Teams in a season ─────────────────────────────────────────────────────────

export type SetTeamsInput = { baseUpdatedAt?: unknown; teamIds?: unknown }

/** Replaces a draft season's teams (in this order, which is the order shapeKey() sees). */
export async function setSeasonTeams(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  input: SetTeamsInput,
  now = new Date(),
): Promise<SeasonView> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  if (!Array.isArray(input.teamIds)) throw invalid('teamIds must be a list of team ids.')
  if (input.teamIds.length > 40) throw invalid('A season can have at most 40 teams.')
  const ids = input.teamIds.map((t, i) => id(t, `Team ${i + 1}`))
  if (new Set(ids).size !== ids.length) throw invalid('A team is listed twice.')
  const d = await loadSeason(db, seasonId, { draw: false })
  assertWritable(d, base)
  if (d.season.status !== 'draft') throw drawLocked('The team list')
  const found = ids.length ? await db.select({ id: teams.id }).from(teams).where(inArray(teams.id, ids)).all() : []
  if (found.length !== ids.length) throw invalid('One of those teams doesn’t exist.')
  const at = now.toISOString()
  const rows = ids.map((teamId, sort) => ({ seasonId, teamId, sort, updatedAt: at }))
  await runBatch(db, [
    db.delete(seasonTeams).where(eq(seasonTeams.seasonId, seasonId)),
    ...chunkByParams(rows).map((chunk) => db.insert(seasonTeams).values(chunk)),
    db.update(seasons).set({ updatedAt: at, updatedBy: actor.id }).where(eq(seasons.id, seasonId)),
    audit(db, actor, 'season.teams', { type: 'season', id: seasonId }, { teams: d.teams.map((t) => t.name) }, { teamIds: ids }, at),
  ])
  return getSeason(db, seasonId)
}

// ── Status ────────────────────────────────────────────────────────────────────

export type SeasonStatusChange = 'published' | 'draft' | 'archived'

/** Why a draft season can't be published yet, or null. */
export function publishSeasonProblem(
  c: Pick<Competition, 'settings' | 'weeks' | 'generatedFrom'>,
): { message: string; issues?: Issue[] } | null {
  const errors = settingsErrors(c.settings)
  if (errors.length) return { message: errors.join(' ') }
  if (!c.weeks || !c.weeks.some((w) => w.kind !== 'skip' && w.games.length > 0)) return { message: 'Generate the draw before publishing.' }
  if (
    isStale({
      id: '',
      edited: false,
      updatedAt: 0,
      settings: c.settings,
      weeks: c.weeks,
      ...(c.generatedFrom ? { generatedFrom: c.generatedFrom } : {}),
    })
  )
    return { message: 'The teams or settings changed since the draw was generated. Regenerate it before publishing.' }
  const issues = checkDraw(c.settings, c.weeks)
  const error = issues.find((i) => i.level === 'error')
  return error ? { message: error.message, issues } : null
}

/**
 * Publish (draft -> published: locks the draw), unpublish (published -> draft, only before any results exist),
 * archive (published -> archived: read-only) and unarchive (archived -> published). Audited; purges the league.
 */
export async function setSeasonStatus(
  db: AppDb,
  actor: Editor,
  seasonId: string,
  input: { baseUpdatedAt?: unknown; status?: unknown },
  now = new Date(),
): Promise<Changed<SeasonView>> {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  const status = input.status
  if (status !== 'published' && status !== 'draft' && status !== 'archived') throw invalid('status must be published, draft or archived.')
  const d = await loadSeason(db, seasonId)
  if (base !== d.season.updatedAt) throw conflict()
  const from = d.season.status
  if (from === status) return { result: seasonView(d), purge: {} }
  const at = now.toISOString()
  let action: 'season.publish' | 'season.unpublish' | 'season.archive' | 'season.unarchive'
  let publishedAt = d.season.publishedAt
  if (from === 'draft' && status === 'published') {
    const c = toCompetition(d)
    const problem = publishSeasonProblem({
      settings: c.settings,
      weeks: d.matchDays.length ? c.weeks : null,
      generatedFrom: d.season.generatedFrom ?? undefined,
    })
    if (problem) throw new HttpError(422, 'not_ready', problem.message, problem.issues ? { issues: problem.issues } : undefined)
    action = 'season.publish'
    publishedAt = at
  } else if (from === 'published' && status === 'draft') {
    if (d.results.length > 0)
      throw new HttpError(
        409,
        'has_results',
        'Results have been entered for this season, so it can’t go back to draft. Archive it instead.',
      )
    action = 'season.unpublish'
    publishedAt = null
  } else if (from === 'published' && status === 'archived') action = 'season.archive'
  else if (from === 'archived' && status === 'published') action = 'season.unarchive'
  else throw new HttpError(409, 'bad_transition', `A ${from} season can’t become ${status}.`)

  await runBatch(db, [
    db.update(seasons).set({ status, publishedAt, updatedAt: at, updatedBy: actor.id }).where(eq(seasons.id, seasonId)),
    audit(db, actor, action, { type: 'season', id: seasonId }, { status: from, name: d.season.name }, { status, name: d.season.name }, at),
  ])
  const purge = { tags: [tags.season(d.season.slug), tags.league(d.league.slug), tags.site] }
  return { result: await getSeason(db, seasonId), purge }
}

/** Deletes a draft season (and its draft draw). Published and archived seasons can't be deleted. */
export async function deleteSeason(db: AppDb, actor: Editor, seasonId: string, input: { baseUpdatedAt?: unknown }, now = new Date()) {
  const base = baseUpdatedAt(input.baseUpdatedAt)
  const d = await loadSeason(db, seasonId, { draw: false })
  if (base !== d.season.updatedAt) throw conflict()
  if (d.season.status !== 'draft') throw new HttpError(409, 'not_draft', 'Only draft seasons can be deleted. Archive this one instead.')
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(seasons).where(eq(seasons.id, seasonId)),
    audit(db, actor, 'season.delete', { type: 'season', id: seasonId }, { name: d.season.name, slug: d.season.slug }, null, at),
  ])
  return { ok: true as const }
}
