import { byesForWeek } from './analysis'
import { addMinutes } from './dates'
import { completeResult, makeResolver } from './results'
import { courtName, isTeam, type Game, type Ref, type Settings, type Week } from './types'

export function refName(s: Settings, r: Ref | null): string {
  if (!r) return ''
  if (isTeam(r)) return s.teams.find((t) => t.id === r.team)?.name ?? 'Unknown team'
  return `(${r.label.toUpperCase()})`
}

export type PublicRow = {
  date: string
  matchDay: number
  time: string
  match: string
  venue: string
  duty: string
  /** "2 - 1" once logged, as on the website. */
  result: string
  kind: 'game' | 'bye' | 'skip'
}

// only published results go out
// (derived from set scores when they were entered)
const score = (g: Game) => {
  const r = completeResult(g.publishedResult)
  return r ? `${r.home} - ${r.away}` : ''
}
const pointsScore = (g: Game) => {
  const r = completeResult(g.publishedResult)
  return r ? `${r.homePoints} - ${r.awayPoints}` : ''
}

/** Rows in the same shape as the fixtures table on tempevb.com. */
export function publicRows(s: Settings, weeks: Week[]): PublicRow[] {
  const resolve = makeResolver(s, weeks)
  const name = (r: Ref | null) => refName(s, resolve(r))
  const rows: PublicRow[] = []
  for (const w of weeks) {
    if (w.kind === 'skip') {
      rows.push({ date: w.date, matchDay: 0, time: '', match: w.note ?? 'No games', venue: '', duty: '', result: '', kind: 'skip' })
      continue
    }
    for (const g of w.games) {
      const vs = `${name(g.home).toUpperCase()} vs ${name(g.away).toUpperCase()}`
      rows.push({
        date: w.date,
        matchDay: w.matchDay,
        time: s.sessions[g.session] ?? '',
        match: g.title ? `${g.title.toUpperCase()} - ${vs}` : vs,
        venue: courtName(s, w, g.session, g.court),
        duty: name(g.duty),
        result: score(g),
        kind: 'game',
      })
    }
    for (const t of byesForWeek(s, w, weeks)) {
      const last = s.sessions[s.sessions.length - 1] ?? ''
      rows.push({
        date: w.date,
        matchDay: w.matchDay,
        time: last ? addMinutes(last, s.sessionMinutes) : '',
        match: `BYE - ${refName(s, { team: t }).toUpperCase()}`,
        venue: '',
        duty: '',
        result: '',
        kind: 'bye',
      })
    }
  }
  return rows
}

const csvCell = (v: string | number) => {
  const str = String(v)
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}
const toCsv = (rows: (string | number)[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'

/** Everything, one row per game/bye — handy for spreadsheets or the developer. */
export function fullCsv(s: Settings, weeks: Week[]): string {
  const resolve = makeResolver(s, weeks)
  const name = (r: Ref | null) => refName(s, resolve(r))
  const rows: (string | number)[][] = [['Date', 'Match Day', 'Time', 'Court', 'Stage', 'Home', 'Away', 'Duty', 'Sets', 'Points']]
  for (const w of weeks) {
    if (w.kind === 'skip') {
      rows.push([w.date, '', '', '', `No games: ${w.note ?? ''}`, '', '', '', '', ''])
      continue
    }
    for (const g of w.games)
      rows.push([
        w.date,
        w.matchDay,
        s.sessions[g.session] ?? '',
        courtName(s, w, g.session, g.court),
        g.title ?? 'Round robin',
        name(g.home),
        name(g.away),
        name(g.duty),
        score(g),
        pointsScore(g),
      ])
    for (const t of byesForWeek(s, w, weeks)) rows.push([w.date, w.matchDay, '', '', 'Bye', refName(s, { team: t }), '', '', '', ''])
  }
  return toCsv(rows)
}
