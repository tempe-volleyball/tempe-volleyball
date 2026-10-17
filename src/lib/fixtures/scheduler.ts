// new Array(n).fill(x) is used on purpose: the optimiser builds these arrays in hot loops, and it reads clearly here.
/* oxlint-disable unicorn/no-new-array */
import { addDays } from './dates'
import { makeRng, shuffle, uid } from './rng'
import { dutyEnabled, type Game, type Ref, type Settings, type Week } from './types'

// Internally teams are indexes into settings.teams; pairs are [home, away].
type Pair = [number, number]
type Rng = () => number

export type SeasonShape = {
  teams: number
  gamesPerNight: number
  byesPerNight: number
  slotsPerNight: number
  roundsPerCycle: number
  regularRounds: number
  finalsWeeks: number
  playingWeeks: number
  gamesPerTeam: number
}

export function seasonShape(s: Settings): SeasonShape {
  const n = s.teams.length
  const roundsPerCycle = n < 2 ? 0 : n % 2 === 0 ? n - 1 : n
  const regularRounds = roundsPerCycle * Math.max(1, s.meetings)
  const finalsWeeks = s.includeFinals && n >= 4 ? 2 : 0
  return {
    teams: n,
    gamesPerNight: Math.floor(n / 2),
    byesPerNight: n % 2,
    slotsPerNight: s.courts.length * s.sessions.length,
    roundsPerCycle,
    regularRounds,
    finalsWeeks,
    playingWeeks: regularRounds + finalsWeeks,
    gamesPerTeam: Math.max(0, n - 1) * Math.max(1, s.meetings),
  }
}

/** Problems that stop a draw from being generated at all. */
export function settingsErrors(s: Settings): string[] {
  const errors: string[] = []
  const shape = seasonShape(s)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.startDate)) errors.push('Pick a start date.')
  if (s.teams.length < 2) errors.push('Add at least 2 teams.')
  const names = s.teams.map((t) => t.name.trim().toLowerCase())
  if (names.some((n) => !n)) errors.push('Every team needs a name.')
  if (new Set(names).size !== names.length) errors.push('Team names must be unique.')
  if (s.courts.length < 1) errors.push('Add at least one court.')
  if (s.sessions.length < 1) errors.push('Add at least one session time.')
  if (s.meetings < 1) errors.push('Teams must meet at least once.')
  if (shape.gamesPerNight > shape.slotsPerNight)
    errors.push(
      `${shape.teams} teams need ${shape.gamesPerNight} games a night, but ${s.courts.length} court(s) × ${s.sessions.length} session(s) only gives ${shape.slotsPerNight} slots.`,
    )
  return errors
}

// ---------------------------------------------------------------------------
// Round robin (circle method)

function roundRobin(order: number[]): Pair[][] {
  const list: (number | null)[] = order.slice()
  if (list.length % 2 === 1) list.push(null)
  const n = list.length
  const rounds: Pair[][] = []
  for (let r = 0; r < n - 1; r++) {
    const pairs: Pair[] = []
    for (let i = 0; i < n / 2; i++) {
      const a = list[i]
      const b = list[n - 1 - i]
      if (a == null || b == null) continue // that team has the bye
      // alternate who is listed first so no team is always "home"
      pairs.push((r + i) % 2 === 0 ? [a, b] : [b, a])
    }
    rounds.push(pairs)
    // rotate all but the first element
    list.splice(1, 0, list.pop()!)
  }
  return rounds
}

// ---------------------------------------------------------------------------
// How many games in each session

/**
 * Can every game get a ref from an adjacent session, with nobody reffing
 * twice? Games in session s draw on the 2 × caps[s±1] teams next to them.
 */
