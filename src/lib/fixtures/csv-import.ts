import { uid } from './rng'
import { weekdayName } from './dates'
import type { Game, Ref, Settings, SkipDate, Team, Week, WeekKind } from './types'

// CSV fixture import: the fallback when the generator can't produce the draw the organiser wants (or it was made
// somewhere else). Runs in the browser: parse, preview with every problem listed, then the admin saves the result as
// the draft season's draw through the ordinary PUT /draw. Pure, so it's tested in Node.
//
// One row per game. Columns are found by their header (any order, any case):
//   Date (YYYY-MM-DD or DD/MM/YYYY) · Time (20:00, 8pm, 8:30 pm) · Home · Away · Court · Duty (optional) ·
//   Stage (optional: "Semi Final 1", "Grand Final" …) · Note (optional)
// A row with a date and no teams is a week off; its Note (or Stage, as "No games: reason") is the reason. Rows whose
// Stage is "Bye" are skipped, so the season's own CSV export (fullCsv) imports as is. Finals placeholders are written
// in brackets, "(1ST)" or "(Winner SF1)", as the export writes them.

export type CsvIssue = { level: 'error' | 'warning'; line: number | null; message: string }

export type CsvImport = {
  weeks: Week[]
  /**
   * The settings the draw implies: start date, weeks off, session times, default courts (by position), whether it
   * has finals, and how many times the most-met pair meets.
   */
  settings: Pick<Settings, 'startDate' | 'skipDates' | 'sessions' | 'courts' | 'includeFinals' | 'meetings'>
  issues: CsvIssue[]
  games: number
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF. Tabs or semicolons instead of commas are detected. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const count = (c: string) => firstLine.split(c).length - 1
  const sep = count('\t') > 0 ? '\t' : count(';') > count(',') ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"' && cell === '') quoted = true
    else if (c === sep) {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

const COLUMNS = {
  date: ['date', 'day'],
  time: ['time', 'start', 'start time', 'session'],
  home: ['home', 'home team', 'team 1', 'team a'],
  away: ['away', 'away team', 'team 2', 'team b'],
  court: ['court', 'venue', 'court name'],
  duty: ['duty', 'duty team', 'referee', 'ref', 'refs'],
  stage: ['stage', 'title', 'round'],
  note: ['note', 'notes', 'reason'],
} as const
type Column = keyof typeof COLUMNS

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase()

/** "2026-11-05", "5/11/2026", "05/11/26" → YYYY-MM-DD, or null. */
export function parseCsvDate(v: string): string | null {
  const s = v.trim()
  let y: number, m: number, d: number
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s)
    if (!match) return null
    ;[d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])]
    if (y < 100) y += 2000
  }
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

