import {
  byesForWeek,
  completeResult,
  courtName,
  formatRatio,
  isTeam,
  makeResolver,
  ratio,
  slotKey,
  standings,
  type Game,
  type Ref,
  type Result,
  type Settings,
  type Standing,
  type Week,
} from '../../lib/fixtures'
import type { Court, LadderAdjustment, League, Match, MatchDay, MatchResult, Season, Team } from '../db/schema'

// DB rows -> the fixtures library's Settings + Week[] (and back out as the public fixtures and ladder rows).
// Pure: the loader (load.ts) fetches the rows in one batch; everything here is plain data in, plain data out.

/** Everything one season's public pages need, as loaded from D1. */
export type SeasonData = {
  season: Season
  league: League
  /** In season_teams.sort order. */
  teams: Team[]
  matchDays: MatchDay[]
  matches: Match[]
  /** Draft and published rows; only published ones reach the public site. */
  results: MatchResult[]
  adjustments: LadderAdjustment[]
  /** All courts (a handful), for court names. */
  courts: Court[]
}

export type SeasonCompetition = { settings: Settings; weeks: Week[] }

const ref = (teamId: string | null, label: string | null): Ref => (teamId ? { team: teamId } : { label: label ?? 'TBC' })

/** A match_results row as the lib's Result. */
export const toResult = (r: MatchResult | undefined): Result | undefined =>
  r
    ? {
        home: r.homeSets,
        away: r.awaySets,
        homePoints: r.homePoints,
        awayPoints: r.awayPoints,
        ...(r.setScores && r.setScores.length > 0 ? { sets: r.setScores } : {}),
      }
    : undefined

/** The fixtures library's view of a season. Court overrides are court names, as the library expects. */
export function toCompetition(d: SeasonData): SeasonCompetition {
  const courtNames = new Map(d.courts.map((c) => [c.id, c.name]))
  const s = d.season
  const settings: Settings = {
    name: s.name,
    startDate: s.startDate,
    skipDates: s.settings.skipDates ?? [],
    courts: (s.settings.defaultCourtIds ?? []).map((id) => courtNames.get(id) ?? ''),
    sessions: s.settings.sessions ?? [],
    sessionMinutes: s.settings.sessionMinutes ?? 60,
    teams: d.teams.map((t) => ({ id: t.id, name: t.name })),
    meetings: s.settings.meetings ?? 1,
    includeFinals: s.settings.includeFinals ?? false,
    points: { win: s.pointsWin, draw: s.pointsDraw, loss: s.pointsLoss },
    duty: s.dutyEnabled,
    seed: s.settings.seed ?? 0,
  }

  const results = new Map(d.results.map((r) => [`${r.matchId}:${r.kind}`, r]))
  const byDay = new Map<string, Match[]>()
  for (const m of d.matches) {
    const list = byDay.get(m.matchDayId) ?? []
    list.push(m)
    byDay.set(m.matchDayId, list)
  }

  const weeks: Week[] = d.matchDays
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map((day) => {
      const games = (byDay.get(day.id) ?? []).toSorted((a, b) => a.session - b.session || a.position - b.position)
      // Overrides: the day's own (court ids), then whatever court each match actually resolved to.
      const overrides: Record<string, string> = {}
      for (const [key, courtId] of Object.entries(day.courtOverrides ?? {})) {
        const name = courtNames.get(courtId)
        if (name) overrides[key] = name
      }
      for (const m of games) {
        const name = m.courtId ? courtNames.get(m.courtId) : undefined
        if (name && name !== (settings.courts[m.position] ?? '')) overrides[slotKey(m.session, m.position)] = name
      }
      const week: Week = {
        id: day.id,
        kind: day.kind,
        date: day.date,
        matchDay: day.number,
        games: games.map((m): Game => ({
          id: m.id,
          session: m.session,
          court: m.position,
          home: ref(m.homeTeamId, m.homeLabel),
          away: ref(m.awayTeamId, m.awayLabel),
          duty: m.dutyTeamId || m.dutyLabel ? ref(m.dutyTeamId, m.dutyLabel) : null,
          ...(m.stageTitle ? { title: m.stageTitle } : {}),
          result: toResult(results.get(`${m.id}:draft`)),
          publishedResult: toResult(results.get(`${m.id}:published`)),
        })),
      }
      if (day.note) week.note = day.note
      if (Object.keys(overrides).length > 0) week.courtOverrides = overrides
      if (day.resultsPublishedAt) week.resultsPublishedAt = day.resultsPublishedAt
      return week
    })
  return { settings, weeks }
}

export type LadderRow = Standing & { pos: number; name: string; ratio: string }