function dutyFeasible(caps: number[]): boolean {
  const games: number[] = caps.flatMap((n, s) => new Array<number>(n).fill(s))
  const teams: number[] = caps.flatMap((n, s) => new Array<number>(n * 2).fill(s))
  const matchOf = new Array<number>(teams.length).fill(-1)
  const tryGame = (g: number, seen: boolean[]): boolean => {
    for (let t = 0; t < teams.length; t++) {
      if (seen[t] || Math.abs(teams[t]! - games[g]!) !== 1) continue
      seen[t] = true
      if (matchOf[t] === -1 || tryGame(matchOf[t]!, seen)) {
        matchOf[t] = g
        return true
      }
    }
    return false
  }
  return games.every((_, g) => tryGame(g, new Array<boolean>(teams.length).fill(false)))
}

/**
 * The ways of splitting a night's games across sessions that we're happy to
 * use: as even as possible, and (if at all possible, and only when teams
 * referee) every game can be reffed by a team playing next to it.
 */
export function sessionPatterns(games: number, sessions: number, courts: number, duty = true): number[][] {
  const all: number[][] = []
  const rec = (prefix: number[], left: number) => {
    if (prefix.length === sessions) return void (left === 0 && all.push(prefix))
    for (let n = Math.min(courts, left); n >= 0; n--) rec([...prefix, n], left - n)
  }
  rec([], games)
  const spread = (c: number[]) => Math.max(...c) - Math.min(...c)
  const feasible = duty && sessions > 1 ? all.filter(dutyFeasible) : []
  const pool = feasible.length ? feasible : all
  const best = Math.min(...pool.map(spread))
  return pool.filter((c) => spread(c) === best)
}

// ---------------------------------------------------------------------------
// Duty assignment

/**
 * Hungarian algorithm: for an n × m cost matrix (n ≤ m) return the column
 * assigned to each row so the total cost is minimal.
 */
function minCostAssignment(cost: number[][]): number[] {
  const n = cost.length
  const m = cost[0]?.length ?? 0
  const u = new Array<number>(n + 1).fill(0)
  const v = new Array<number>(m + 1).fill(0)
  const p = new Array<number>(m + 1).fill(0) // p[j]: row matched to column j (1-based)
  const way = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(m + 1).fill(Infinity)
    const used = new Array<boolean>(m + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]!
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!
        if (cur < minv[j]!) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j]! < delta) {
          delta = minv[j]!
          j1 = j
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!]! += delta
          v[j]! -= delta
        } else {
          minv[j]! -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]!
      p[j0] = p[j1]!
      j0 = j1
    } while (j0)
  }
  const result = new Array<number>(n).fill(-1)
  for (let j = 1; j <= m; j++) if (p[j]) result[p[j]! - 1] = j - 1
  return result
}

/**
 * Pick a duty team for every game in one night. Duty must come from a team
 * playing in an adjacent session (so nobody turns up just to ref), each team
 * refs at most once a night where possible, and season duty totals stay level.
 * `totals` holds every other night's duty count.
 */
function assignDuties(pairs: Pair[], session: number[], totals: number[], rng: Rng): number[] {
  const G = pairs.length
  const sessionOf = new Map<number, number>()
  pairs.forEach((p, g) => p.forEach((t) => sessionOf.set(t, session[g]!)))
  const playing = [...sessionOf.keys()]
  // Adding a duty to a team on x takes the sum of squares up by 2x + 1, so
  // picking the cheapest teams keeps the season even. Jitter breaks ties.
  const cost = new Map(playing.map((t) => [t, totals[t]! + rng() * 0.1]))

  const candidates = pairs.map((p, g) => {
    const adjacent = playing.filter((t) => Math.abs(sessionOf.get(t)! - session[g]!) === 1)
    // Fallback (e.g. one session only): anyone else playing tonight.
    const pool = adjacent.length > 0 ? adjacent : playing.filter((t) => !p.includes(t))
    return pool
  })

  // Cheapest one-duty-per-team assignment of games to teams.
  const BLOCKED = 1e6
  const matrix = pairs.map((_, g) => playing.map((t) => (candidates[g]!.includes(t) ? cost.get(t)! : BLOCKED)))
  const pick = G <= playing.length ? minCostAssignment(matrix) : null
  if (pick && pick.every((col, g) => matrix[g]![col]! < BLOCKED)) return pick.map((col) => playing[col]!)

  // Nobody left to give a single duty to: allow doubles, greedily.
  const order = candidates.map((_, g) => g).sort((a, b) => candidates[a]!.length - candidates[b]!.length)
  const tonight = new Map<number, number>()
  const result = new Array<number>(G)
  for (const g of order) {
    const score = (t: number) => cost.get(t)! + (tonight.get(t) ?? 0) * 100
    // -1: nobody else is playing tonight (e.g. three teams, one game)
    const pick = candidates[g]!.reduce((a, b) => (a === -1 || score(b) < score(a) ? b : a), -1)
    result[g] = pick
    tonight.set(pick, (tonight.get(pick) ?? 0) + 1)
  }
  return result
}

