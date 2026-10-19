import {
  byesForWeek,
  completeResult,
  courtName,
  formatAU,
  formatRatio,
  isTeam,
  makeResolver,
  ratio,
  slotKey,
  standings,
  withdrawnPolicy,
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
  /** In season_teams.sort order, with the season_teams withdrawal (null = still in). */
  teams: SeasonTeamRow[]
  matchDays: MatchDay[]
  matches: Match[]
  /** Draft and published rows; only published ones reach the public site. */
  results: MatchResult[]
  adjustments: LadderAdjustment[]
  /** All courts (a handful), for court names. */
  courts: Court[]
}

export type SeasonTeamRow = Team & { withdrawnAt?: string | null; withdrawnReason?: string | null }

/** A season_teams + teams join row as SeasonTeamRow (what the loaders select). */
export const seasonTeamRow = (r: { team: Team; withdrawnAt: string | null; withdrawnReason: string | null }): SeasonTeamRow => ({
  ...r.team,
  withdrawnAt: r.withdrawnAt,
  withdrawnReason: r.withdrawnReason,
})

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
        ...(r.outcome ? { outcome: r.outcome } : {}),
        ...(r.outcome && r.note ? { note: r.note } : {}),
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
    teams: d.teams.map((t) => ({
      id: t.id,
      name: t.name,
      ...(t.withdrawnAt ? { withdrawn: { at: t.withdrawnAt, reason: t.withdrawnReason ?? '' } } : {}),
    })),
    meetings: s.settings.meetings ?? 1,
    includeFinals: s.settings.includeFinals ?? false,
    points: { win: s.pointsWin, draw: s.pointsDraw, loss: s.pointsLoss },
    duty: s.dutyEnabled,
    seed: s.settings.seed ?? 0,
    ...(s.settings.tieBreaks ? { tieBreaks: s.settings.tieBreaks } : {}),
    ...(s.settings.withdrawn ? { withdrawn: s.settings.withdrawn } : {}),
    ...(s.settings.levelSets ? { levelSets: s.settings.levelSets } : {}),
    ...(s.settings.forfeit ? { forfeit: s.settings.forfeit } : {}),
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
          ...(m.status !== 'scheduled' ? { status: m.status } : {}),
          ...(m.statusNote ? { statusNote: m.statusNote } : {}),
          ...(m.referee ? { referee: m.referee } : {}),
          ...(m.originalMatchDayId && m.originalMatchDayId !== m.matchDayId ? { originalWeekId: m.originalMatchDayId } : {}),
        })),
      }
      if (day.note) week.note = day.note
      if (day.status && day.status !== 'scheduled') week.status = day.status
      if (day.originalDate) week.originalDate = day.originalDate
      if (Object.keys(overrides).length > 0) week.courtOverrides = overrides
      if (day.resultsPublishedAt) week.resultsPublishedAt = day.resultsPublishedAt
      return week
    })
  return { settings, weeks }
}

export type LadderRow = Standing & { pos: number; name: string; ratio: string }

/**
 * The public ladder: the library's standings from published results, plus ladder_adjustments (penalties and the
 * importer's reconciliation with old SportsPress tables), sorted by the season's tie-break order. Withdrawn teams
 * follow the season's policy (marked and last, or hidden).
 */
export function ladderRows(c: SeasonCompetition, adjustments: Pick<LadderAdjustment, 'teamId' | 'points'>[]): LadderRow[] {
  const extra = new Map<string, number>()
  for (const a of adjustments) extra.set(a.teamId, (extra.get(a.teamId) ?? 0) + a.points)
  const names = new Map(c.settings.teams.map((t) => [t.id, t.name]))
  return standings(c.settings, c.weeks, { adjustments: extra }).map((row, i) => ({
    ...row,
    pos: i + 1,
    name: names.get(row.teamId) ?? '',
    ratio: formatRatio(ratio(row)),
  }))
}

