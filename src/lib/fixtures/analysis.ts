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

export function byesForWeek(s: Settings, w: Week): string[] {
  if (w.kind !== 'regular') return []
  const playing = new Set(w.games.flatMap((g) => [teamOf(g.home), teamOf(g.away)]))
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
    for (const g of w.games) {
      const h = teamOf(g.home)
      const a = teamOf(g.away)
      for (const t of [h, a]) if (t) sessionOf.set(t, [...(sessionOf.get(t) ?? []), g.session])
      if (h && a) {
        if (h === a) issues.push({ level: 'error', weekId: w.id, gameIds: [g.id], message: `${where}: ${name(h)} is playing itself.` })
        else meetings.set(pairKey(h, a), (meetings.get(pairKey(h, a)) ?? 0) + 1)
      }
    }
    for (const [t, ss] of sessionOf)
      if (ss.length > 1) issues.push({ level: 'error', weekId: w.id, message: `${where}: ${name(t)} is playing ${ss.length} games.` })

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

    const byes = byesForWeek(s, w)
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