// ---------------------------------------------------------------------------
// Optimisation of sessions + duties

type Round = { pairs: Pair[]; session: number[]; duty: number[] }

const W_BALANCE = 10 // uneven spread of a team across session times (squared)
const W_DUTY = 40 // uneven duty totals (sum of squares)
const STREAK = [0, 0, 2, 40, 120] // cost of playing the same slot k weeks running

class Season {
  rounds: Round[]
  teams: number
  sessions: number
  private patterns: Set<string>
  private rng: Rng
  /** false: no team duty (TVSL), so every duty stays -1. */
  private duty: boolean
  totals: number[]

  constructor(rounds: Round[], teams: number, sessions: number, patterns: Set<string>, rng: Rng, duty = true) {
    this.rounds = rounds
    this.teams = teams
    this.sessions = sessions
    this.patterns = patterns
    this.rng = rng
    this.duty = duty
    this.totals = new Array<number>(teams).fill(0)
    for (const r of rounds) this.count(r.duty, +1)
  }

  private count(duty: number[], by: number) {
    for (const t of duty) if (t >= 0) this.totals[t]! += by
  }

  cost(): number {
    const { teams, sessions } = this
    const counts = new Float64Array(teams * sessions)
    const sessionTotals = new Float64Array(sessions)
    const last = new Int32Array(teams).fill(-1)
    const run = new Int32Array(teams)
    let c = 0
    let games = 0
    for (const r of this.rounds) {
      for (let g = 0; g < r.pairs.length; g++) {
        const s = r.session[g]!
        sessionTotals[s]!++
        games++
        for (const t of r.pairs[g]!) {
          counts[t * sessions + s]!++
          run[t] = last[t] === s ? run[t]! + 1 : 1
          last[t] = s
          c += STREAK[Math.min(run[t]!, STREAK.length - 1)]!
        }
      }
    }
    // Every team plays the same number of games, so its fair share of each
    // session is proportional to how many games that session hosts overall.
    const perTeam = (games * 2) / teams
    for (let t = 0; t < teams; t++)
      for (let s = 0; s < sessions; s++) {
        const d = counts[t * sessions + s]! - (perTeam * sessionTotals[s]!) / games
        c += W_BALANCE * d * d
      }
    for (const n of this.totals) c += W_DUTY * n * n
    return c
  }

  /** Re-pick one round's duties, holding every other round fixed. */
  redoDuties(ri: number) {
    const r = this.rounds[ri]!
    this.count(r.duty, -1)
    r.duty = this.duty ? assignDuties(r.pairs, r.session, this.totals, this.rng) : r.pairs.map(() => -1)
    this.count(r.duty, +1)
  }

  private allowed(session: number[]): boolean {
    const caps = new Array<number>(this.sessions).fill(0)
    for (const s of session) caps[s]!++
    return this.patterns.has(caps.join(','))
  }