/** "20:00", "8pm", "8:30 PM", "20.00" → HH:MM, or null. */
export function parseCsvTime(v: string): string | null {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i.exec(v.trim())
  if (!match) return null
  let h = Number(match[1])
  const min = Number(match[2] ?? 0)
  const ap = match[3]?.toLowerCase()
  if (!match[2] && !ap) return null
  if (ap) {
    if (h < 1 || h > 12) return null
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
  }
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

const SEED_LABELS = ['1st', '2nd', '3rd', '4th']

/** "(WINNER SF1)" → "Winner SF1", "(2ND)" → "2nd"; other bracketed text is kept as written. */
export function placeholderLabel(v: string): string | null {
  const match = /^\((.+)\)$/.exec(v.trim())
  if (!match) return null
  const inner = match[1]!.trim()
  const seed = SEED_LABELS.find((l) => l === inner.toLowerCase())
  if (seed) return seed
  const wl = /^(winner|loser)\s+(sf1|sf2|gf)$/i.exec(inner)
  if (wl) return `${wl[1]![0]!.toUpperCase()}${wl[1]!.slice(1).toLowerCase()} ${wl[2]!.toUpperCase()}`
  return inner
}

const stageKind = (title: string): WeekKind => {
  const t = norm(title)
  if (t.includes('semi')) return 'semi'
  if (t.includes('final') || t.includes('place') || t.includes('playoff') || t.includes('play-off')) return 'final'
  return 'regular'
}

/**
 * Turns CSV text into a draw for `teams`, with courts matched to `courtNames` (the courts the season can use).
 * Problems come back as issues with their line number; the weeks are built from the rows that parsed, so the preview
 * can show both. Run validate() on the result for the draw's own checks (clashes, duty, byes).
 */
export function importFixturesCsv(text: string, opts: { teams: Team[]; courtNames: string[]; newId?: () => string }): CsvImport {
  const newId = opts.newId ?? uid
  const issues: CsvIssue[] = []
  const error = (line: number | null, message: string) => issues.push({ level: 'error', line, message })
  const rows = parseCsv(text)
  const empty: CsvImport = {
    weeks: [],
    settings: { startDate: '', skipDates: [], sessions: [], courts: [], includeFinals: false, meetings: 1 },
    issues,
    games: 0,
  }
  const headerAt = rows.findIndex((r) => r.some((c) => c.trim()))
  if (headerAt < 0) {
    error(null, 'The file is empty.')
    return empty
  }
  const header = rows[headerAt]!.map(norm)
  const col = {} as Record<Column, number>
  for (const [key, names] of Object.entries(COLUMNS) as [Column, readonly string[]][]) col[key] = header.findIndex((h) => names.includes(h))
  const missing = (['date', 'time', 'home', 'away', 'court'] as const).filter((k) => col[k] < 0)
  if (missing.length) {
    error(
      headerAt + 1,
      `The first row needs column headings, including ${missing.map((m) => m[0]!.toUpperCase() + m.slice(1)).join(', ')}. Found: ${rows[headerAt]!.join(', ')}.`,
    )
    return empty
  }

  const teamByName = new Map(opts.teams.map((t) => [norm(t.name), t]))
  const courtByName = new Map(opts.courtNames.filter(Boolean).map((c) => [norm(c), c]))
  const unknownTeams = new Map<string, number>()
  const unknownCourts = new Map<string, number>()

  type Parsed = { line: number; date: string; time: string; court: string; home: Ref; away: Ref; duty: Ref | null; title: string }
  const games: Parsed[] = []
  const skips = new Map<string, { reason: string; line: number }>()

  const refOf = (raw: string, line: number, what: string, optional = false): Ref | null => {
    const v = raw.trim()
    if (!v) {
      if (!optional) error(line, `${what} is blank.`)
      return null
    }
    const label = placeholderLabel(v)
    if (label) return { label }
    const team = teamByName.get(norm(v))
    if (team) return { team: team.id }
    if (!unknownTeams.has(v)) unknownTeams.set(v, line)
    return null
  }

  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i]!
    const line = i + 1
    const cell = (k: Column) => (col[k] >= 0 ? (r[col[k]] ?? '').trim() : '')
    if (r.every((c) => !c.trim())) continue
    const stage = cell('stage')
    if (norm(stage) === 'bye') continue
    const date = parseCsvDate(cell('date'))
    if (!date) {
      error(line, `“${cell('date')}” isn’t a date (use YYYY-MM-DD or DD/MM/YYYY).`)
      continue
    }
    if (!cell('home') && !cell('away')) {
      const reason = cell('note') || stage.replace(/^no games:?\s*/i, '') || 'No games'
      if (skips.has(date)) error(line, `${date} is listed as a week off twice.`)
      skips.set(date, { reason, line })
      continue
    }
    const time = parseCsvTime(cell('time'))
    if (!time) error(line, `“${cell('time')}” isn’t a time (use 20:00 or 8pm).`)
    const courtRaw = cell('court')
    const court = courtByName.get(norm(courtRaw))
    if (!courtRaw) error(line, 'Court is blank.')
    else if (!court && !unknownCourts.has(courtRaw)) unknownCourts.set(courtRaw, line)
    const home = refOf(cell('home'), line, 'Home team')
    const away = refOf(cell('away'), line, 'Away team')
    const duty = refOf(cell('duty'), line, 'Duty', true)
    if (!time || !court || !home || !away) continue
    games.push({ line, date, time, court, home, away, duty, title: /^round robin$/i.test(stage) ? '' : stage })
  }
  for (const [name, line] of unknownTeams)
    error(line, `There’s no team called “${name}” in this season. Add it on the Setup tab (or fix the spelling), then import again.`)
  for (const [name, line] of unknownCourts)
    error(line, `There’s no court called “${name}”. Courts: ${opts.courtNames.filter(Boolean).join(', ') || 'none yet'}.`)
  for (const date of skips.keys())
    if (games.some((g) => g.date === date)) error(skips.get(date)!.line, `${date} has games, so it can’t also be a week off.`)

  const sessions = [...new Set(games.map((g) => g.time))].toSorted()
  // Default courts by position: the courts in the order they first appear.
  const courts = [...new Set(games.map((g) => g.court))]
  const byDate = new Map<string, Parsed[]>()
  for (const g of games) byDate.set(g.date, [...(byDate.get(g.date) ?? []), g])
  const dates = [...new Set([...byDate.keys(), ...skips.keys()])].toSorted()
  if (courts.length > 12) error(null, `A draw can use at most 12 courts; this one names ${courts.length}.`)
  if (sessions.length > 8) error(null, `A draw can have at most 8 session times; this one has ${sessions.length}.`)
  const weekdays = new Set(dates.map(weekdayName))
  if (weekdays.size > 1)
    issues.push({ level: 'warning', line: null, message: `The dates fall on different days of the week (${[...weekdays].join(', ')}).` })

  const weeks: Week[] = []
  let matchDay = 0
  for (const date of dates) {
    const skip = skips.get(date)
    const list = byDate.get(date)
    if (!list) {
      weeks.push({ id: newId(), kind: 'skip', date, matchDay: 0, games: [], note: skip!.reason })
      continue
    }
    matchDay++
    const kinds = new Set(list.map((g) => (g.title ? stageKind(g.title) : 'regular')))
    const kind: WeekKind = kinds.has('semi') ? 'semi' : kinds.has('final') ? 'final' : 'regular'
    const used = new Map<string, number>()
    const weekGames: Game[] = list.map((g) => {
      const session = sessions.indexOf(g.time)
      const court = courts.indexOf(g.court)
      const slot = `${session}:${court}`
      if (used.has(slot)) error(g.line, `Two games on ${g.court} at ${g.time} on ${date} (also line ${used.get(slot)}).`)
      used.set(slot, g.line)
      return {
        id: newId(),
        session,
        court,
        home: g.home,
        away: g.away,
        duty: g.duty,
        ...(g.title ? { title: g.title } : {}),
      }
    })
    weeks.push({ id: newId(), kind, date, matchDay, games: weekGames.toSorted((a, b) => a.session - b.session || a.court - b.court) })
  }
  if (weeks.length === 0 && issues.every((i) => i.level !== 'error')) error(null, 'No games found below the headings.')
  if (weeks.length > 30) error(null, `A season can have at most 30 weeks; this one has ${weeks.length}.`)

  const skipDates: SkipDate[] = [...skips].map(([date, s]) => ({ date, reason: s.reason })).toSorted((a, b) => a.date.localeCompare(b.date))
  const pairs = new Map<string, number>()
  for (const w of weeks)
    if (w.kind === 'regular')
      for (const g of w.games)
        if ('team' in g.home && 'team' in g.away) {
          const key = [g.home.team, g.away.team].toSorted().join('|')
          pairs.set(key, (pairs.get(key) ?? 0) + 1)
        }
  const meetings = Math.min(4, Math.max(1, ...pairs.values()))
  const includeFinals = weeks.some((w) => w.kind === 'semi' || w.kind === 'final')
  return {
    weeks,
    settings: { startDate: dates[0] ?? '', skipDates, sessions, courts, includeFinals, meetings },
    issues: issues.toSorted((a, b) => (a.line ?? 0) - (b.line ?? 0)),
    games: games.length,
  }
}
