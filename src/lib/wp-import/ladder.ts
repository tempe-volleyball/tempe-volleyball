import { DEFAULT_POINTS, standings, type Game, type Points, type Standing, type Team, type Week } from '../fixtures'
import type { MappedResult } from './results'

// Reconciling imported results with SportsPress league tables: compute each season's ladder with the fixtures
// library (from the imported, published results) and compare it with the table SportsPress shows.

export type LadderGame = {
  date: string
  /** Round-robin game (finals don't count on the ladder). */
  regular: boolean
  homeTeam: string | null
  awayTeam: string | null
  result: MappedResult | null
}

/** The fixtures library's ladder for imported games: one Week per date, results as published. */
export function computeLadder(teams: Team[], games: LadderGame[], points: Points = DEFAULT_POINTS): Standing[] {
  const byDate = new Map<string, Game[]>()
  let n = 0
  for (const g of games) {
    if (!g.regular || !g.homeTeam || !g.awayTeam) continue
    const r = g.result
    const game: Game = {
      id: `g${n++}`,
      session: 0,
      court: 0,
      home: { team: g.homeTeam },
      away: { team: g.awayTeam },
      duty: null,
      publishedResult: r
        ? {
            home: r.homeSets,
            away: r.awaySets,
            homePoints: r.homePoints,
            awayPoints: r.awayPoints,
            ...(r.setScores ? { sets: r.setScores } : {}),
          }
        : undefined,
    }
    const list = byDate.get(g.date) ?? []
    list.push(game)
    byDate.set(g.date, list)
  }
  const weeks: Week[] = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, gs], i) => ({ id: `w${i}`, kind: 'regular', date, matchDay: i + 1, games: gs }))
  return standings(
    {
      name: '',
      startDate: weeks[0]?.date ?? '',
      skipDates: [],
      courts: [],
      sessions: [],
      sessionMinutes: 60,
      teams,
      meetings: 1,
      includeFinals: false,
      points,
      seed: 0,
    },
    weeks,
  )
}

/** One row of a SportsPress league table (sp_table data), keyed to our team id. */
export type TableRow = {
  teamId: string
  pts: number
  p: number
  w: number
  d: number
  l: number
  setsFor: number
  setsAgainst: number
  pointsFor: number
  pointsAgainst: number
}

const FIELDS = [
  ['pts', 'points'],
  ['p', 'played'],
  ['w', 'won'],
  ['d', 'drawn'],
  ['l', 'lost'],
  ['setsFor', 'setsFor'],
  ['setsAgainst', 'setsAgainst'],
  ['pointsFor', 'pointsFor'],
  ['pointsAgainst', 'pointsAgainst'],
] as const

export type LadderDiff = {
  teamId: string
  /** SportsPress ladder points minus computed: the ladder adjustment that makes them agree. */
  pointsDiff: number
  /** Every column that differs: [column, SportsPress, computed]. */
  fields: [string, number, number][]
}

/** The SportsPress table's numbers (null when blank) as a TableRow. */
export function tableRow(teamId: string, data: Record<string, unknown>): TableRow {
  const n = (k: string) => {
    const v = Number(data[k] ?? 0)
    return Number.isFinite(v) ? v : 0
  }
  return {
    teamId,
    pts: n('pts'),
    p: n('p'),
    w: n('w'),
    d: n('d'),
    l: n('l'),
    setsFor: n('s'),
    setsAgainst: n('stwo'),
    pointsFor: n('pw'),
    pointsAgainst: n('pl'),
  }
}

/** Teams whose computed ladder row differs from the SportsPress table. Teams missing on one side count as zeros. */
export function compareLadders(computed: Standing[], table: TableRow[]): LadderDiff[] {
  const zero: Standing = {
    teamId: '',
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    setsFor: 0,
    setsAgainst: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    points: 0,
  }
  const byTeam = new Map(computed.map((s) => [s.teamId, s]))
  const ids = [...new Set([...table.map((t) => t.teamId), ...computed.filter((c) => c.played > 0).map((c) => c.teamId)])]
  const diffs: LadderDiff[] = []
  for (const id of ids) {
    const c = byTeam.get(id) ?? { ...zero, teamId: id }
    const t = table.find((r) => r.teamId === id) ?? {
      teamId: id,
      pts: 0,
      p: 0,
      w: 0,
      d: 0,
      l: 0,
      setsFor: 0,
      setsAgainst: 0,
      pointsFor: 0,
      pointsAgainst: 0,
    }
    const fields: [string, number, number][] = []
    for (const [tk, ck] of FIELDS) if (t[tk] !== c[ck]) fields.push([tk, t[tk], c[ck]])
    if (fields.length) diffs.push({ teamId: id, pointsDiff: t.pts - c.points, fields })
  }
  return diffs
}

/** TableRows as Standings, to compare two tables with compareLadders. */
export const asStandings = (rows: TableRow[]): Standing[] =>
  rows.map((r) => ({
    teamId: r.teamId,
    played: r.p,
    won: r.w,
    drawn: r.d,
    lost: r.l,
    setsFor: r.setsFor,
    setsAgainst: r.setsAgainst,
    pointsFor: r.pointsFor,
    pointsAgainst: r.pointsAgainst,
    points: r.pts,
  }))

/**
 * SportsPress outcomes on tempevb.com. Level-sets matches were decided on total points: "draww" (drew on sets, won
 * on points) counted as a win, "drawl" as a loss, and only "drawd" (points level too) as a draw.
 */
const OUTCOME: Record<string, 'w' | 'd' | 'l'> = { win: 'w', draww: 'w', loss: 'l', drawl: 'l', drawd: 'd', draw: 'd' }

export type OutcomeGame = LadderGame & { homeOutcome: string | null; awayOutcome: string | null }

/**
 * The table SportsPress would show for a season, rebuilt from each event's outcome (win 3, draw 2, loss 1).
 * Used for seasons whose SportsPress table no longer exists (tables only keep the latest season).
 */
export function outcomeTable(teamIds: string[], games: OutcomeGame[], points: Points = DEFAULT_POINTS): TableRow[] {
  const rows = new Map<string, TableRow>(
    teamIds.map((id) => [id, { teamId: id, pts: 0, p: 0, w: 0, d: 0, l: 0, setsFor: 0, setsAgainst: 0, pointsFor: 0, pointsAgainst: 0 }]),
  )
  for (const g of games) {
    const r = g.result
    if (!g.regular || !g.homeTeam || !g.awayTeam || !r) continue
    const sides = [
      [g.homeTeam, g.homeOutcome, r.homeSets, r.awaySets, r.homePoints, r.awayPoints],
      [g.awayTeam, g.awayOutcome, r.awaySets, r.homeSets, r.awayPoints, r.homePoints],
    ] as const
    for (const [team, o, sf, sa, pf, pa] of sides) {
      const row = rows.get(team)
      const kind = (o ? OUTCOME[o] : undefined) ?? (sf > sa ? 'w' : sf < sa ? 'l' : 'd')
      if (!row) continue
      row.p++
      row[kind]++
      row.pts += kind === 'w' ? points.win : kind === 'l' ? points.loss : points.draw
      row.setsFor += sf
      row.setsAgainst += sa
      row.pointsFor += pf
      row.pointsAgainst += pa
    }
  }
  return [...rows.values()]
}