  /**
   * Try one random change: swap two games' sessions, or move a game to a
   * different session (if that night's split stays acceptable). Who can ref
   * depends on who plays next to whom, so the round's duties are re-picked
   * and the move is kept if the whole season got no worse (or, early on,
   * occasionally even if it did).
   */
  step(current: number, temperature: number): number {
    const { rng } = this
    const ri = Math.floor(rng() * this.rounds.length)
    const r = this.rounds[ri]!
    const G = r.pairs.length
    const before = r.session.slice()
    const a = Math.floor(rng() * G)
    if (rng() < 0.6) {
      const b = Math.floor(rng() * G)
      if (r.session[a] === r.session[b]) return current
      ;[r.session[a], r.session[b]] = [r.session[b]!, r.session[a]!]
    } else {
      const to = Math.floor(rng() * this.sessions)
      if (to === r.session[a]) return current
      r.session[a] = to
      if (!this.allowed(r.session)) {
        r.session = before
        return current
      }
    }
    const prevDuty = r.duty
    this.redoDuties(ri)
    const next = this.cost()
    // Simulated annealing: early on, sometimes accept a worse season to escape dead ends.
    if (next <= current || rng() < Math.exp((current - next) / temperature)) return next
    r.session = before
    this.count(r.duty, -1)
    r.duty = prevDuty
    this.count(r.duty, +1)
    return current
  }
}

// ---------------------------------------------------------------------------
// Court assignment

function permutations(n: number, k: number): number[][] {
  const out: number[][] = []
  const cur: number[] = []
  const used = new Array<boolean>(n).fill(false)
  const rec = () => {
    if (cur.length === k) return void out.push(cur.slice())
    for (let i = 0; i < n; i++) {
      if (used[i]) continue
      used[i] = true
      cur.push(i)
      rec()
      cur.pop()
      used[i] = false
    }
  }
  rec()
  return out
}

/**
 * Choose courts so a duty team refs on the same court it plays on where
 * possible (they just stay on, or arrive early to the court they'll play on).
 */
function assignCourts(r: Round, sessions: number, courts: number): number[] {
  const { pairs, session, duty } = r
  const court = new Array<number>(pairs.length).fill(0)
  const courtOf = new Map<number, number>()
  const sessionOf = new Map<number, number>()
  pairs.forEach((p, g) => p.forEach((t) => sessionOf.set(t, session[g]!)))

  for (let s = 0; s < sessions; s++) {
    const games = pairs.map((_, g) => g).filter((g) => session[g] === s)
    if (games.length === 0) continue
    const perms = courts <= 7 ? permutations(courts, games.length) : [games.map((_, i) => i)]
    let bestPerm = perms[0]!
    let bestScore = -Infinity
    for (const perm of perms) {
      let score = 0
      games.forEach((g, i) => {
        const c = perm[i]!
        // this game's ref played on this court in the session before
        if (sessionOf.get(duty[g]!) === s - 1 && courtOf.get(duty[g]!) === c) score += 10
        // someone in this game reffed this court in the session before
        pairs.forEach((_, h) => {
          if (session[h] === s - 1 && court[h] === c && pairs[g]!.includes(duty[h]!)) score += 10
        })
        score -= c * 0.01 // prefer lower-numbered courts when there's a tie
      })
      if (score > bestScore) {
        bestScore = score
        bestPerm = perm
      }
    }
    games.forEach((g, i) => {
      court[g] = bestPerm[i]!
      pairs[g]!.forEach((t) => courtOf.set(t, bestPerm[i]!))
    })
  }
  return court
}

// ---------------------------------------------------------------------------
// Finals

type PlayingWeek = Omit<Week, 'id' | 'date' | 'matchDay'>

