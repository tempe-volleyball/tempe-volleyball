import { and, asc, eq, gte, lte, ne, or, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { addDays } from '../../lib/fixtures'
import { sydneyDate } from '../../lib/time'
import { runBatch, type AppDb } from '../db'
import { courts, leagues, matchDays, matches, matchResults, matchStatuses, seasons, teams, venues, type Match } from '../db/schema'
import { date, invalid, isId } from './input'

// The cross-league match list (docs/admin.md §1 "Match list"): every game in a date range, across leagues, filtered
// by league, season, team (playing or on duty), venue, court and status. "Everything on this Thursday" is
// from = to = that date. The matches (one query with joins) plus one db.batch() of the small filter lists.

export const MATCH_LIST_LIMIT = 500
/** The widest range one request may ask for. */
export const MATCH_LIST_MAX_DAYS = 366

export type MatchListQuery = {
  from?: string | null
  to?: string | null
  leagueId?: string | null
  seasonId?: string | null
  teamId?: string | null
  venueId?: string | null
  courtId?: string | null
  status?: string | null
  /** Draft seasons are left out unless asked for. */
  drafts?: boolean
}

export type MatchSide = { teamId: string; name: string } | { label: string } | null

export type MatchListRow = {
  id: string
  seasonId: string
  seasonName: string
  seasonStatus: 'draft' | 'published' | 'archived'
  leagueId: string
  leagueCode: string
  matchDayId: string
  date: string
  /** Match day number (the lib's Week.matchDay). */
  matchDay: number
  dayKind: 'regular' | 'semi' | 'final' | 'skip'
  dayStatus: 'scheduled' | 'postponed' | 'cancelled'
  startTime: string | null
  courtId: string | null
  courtName: string | null
  venueId: string | null
  venueName: string | null
  title: string | null
  home: MatchSide
  away: MatchSide
  duty: MatchSide
  status: Match['status']
  statusNote: string | null
  /** The published result, or null. */
  result: { homeSets: number | null; awaySets: number | null; homePoints: number | null; awayPoints: number | null } | null
  /** Has a draft result that hasn't been published yet. */
  unpublished: boolean
}

export type MatchList = {
  from: string
  to: string
  rows: MatchListRow[]
  /** True when there were more than MATCH_LIST_LIMIT games: narrow the filters. */
  truncated: boolean
  options: {
    leagues: { id: string; code: string; name: string }[]
    seasons: { id: string; leagueId: string; name: string; status: string }[]
    teams: { id: string; name: string }[]
    venues: { id: string; name: string }[]
    courts: { id: string; name: string; venueId: string }[]
  }
}

const optId = (v: string | null | undefined, label: string) => {
  if (v === undefined || v === null || v === '') return null
  if (!isId(v)) throw invalid(`${label} must be an id.`)
  return v
}

/** Reads ?from=&to=&league=&season=&team=&venue=&court=&status=&drafts=1 into a MatchListQuery. */
export const matchListQuery = (p: URLSearchParams): MatchListQuery => ({
  from: p.get('from'),
  to: p.get('to'),
  leagueId: p.get('league'),
  seasonId: p.get('season'),
  teamId: p.get('team'),
  venueId: p.get('venue'),
  courtId: p.get('court'),
  status: p.get('status'),
  drafts: p.get('drafts') === '1',
})

const side = (teamId: string | null, name: string | null, label: string | null): MatchSide =>
  teamId ? { teamId, name: name ?? 'Unknown team' } : label ? { label } : null

/** The games matching the filters, in date and time order, and the lists the filters choose from. */
export async function listMatches(db: AppDb, q: MatchListQuery, now = new Date()): Promise<MatchList> {
  const from = q.from ? date(q.from, 'From') : sydneyDate(now)
  const to = q.to ? date(q.to, 'To') : addDays(from, 6)
  if (to < from) throw invalid('“To” is before “From”.')
  if (addDays(from, MATCH_LIST_MAX_DAYS) < to) throw invalid(`Pick at most ${MATCH_LIST_MAX_DAYS} days.`)
  const leagueId = optId(q.leagueId, 'League')
  const seasonId = optId(q.seasonId, 'Season')
  const teamId = optId(q.teamId, 'Team')
  const venueId = optId(q.venueId, 'Venue')
  const courtId = optId(q.courtId, 'Court')
  const status = q.status || null
  if (status && !(matchStatuses as readonly string[]).includes(status)) throw invalid(`Status must be one of ${matchStatuses.join(', ')}.`)

  const home = alias(teams, 'home_team')
  const away = alias(teams, 'away_team')
  const duty = alias(teams, 'duty_team')
  const published = alias(matchResults, 'published_result')
  const draft = alias(matchResults, 'draft_result')

  const where: SQL[] = [gte(matchDays.date, from), lte(matchDays.date, to)]
  if (!q.drafts) where.push(ne(seasons.status, 'draft'))
  if (leagueId) where.push(eq(seasons.leagueId, leagueId))
  if (seasonId) where.push(eq(matches.seasonId, seasonId))
  if (teamId) where.push(or(eq(matches.homeTeamId, teamId), eq(matches.awayTeamId, teamId), eq(matches.dutyTeamId, teamId))!)
  // A game without a court counts as at its league's venue.
  if (venueId) where.push(or(eq(courts.venueId, venueId), and(sql`${matches.courtId} is null`, eq(leagues.defaultVenueId, venueId)))!)
  if (courtId) where.push(eq(matches.courtId, courtId))
  if (status) where.push(eq(matches.status, status as Match['status']))

  // The games run on their own, not in the batch: D1's batch() returns rows as objects keyed by column name, so the
  // joined columns that share a name (id, name, team_id …) would overwrite each other. A plain query reads raw arrays.
  const rowsQuery = db
    .select({
      id: matches.id,
      seasonId: matches.seasonId,
      seasonName: seasons.name,
      seasonStatus: seasons.status,
      leagueId: seasons.leagueId,
      leagueCode: leagues.code,
      matchDayId: matches.matchDayId,
      date: matchDays.date,
      matchDay: matchDays.number,
      dayKind: matchDays.kind,
      dayStatus: matchDays.status,
      startTime: matches.startTime,
      courtId: matches.courtId,
      courtName: courts.name,
      venueId: sql<string | null>`coalesce(${courts.venueId}, ${leagues.defaultVenueId})`,
      venueName: venues.name,
      title: matches.stageTitle,
      homeTeamId: matches.homeTeamId,
      homeName: home.name,
      homeLabel: matches.homeLabel,
      awayTeamId: matches.awayTeamId,
      awayName: away.name,
      awayLabel: matches.awayLabel,
      dutyTeamId: matches.dutyTeamId,
      dutyName: duty.name,
      dutyLabel: matches.dutyLabel,
      status: matches.status,
      statusNote: matches.statusNote,
      homeSets: published.homeSets,
      awaySets: published.awaySets,
      homePoints: published.homePoints,
      awayPoints: published.awayPoints,
      hasPublished: sql<number>`${published.matchId} is not null`,
      draftHome: draft.homeSets,
      draftAway: draft.awaySets,
      draftHomePoints: draft.homePoints,
      draftAwayPoints: draft.awayPoints,
      hasDraft: sql<number>`${draft.matchId} is not null`,
    })
    .from(matches)
    .innerJoin(matchDays, eq(matchDays.id, matches.matchDayId))
    .innerJoin(seasons, eq(seasons.id, matches.seasonId))
    .innerJoin(leagues, eq(leagues.id, seasons.leagueId))
    .leftJoin(courts, eq(courts.id, matches.courtId))
    .leftJoin(venues, eq(venues.id, sql`coalesce(${courts.venueId}, ${leagues.defaultVenueId})`))
    .leftJoin(home, eq(home.id, matches.homeTeamId))
    .leftJoin(away, eq(away.id, matches.awayTeamId))
    .leftJoin(duty, eq(duty.id, matches.dutyTeamId))
    .leftJoin(published, and(eq(published.matchId, matches.id), eq(published.kind, 'published')))
    .leftJoin(draft, and(eq(draft.matchId, matches.id), eq(draft.kind, 'draft')))
    .where(and(...where))
    .orderBy(asc(matchDays.date), asc(matches.startTime), asc(leagues.sort), asc(matches.session), asc(matches.position))
    .limit(MATCH_LIST_LIMIT + 1)
  const [rows, [leagueRows, seasonRows, teamRows, venueRows, courtRows]] = (await Promise.all([
    rowsQuery.all(),
    runBatch(db, [
      db
        .select({ id: leagues.id, code: leagues.code, name: leagues.name })
        .from(leagues)
        .where(eq(leagues.kind, 'league'))
        .orderBy(asc(leagues.sort), asc(leagues.code)),
      db
        .select({ id: seasons.id, leagueId: seasons.leagueId, name: seasons.name, status: seasons.status })
        .from(seasons)
        .orderBy(sql`${seasons.year} desc`, sql`${seasons.quarter} desc`, asc(seasons.name)),
      db.select({ id: teams.id, name: teams.name }).from(teams).orderBy(asc(teams.name)),
      db.select({ id: venues.id, name: venues.name }).from(venues).orderBy(asc(venues.sort), asc(venues.name)),
      db.select({ id: courts.id, name: courts.name, venueId: courts.venueId }).from(courts).orderBy(asc(courts.sort), asc(courts.name)),
    ]),
  ])) as unknown as [
    {
      id: string
      seasonId: string
      seasonName: string
      seasonStatus: MatchListRow['seasonStatus']
      leagueId: string
      leagueCode: string
      matchDayId: string
      date: string
      matchDay: number
      dayKind: MatchListRow['dayKind']
      dayStatus: MatchListRow['dayStatus']
      startTime: string | null
      courtId: string | null
      courtName: string | null
      venueId: string | null
      venueName: string | null
      title: string | null
      homeTeamId: string | null
      homeName: string | null
      homeLabel: string | null
      awayTeamId: string | null
      awayName: string | null
      awayLabel: string | null
      dutyTeamId: string | null
      dutyName: string | null
      dutyLabel: string | null
      status: Match['status']
      statusNote: string | null
      homeSets: number | null
      awaySets: number | null
      homePoints: number | null
      awayPoints: number | null
      hasPublished: number
      draftHome: number | null
      draftAway: number | null
      draftHomePoints: number | null
      draftAwayPoints: number | null
      hasDraft: number
    }[],
    [
      MatchList['options']['leagues'],
      MatchList['options']['seasons'],
      MatchList['options']['teams'],
      MatchList['options']['venues'],
      MatchList['options']['courts'],
    ],
  ]
  const truncated = rows.length > MATCH_LIST_LIMIT
  return {
    from,
    to,
    truncated,
    rows: rows.slice(0, MATCH_LIST_LIMIT).map((r) => ({
      id: r.id,
      seasonId: r.seasonId,
      seasonName: r.seasonName,
      seasonStatus: r.seasonStatus,
      leagueId: r.leagueId,
      leagueCode: r.leagueCode,
      matchDayId: r.matchDayId,
      date: r.date,
      matchDay: r.matchDay,
      dayKind: r.dayKind,
      dayStatus: r.dayStatus,
      startTime: r.startTime,
      courtId: r.courtId,
      courtName: r.courtName,
      venueId: r.venueId,
      venueName: r.venueName,
      title: r.title,
      home: side(r.homeTeamId, r.homeName, r.homeLabel),
      away: side(r.awayTeamId, r.awayName, r.awayLabel),
      duty: side(r.dutyTeamId, r.dutyName, r.dutyLabel),
      status: r.status,
      statusNote: r.statusNote,
      result: r.hasPublished ? { homeSets: r.homeSets, awaySets: r.awaySets, homePoints: r.homePoints, awayPoints: r.awayPoints } : null,
      unpublished:
        !!r.hasDraft &&
        (!r.hasPublished ||
          r.draftHome !== r.homeSets ||
          r.draftAway !== r.awaySets ||
          r.draftHomePoints !== r.homePoints ||
          r.draftAwayPoints !== r.awayPoints),
    })),
    options: { leagues: leagueRows, seasons: seasonRows, teams: teamRows, venues: venueRows, courts: courtRows },
  }
}