/**
 * The public ladder: the library's standings from published results, plus ladder_adjustments (penalties and the
 * importer's reconciliation with old SportsPress tables), re-sorted with the library's tie-breaks.
 */
export function ladderRows(c: SeasonCompetition, adjustments: Pick<LadderAdjustment, 'teamId' | 'points'>[]): LadderRow[] {
  const extra = new Map<string, number>()
  for (const a of adjustments) extra.set(a.teamId, (extra.get(a.teamId) ?? 0) + a.points)
  const names = new Map(c.settings.teams.map((t) => [t.id, t.name]))
  const name = (id: string) => names.get(id) ?? ''
  return standings(c.settings, c.weeks)
    .map((row) => ({ ...row, points: row.points + (extra.get(row.teamId) ?? 0) }))
    .toSorted(
      (a, b) =>
        b.points - a.points ||
        b.setsFor - b.setsAgainst - (a.setsFor - a.setsAgainst) ||
        b.pointsFor - b.pointsAgainst - (a.pointsFor - a.pointsAgainst) ||
        b.won - a.won ||
        name(a.teamId).localeCompare(name(b.teamId)),
    )
    .map((row, i) => ({ ...row, pos: i + 1, name: name(row.teamId), ratio: formatRatio(ratio(row)) }))
}

export type FixtureRow = {
  key: string
  date: string
  matchDay: number
  time: string
  /** "HOME vs AWAY", "SEMI FINAL 1 - (2ND) vs (3RD)", "BYE - TEAM" or a skipped week's note. */
  match: string
  /** "2 - 0" once published, '-' for byes, '' before. */
  result: string
  /** Set scores, "25-21, 19-25", when recorded. */
  sets: string
  court: string
  duty: string
  kind: 'game' | 'bye' | 'skip'
  forfeit: boolean
}

const label = (r: Ref, names: Map<string, string>) => (isTeam(r) ? (names.get(r.team) ?? 'Unknown team') : `(${r.label.toUpperCase()})`)

/**
 * Rows for the fixtures table, in the old site's shape: Date, Match, Time, Results, Court, Match Day, Duty. Finals
 * placeholders are resolved to teams as results allow. Byes are listed after each night's games.
 */
export function fixtureRows(c: SeasonCompetition, matches: Pick<Match, 'id' | 'startTime' | 'status'>[] = []): FixtureRow[] {
  const { settings: s, weeks } = c
  const names = new Map(s.teams.map((t) => [t.id, t.name]))
  const byId = new Map(matches.map((m) => [m.id, m]))
  const resolve = makeResolver(s, weeks)
  const name = (r: Ref | null) => (r ? label(resolve(r) ?? r, names) : '')
  const rows: FixtureRow[] = []
  for (const w of weeks) {
    if (w.kind === 'skip') {
      rows.push({
        key: w.id,
        date: w.date,
        matchDay: 0,
        time: '',
        match: w.note ?? 'No games',
        result: '',
        sets: '',
        court: '',
        duty: '',
        kind: 'skip',
        forfeit: false,
      })
      continue
    }
    const games = w.games
      .map((g) => ({ g, time: byId.get(g.id)?.startTime ?? s.sessions[g.session] ?? '' }))
      .toSorted((a, b) => a.time.localeCompare(b.time) || a.g.session - b.g.session || a.g.court - b.g.court)
    for (const { g, time } of games) {
      const r = completeResult(g.publishedResult)
      const vs = `${name(g.home).toUpperCase()} vs ${name(g.away).toUpperCase()}`
      rows.push({
        key: g.id,
        date: w.date,
        matchDay: w.matchDay,
        time,
        match: g.title ? `${g.title.toUpperCase()} - ${vs}` : vs,
        result: r ? `${r.home} - ${r.away}` : byId.get(g.id)?.status === 'cancelled' ? 'Cancelled' : '',
        sets: (g.publishedResult?.sets ?? []).map(([h, a]) => `${h}-${a}`).join(', '),
        court: courtName(s, w, g.session, g.court),
        duty: name(g.duty),
        kind: 'game',
        forfeit: byId.get(g.id)?.status === 'forfeit',
      })
    }
    for (const t of byesForWeek(s, w))
      rows.push({
        key: `${w.id}:bye:${t}`,
        date: w.date,
        matchDay: w.matchDay,
        time: 'Bye',
        match: `BYE - ${(names.get(t) ?? '').toUpperCase()}`,
        result: '-',
        sets: '',
        court: '',
        duty: '-',
        kind: 'bye',
        forfeit: false,
      })
  }
  return rows
}