function finalsWeeks(s: Settings): PlayingWeek[] {
  const L = (label: string): Ref => ({ label })
  // No team duty (TVSL): finals have no duty refs either.
  const D = (label: string): Ref | null => (dutyEnabled(s) ? L(label) : null)
  // Back to back on the first court; with only one session, side by side.
  const slot = (i: number) => (s.sessions.length >= 2 ? { session: i, court: 0 } : { session: 0, court: Math.min(i, s.courts.length - 1) })
  return [
    {
      kind: 'semi',
      games: [
        { id: uid('g'), ...slot(0), title: 'Semi Final 1', home: L('2nd'), away: L('3rd'), duty: D('4th') },
        { id: uid('g'), ...slot(1), title: 'Semi Final 2', home: L('1st'), away: L('4th'), duty: D('Loser SF1') },
      ],
    },
    {
      kind: 'final',
      games: [
        { id: uid('g'), ...slot(0), title: 'Grand Final', home: L('Winner SF1'), away: L('Winner SF2'), duty: D('Loser SF1') },
        { id: uid('g'), ...slot(1), title: '3rd Place', home: L('Loser SF1'), away: L('Loser SF2'), duty: D('Loser GF') },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// Dates

/** Weekly dates from the start date, inserting placeholder weeks for skipped dates. */
export function assignDates(s: Settings, playing: (PlayingWeek & { id?: string })[]): Week[] {
  const skip = new Map(s.skipDates.map((d) => [d.date, d.reason]))
  const weeks: Week[] = []
  let date = s.startDate
  let i = 0
  let guard = 0
  while (i < playing.length && guard++ < 520) {
    if (skip.has(date)) {
      weeks.push({ id: uid('w'), kind: 'skip', date, matchDay: 0, games: [], note: skip.get(date) || 'No games' })
    } else {
      weeks.push({ id: uid('w'), ...playing[i]!, date, matchDay: i + 1 })
      i++
    }
    date = addDays(date, 7)
  }
  return weeks
}

// ---------------------------------------------------------------------------

export function generate(s: Settings): Week[] {
  const errors = settingsErrors(s)
  if (errors.length) throw new Error(errors.join(' '))

  const rng = makeRng(s.seed)
  const sessions = s.sessions.length
  const courts = s.courts.length
  const n = s.teams.length
  const duty = dutyEnabled(s)

  const cycle = shuffle(roundRobin(shuffle([...Array(n).keys()], rng)), rng)
  const draw: Pair[][] = []
  for (let c = 0; c < Math.max(1, s.meetings); c++) {
    // Repeat cycles in the same order so rematches are as far apart as
    // possible, swapping home/away each time.
    for (const pairs of cycle) draw.push(pairs.map(([a, b]) => (c % 2 ? [b, a] : [a, b]) as Pair))
  }

  const patterns = sessionPatterns(Math.floor(n / 2), sessions, courts, duty)
  const patternSet = new Set(patterns.map((p) => p.join(',')))

  // Try a few starting points and keep the fairest season.
  let best: Season | null = null
  let bestCost = Infinity
  for (let attempt = 0; attempt < 6; attempt++) {
    const offset = Math.floor(rng() * patterns.length)
    const rounds: Round[] = draw.map((pairs, ri) => {
      const caps = patterns[(ri + offset) % patterns.length]!
      const session = shuffle(
        caps.flatMap((k, si) => new Array<number>(k).fill(si)),
        rng,
      )
      return { pairs, session, duty: [] }
    })
    const season = new Season(rounds, n, sessions, patternSet, rng, duty)
    rounds.forEach((_, ri) => season.redoDuties(ri))
    let cost = season.cost()
    const iterations = 6000
    if (sessions > 1) for (let it = 0; it < iterations; it++) cost = season.step(cost, 30 * (1 - it / iterations) + 0.01)
    // polish duties with a couple of full passes
    for (let pass = 0; pass < 2; pass++) rounds.forEach((_, ri) => season.redoDuties(ri))
    cost = season.cost()
    if (cost < bestCost) {
      bestCost = cost
      best = season
    }
  }

  const ref = (t: number): Ref => ({ team: s.teams[t]!.id })
  const regular: PlayingWeek[] = best!.rounds.map((r) => {
    const court = assignCourts(r, sessions, courts)
    const games: Game[] = r.pairs.map(([a, b], g) => ({
      id: uid('g'),
      session: r.session[g]!,
      court: court[g]!,
      home: ref(a),
      away: ref(b),
      duty: r.duty[g]! >= 0 ? ref(r.duty[g]!) : null,
    }))
    games.sort((x, y) => x.session - y.session || x.court - y.court)
    return { kind: 'regular', games }
  })

  const finals = seasonShape(s).finalsWeeks > 0 ? finalsWeeks(s) : []
  return assignDates(s, [...regular, ...finals])
}