export type FixtureRow = {
  key: string
  date: string
  matchDay: number
  time: string
  /** "HOME vs AWAY", "SEMI FINAL 1 - (2ND) vs (3RD)", "BYE - TEAM" or a skipped week's note. */
  match: string
  /**
   * "2 - 0" once published ("W - L", "L - W" or "Draw" for an outcome decided by hand with no sets), "Cancelled" /
   * "Postponed" / "TBD" for games that are off, "Moved" on the night a moved game left, '-' for byes, '' before.
   */
  result: string
  /** Why the outcome was decided by hand, as shown under the result ("Aces awarded the win: Blockers short of players"), or ''. */
  resultNote: string
  /** matches.referee, or ''. */
  referee: string
  /** Set scores, "25-21, 19-25", when recorded. */
  sets: string
  court: string
  duty: string
  /** `moved`: a game moved from this night to another on its own, listed where it was ("moved to …"). Not an event. */
  kind: 'game' | 'bye' | 'skip' | 'moved'
  forfeit: boolean
  /** matches.status for games ('scheduled' for byes and weeks off). */
  status: Match['status']
  /** A public reason for the status ("Venue unavailable"), or ''. */
  note: string
  /** The date the night (or this game, moved on its own) was first scheduled for, when it has moved; ''. */
  movedFrom: string
  /** `moved` rows: the date the game moved to; ''. */
  movedTo: string
  /** Resolved team ids (null for an unresolved finals placeholder, or none): for team filters and team calendars. */
  teamIds: { home: string | null; away: string | null; duty: string | null }
  /** The match as written for people rather than tables: "Hit For Brains vs Ice Cold", "Semi Final 1: (2nd) vs (3rd)". */
  label: string
  /** Games: the sides as `match` shows them, so the table can link each team. */
  parts?: { title: string; home: string; away: string }
}

const label = (r: Ref, names: Map<string, string>) => (isTeam(r) ? (names.get(r.team) ?? 'Unknown team') : `(${r.label.toUpperCase()})`)
const plainLabel = (r: Ref, names: Map<string, string>) => (isTeam(r) ? (names.get(r.team) ?? 'Unknown team') : `(${r.label})`)
const noTeams = { home: null, away: null, duty: null }

const OFF_RESULT: Partial<Record<Match['status'], string>> = { cancelled: 'Cancelled', postponed: 'Postponed', tbd: 'TBD' }

/**
 * Rows for the fixtures table, in the old site's shape: Date, Match, Time, Results, Court, Match Day, Duty. Finals
 * placeholders are resolved to teams as results allow. Byes are listed after each night's games. A withdrawn team's
 * cancelled games show as byes for the opponent when the season's policy says so (withdrawn.fixtures = 'bye').
 */
