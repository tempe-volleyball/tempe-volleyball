import { courtName, dutyEnabled, isTeam, type Game, type Ref, type Settings, type Week } from './types'

export type TeamStats = {
  teamId: string
  games: number
  perSession: number[]
  duties: number
  byes: number
  /** Longest run of consecutive played weeks in the same session. */
  longestSameSlot: number
}

const teamOf = (r: Ref | null) => (isTeam(r) ? r.team : null)

export function teamStats(s: Settings, weeks: Week[]): TeamStats[] {
  const stats = new Map<string, TeamStats>(
    s.teams.map((t) => [t.id, { teamId: t.id, games: 0, perSession: s.sessions.map(() => 0), duties: 0, byes: 0, longestSameSlot: 0 }]),
  )
  const last = new Map<string, { session: number; run: number }>()

  for (const w of weeks) {
    if (w.kind !== 'regular') continue
    const playing = new Set<string>()
    for (const g of w.games) {
      for (const t of [teamOf(g.home), teamOf(g.away)]) {
        const st = t ? stats.get(t) : undefined
        if (!t || !st) continue
        playing.add(t)
        st.games++
        if (g.session < st.perSession.length) st.perSession[g.session]!++
        const prev = last.get(t)
        const run = prev && prev.session === g.session ? prev.run + 1 : 1
        last.set(t, { session: g.session, run })
        st.longestSameSlot = Math.max(st.longestSameSlot, run)
      }
      const d = teamOf(g.duty)
      if (d && stats.has(d)) stats.get(d)!.duties++
    }
    for (const st of stats.values()) if (!playing.has(st.teamId)) st.byes++
  }
  return [...stats.values()]
}

/**
 * Teams without a game that night. With `weeks` (the whole draw), a game moved from this night to another on its
 * own (Game.originalWeekId) still counts as this night's, so its teams aren't on a bye, and a catch-up night made
 * only of moved games has no byes.
 */
export function byesForWeek(s: Settings, w: Week, weeks?: Week[]): string[] {
  if (w.kind !== 'regular') return []
  if (w.games.length > 0 && w.games.every((g) => g.originalWeekId && g.originalWeekId !== w.id)) return []
  const movedOut = weeks ? weeks.flatMap((x) => (x.id === w.id ? [] : x.games.filter((g) => g.originalWeekId === w.id))) : []
  const playing = new Set(
    [...w.games.filter((g) => !g.originalWeekId || g.originalWeekId === w.id), ...movedOut].flatMap((g) => [
      teamOf(g.home),
      teamOf(g.away),
    ]),
  )
  return s.teams.filter((t) => !playing.has(t.id)).map((t) => t.id)
}

export type Issue = {
  level: 'error' | 'warning'
  message: string
  weekId?: string
  /** Games to flag in the editor. */
  gameIds?: string[]
}