export function fixtureRows(c: SeasonCompetition, matches: Pick<Match, 'id' | 'startTime' | 'status'>[] = []): FixtureRow[] {
  const { settings: s, weeks } = c
  const names = new Map(s.teams.map((t) => [t.id, t.name]))
  const withdrawn = new Set(s.teams.filter((t) => t.withdrawn).map((t) => t.id))
  const byeForWithdrawn = withdrawnPolicy(s).fixtures === 'bye'
  const byId = new Map(matches.map((m) => [m.id, m]))
  const resolve = makeResolver(s, weeks)
  const name = (r: Ref | null) => (r ? label(resolve(r) ?? r, names) : '')
  const plain = (r: Ref | null) => (r ? plainLabel(resolve(r) ?? r, names) : '')
  const resolvedTeam = (r: Ref | null) => {
    const t = r ? (resolve(r) ?? r) : null
    return t && isTeam(t) ? t.team : null
  }
  const rows: FixtureRow[] = []
  const base = {
    sets: '',
    court: '',
    duty: '',
    forfeit: false,
    status: 'scheduled' as const,
    note: '',
    teamIds: noTeams,
    resultNote: '',
    referee: '',
    movedTo: '',
  }
  const weekById = new Map(weeks.map((w) => [w.id, w]))
  // Games moved on their own, listed again on the night they left.
  const movedOut = new Map<string, { g: Game; to: Week }[]>()
  for (const to of weeks)
    for (const g of to.games)
      if (g.originalWeekId && weekById.has(g.originalWeekId))
        movedOut.set(g.originalWeekId, [...(movedOut.get(g.originalWeekId) ?? []), { g, to }])
  const decidedText = (g: Game) => {
    const p = g.publishedResult
    if (!p?.outcome || !p.note || (p.note === 'Forfeit' && g.status === 'forfeit')) return ''
    if (p.outcome === 'draw') return `Declared a draw: ${p.note}`
    return `${plain(p.outcome === 'home' ? g.home : g.away)} awarded the win: ${p.note}`
  }
  const resultText = (g: Game, r: ReturnType<typeof completeResult>) => {
    if (!r) return ''
    const o = g.publishedResult?.outcome
    if (o && r.home + r.away === 0) return o === 'draw' ? 'Draw' : o === 'home' ? 'W - L' : 'L - W'
    return `${r.home} - ${r.away}`
  }
  for (const w of weeks) {
    const movedFrom = w.originalDate && w.originalDate !== w.date ? w.originalDate : ''
    if (w.kind === 'skip') {
      rows.push({
        ...base,
        key: w.id,
        date: w.date,
        matchDay: 0,
        time: '',
        match: w.note ?? 'No games',
        label: w.note ?? 'No games',
        result: '',
        kind: 'skip',
        movedFrom,
      })
      continue
    }
    const games = w.games
      .map((g) => ({ g, time: byId.get(g.id)?.startTime ?? s.sessions[g.session] ?? '' }))
      .toSorted((a, b) => a.time.localeCompare(b.time) || a.g.session - b.g.session || a.g.court - b.g.court)
    const byes: { teamId: string; note: string }[] = byesForWeek(s, w, weeks).map((teamId) => ({ teamId, note: '' }))
    for (const { g, time } of games) {
      const status = g.status ?? byId.get(g.id)?.status ?? 'scheduled'
      const out = [g.home, g.away].filter(isTeam).find((r) => withdrawn.has(r.team))
      const r = completeResult(g.publishedResult)
      if (byeForWithdrawn && out && status === 'cancelled' && !r && w.kind === 'regular') {
        // The withdrawn team's game becomes a bye for the team it would have played.
        for (const side of [g.home, g.away])
          if (isTeam(side) && side.team !== out.team)
            byes.push({ teamId: side.team, note: `${names.get(out.team) ?? 'Opponent'} withdrew` })
        continue
      }
      const vs = `${name(g.home).toUpperCase()} vs ${name(g.away).toUpperCase()}`
      const plainVs = `${plain(g.home)} vs ${plain(g.away)}`
      rows.push({
        key: g.id,
        date: w.date,
        matchDay: w.matchDay,
        time,
        parts: { title: (g.title ?? '').toUpperCase(), home: name(g.home).toUpperCase(), away: name(g.away).toUpperCase() },
        match: g.title ? `${g.title.toUpperCase()} - ${vs}` : vs,
        label: g.title ? `${g.title}: ${plainVs}` : plainVs,
        teamIds: { home: resolvedTeam(g.home), away: resolvedTeam(g.away), duty: resolvedTeam(g.duty) },
        result: r ? resultText(g, r) : (OFF_RESULT[status] ?? ''),
        resultNote: r ? decidedText(g) : '',
        referee: g.referee ?? '',
        sets: (g.publishedResult?.sets ?? []).map(([h, a]) => `${h}-${a}`).join(', '),
        court: courtName(s, w, g.session, g.court),
        duty: name(g.duty),
        kind: 'game',
        forfeit: status === 'forfeit',
        status,
        note: g.statusNote ?? '',
        movedFrom: (g.originalWeekId && weekById.get(g.originalWeekId)?.date) || movedFrom,
        movedTo: '',
      })
    }
    for (const { g, to } of movedOut.get(w.id) ?? []) {
      const plainVs = `${plain(g.home)} vs ${plain(g.away)}`
      const vs = `${name(g.home).toUpperCase()} vs ${name(g.away).toUpperCase()}`
      rows.push({
        ...base,
        key: `${w.id}:moved:${g.id}`,
        date: w.date,
        matchDay: w.matchDay,
        time: '',
        match: g.title ? `${g.title.toUpperCase()} - ${vs}` : vs,
        label: g.title ? `${g.title}: ${plainVs}` : plainVs,
        teamIds: { home: resolvedTeam(g.home), away: resolvedTeam(g.away), duty: resolvedTeam(g.duty) },
        result: 'Moved',
        note: `Moved to ${formatAU(to.date)}`,
        kind: 'moved',
        movedFrom,
        movedTo: to.date,
      })
    }
    for (const { teamId, note } of byes)
      rows.push({
        ...base,
        key: `${w.id}:bye:${teamId}`,
        date: w.date,
        matchDay: w.matchDay,
        time: 'Bye',
        match: `BYE - ${(names.get(teamId) ?? '').toUpperCase()}`,
        label: `Bye: ${names.get(teamId) ?? ''}`,
        teamIds: { home: teamId, away: null, duty: null },
        result: '-',
        duty: '-',
        kind: 'bye',
        note,
        movedFrom,
      })
  }
  return rows
}