export function validate(s: Settings, weeks: Week[]): Issue[] {
  const issues: Issue[] = []
  const name = (id: string) => s.teams.find((t) => t.id === id)?.name ?? 'Unknown team'
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const meetings = new Map<string, number>()

  for (const w of weeks) {
    if (w.kind === 'skip') continue
    const where = `Match day ${w.matchDay}`

    // court clashes: courts can be changed per slot, so compare by name
    const onCourt = new Map<string, Game>()
    for (const g of w.games) {
      const court = courtName(s, w, g.session, g.court)
      const time = s.sessions[g.session] ?? 'the same time'
      if (!court) {
        issues.push({ level: 'error', weekId: w.id, gameIds: [g.id], message: `${where}: a game at ${time} has no court.` })
        continue
      }
      const k = `${g.session}|${court.trim().toLowerCase()}`
      const other = onCourt.get(k)
      if (other)
        issues.push({ level: 'error', weekId: w.id, gameIds: [other.id, g.id], message: `${where}: two games on ${court} at ${time}.` })
      onCourt.set(k, g)
    }
    if (w.kind !== 'regular') continue

    const sessionOf = new Map<string, number[]>()
    // Games moved here from another night (a catch-up game) can make a double header, which is allowed.
    const ownSessions = new Map<string, number[]>()
    const movedIn = (g: Game) => !!g.originalWeekId && g.originalWeekId !== w.id
    for (const g of w.games) {
      const h = teamOf(g.home)
      const a = teamOf(g.away)
      for (const t of [h, a])
        if (t) {
          sessionOf.set(t, [...(sessionOf.get(t) ?? []), g.session])
          if (!movedIn(g)) ownSessions.set(t, [...(ownSessions.get(t) ?? []), g.session])
        }
      if (h && a) {
        if (h === a) issues.push({ level: 'error', weekId: w.id, gameIds: [g.id], message: `${where}: ${name(h)} is playing itself.` })
        else meetings.set(pairKey(h, a), (meetings.get(pairKey(h, a)) ?? 0) + 1)
      }
    }
    for (const [t, ss] of ownSessions)
      if (ss.length > 1) issues.push({ level: 'error', weekId: w.id, message: `${where}: ${name(t)} is playing ${ss.length} games.` })
    for (const [t, ss] of sessionOf) {
      if (ss.length === (ownSessions.get(t)?.length ?? 0)) continue
      if (new Set(ss).size < ss.length)
        issues.push({ level: 'error', weekId: w.id, message: `${where}: ${name(t)} is playing two games at the same time.` })
      else if (ss.length > 1)
        issues.push({
          level: 'warning',
          weekId: w.id,
          message: `${where}: ${name(t)} plays twice (one is a game moved from another night).`,
        })
    }

    const dutyNight = new Map<string, number>()
    for (const g of w.games) {
      if (!dutyEnabled(s)) {
        // TVSL: Volleyball NSW referees, so no team should be on duty.
        if (g.duty)
          issues.push({
            level: 'warning',
            weekId: w.id,
            gameIds: [g.id],
            message: `${where}: a game has a duty team, but this season has no team duty.`,
          })
        continue
      }
      const d = teamOf(g.duty)
      if (!d) {
        issues.push({ level: 'warning', weekId: w.id, gameIds: [g.id], message: `${where}: a game has no duty team.` })
        continue
      }
      dutyNight.set(d, (dutyNight.get(d) ?? 0) + 1)
      const ds = sessionOf.get(d)
      if (!ds) {
        issues.push({
          level: 'error',
          weekId: w.id,
          gameIds: [g.id],
          message: `${where}: ${name(d)} has duty but isn't playing that night.`,
        })
      } else if (ds.includes(g.session)) {
        issues.push({
          level: 'error',
          weekId: w.id,
          gameIds: [g.id],
          message: `${where}: ${name(d)} has duty while playing at the same time.`,
        })
      } else if (s.sessions.length > 1 && !ds.some((x) => Math.abs(x - g.session) === 1)) {
        issues.push({
          level: 'warning',
          weekId: w.id,
          gameIds: [g.id],
          message: `${where}: ${name(d)} has duty in a session that isn't next to their game, so they'd be waiting around.`,
        })
      }
    }
    for (const [t, n] of dutyNight)
      if (n > 1) issues.push({ level: 'warning', weekId: w.id, message: `${where}: ${name(t)} has ${n} duties in one night.` })

    const byes = byesForWeek(s, w, weeks)
    if (byes.length > s.teams.length % 2)
      issues.push({
        level: 'warning',
        weekId: w.id,
        message: `${where}: ${byes.map(name).join(', ')} ${byes.length === 1 ? 'has' : 'have'} no game.`,
      })
  }

  // every pair should meet exactly `meetings` times
  const wrong: string[] = []
  for (let i = 0; i < s.teams.length; i++)
    for (let j = i + 1; j < s.teams.length; j++) {
      const n = meetings.get(pairKey(s.teams[i]!.id, s.teams[j]!.id)) ?? 0
      if (n !== s.meetings) wrong.push(`${s.teams[i]!.name} v ${s.teams[j]!.name} (${n}×)`)
    }
  if (wrong.length)
    issues.push({
      level: 'warning',
      message: `Should meet ${s.meetings}× but don't: ${wrong.slice(0, 6).join(', ')}${wrong.length > 6 ? ` and ${wrong.length - 6} more` : ''}.`,
    })

  const counts = teamStats(s, weeks).map((t) => t.games)
  if (counts.length && Math.max(...counts) !== Math.min(...counts))
    issues.push({ level: 'error', message: 'Teams are playing different numbers of games.' })

  return issues
}

/** Issues with the same message on several nights, as one line ("A game has no duty team", 36 times, match days 1–9). */
export type IssueGroup = { level: Issue['level']; message: string; count: number; weekIds: string[]; matchDays: number[] }

/**
 * Groups validate()'s issues by what they say, ignoring the "Match day N: " prefix, in first-seen order. For long
 * lists that repeat one thing every night, such as an imported draw the old site kept without duty teams.
 */
export function groupIssues(issues: Issue[], weeks: Week[]): IssueGroup[] {
  const dayOf = new Map(weeks.map((w) => [w.id, w.matchDay]))
  const groups = new Map<string, IssueGroup>()
  for (const i of issues) {
    const text = i.message.replace(/^Match day \d+: /, '')
    const message = text.charAt(0).toUpperCase() + text.slice(1)
    const key = `${i.level}|${message}`
    const g = groups.get(key) ?? { level: i.level, message, count: 0, weekIds: [], matchDays: [] }
    g.count++
    if (i.weekId && !g.weekIds.includes(i.weekId)) {
      g.weekIds.push(i.weekId)
      const day = dayOf.get(i.weekId)
      if (day !== undefined) g.matchDays.push(day)
    }
    groups.set(key, g)
  }
  return [...groups.values()]
}

/** "match days 1–4, 6 and 8", for a list of match day numbers. */
export function matchDaysText(days: number[]): string {
  const sorted = [...new Set(days)].toSorted((a, b) => a - b)
  if (sorted.length === 0) return ''
  const runs: string[] = []
  for (let i = 0; i < sorted.length;) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    if (j - i >= 2) runs.push(`${sorted[i]}–${sorted[j]}`)
    else for (let k = i; k <= j; k++) runs.push(`${sorted[k]}`)
    i = j + 1
  }
  const list = runs.length > 1 ? `${runs.slice(0, -1).join(', ')} and ${runs.at(-1)}` : runs[0]!
  return `${sorted.length === 1 ? 'match day' : 'match days'} ${list}`
}
