import { describe, expect, it } from 'vitest'
import { byesForWeek, validate } from './analysis'
import { withGenerated } from './competition'
import { demoCompetition } from './demo'
import { publishWeekResults, setResult } from './edit'
import { movedAway, moveToNight } from './move'
import {
  completeResult,
  forfeitResult,
  forfeitRule,
  forfeitRuleProblem,
  forfeitScoreText,
  ladderWeek,
  makeResolver,
  outcome,
  publishProblem,
  sameResult,
  standings,
} from './results'
import { dayPublishProblem } from './status'
import { isTeam, type Game, type Ref, type Result, type Settings, type Week } from './types'

const generated = () => withGenerated(demoCompetition())
const teamOf = (ref: Ref) => (isTeam(ref) ? ref.team : '')
const sets = (...s: [number, number][]): Result => ({ home: null, away: null, sets: s })

/** Publish `result` for the first game of the first night; the rest of the night is left unplayed. */
function publishOne(s: Settings, weeks: Week[], result: Result, status?: Game['status']) {
  const w = weeks[0]!
  const g = w.games[0]!
  const withStatus = status
    ? weeks.map((x) => (x.id !== w.id ? x : { ...x, games: x.games.map((y) => (y.id === g.id ? { ...y, status } : y)) }))
    : weeks
  const next = publishWeekResults(setResult(withStatus, w.id, g.id, result), w.id)
  const table = standings(s, next)
  return { g, row: (ref: Ref) => table.find((t) => t.teamId === teamOf(ref))! }
}

describe('deciding the outcome by hand', () => {
  it('beats the scores, and counts with no scores at all', () => {
    const c = generated()
    const { g, row } = publishOne(c.settings, c.weeks!, { home: null, away: null, outcome: 'away', note: 'Walkover' })
    expect(row(g.away)).toMatchObject({ won: 1, points: 3, setsFor: 0, pointsFor: 0 })
    expect(row(g.home)).toMatchObject({ lost: 1, points: 1, played: 1 })
    expect(completeResult({ home: null, away: null, outcome: 'draw', note: 'x' })).toEqual({
      home: 0,
      away: 0,
      homePoints: 0,
      awayPoints: 0,
    })
  })

  it('wins even against the sets, which still count for S+ and S−', () => {
    const c = generated()
    const { g, row } = publishOne(c.settings, c.weeks!, { ...sets([25, 10], [25, 12]), outcome: 'away', note: 'Ineligible player' })
    expect(outcome({ ...sets([25, 10], [25, 12]), outcome: 'away' })).toBe('away')
    expect(row(g.away)).toMatchObject({ won: 1, setsFor: 0, setsAgainst: 2 })
    expect(row(g.home)).toMatchObject({ lost: 1, setsFor: 2 })
  })

  it('needs a reason before the match day publishes, and a change of outcome is a change', () => {
    const c = generated()
    const w = c.weeks![0]!
    const weeks = w.games.reduce((ws, g) => setResult(ws, w.id, g.id, { ...sets([25, 20], [25, 20]) }), c.weeks!)
    expect(publishProblem(weeks[0]!)).toBeNull()
    const noReason = setResult(weeks, w.id, w.games[0]!.id, { ...sets([25, 20], [25, 20]), outcome: 'away' })
    expect(publishProblem(noReason[0]!)).toMatch(/say why its outcome was decided by hand/)
    expect(sameResult(sets([25, 20]), { ...sets([25, 20]), outcome: 'home' })).toBe(false)
    expect(sameResult({ ...sets([25, 20]), outcome: 'home', note: 'a' }, { ...sets([25, 20]), outcome: 'home', note: 'b' })).toBe(false)
  })
})

describe('the 1–1 rule', () => {
  const oneAll = { ...sets([25, 20], [18, 25]) } // 43–45 on points

  it('is a draw by default, and decided on points with levelSets: points', () => {
    expect(outcome(oneAll)).toBe('draw')
    expect(outcome(oneAll, 'points')).toBe('away')
    expect(outcome(sets([25, 20], [20, 25]), 'points')).toBe('draw')
    const c = generated()
    const drawn = publishOne(c.settings, c.weeks!, oneAll)
    expect(drawn.row(drawn.g.home)).toMatchObject({ drawn: 1, points: 2 })
    const decided = publishOne({ ...c.settings, levelSets: 'points' }, c.weeks!, oneAll)
    expect(decided.row(decided.g.away)).toMatchObject({ won: 1, points: 3, setsFor: 1, setsAgainst: 1 })
    expect(decided.row(decided.g.home)).toMatchObject({ lost: 1, points: 1 })
  })

  it('lets a finals game level on sets publish when it’s decided on points', () => {
    const c = generated()
    const semi = c.weeks!.find((w) => w.kind === 'semi')!
    const weeks = semi.games.reduce((ws, g) => setResult(ws, semi.id, g.id, oneAll), c.weeks!)
    const day = weeks.find((w) => w.id === semi.id)!
    expect(publishProblem(day)).toMatch(/is a draw, but finals need a winner/)
    expect(publishProblem(day, 'points')).toBeNull()
    expect(dayPublishProblem(day, new Set(), 'points')).toBeNull()
  })

  it('resolves finals placeholders with the season’s rule', () => {
    const c = generated()
    const done = c.weeks!.map((w) =>
      w.kind !== 'regular' ? w : { ...w, games: w.games.map((g) => ({ ...g, publishedResult: { ...sets([25, 20], [25, 20]) } })) },
    )
    const semi = done.find((w) => w.kind === 'semi')!
    const sf1 = semi.games.find((g) => g.title === 'Semi Final 1')!
    const weeks = done.map((w) =>
      w.id !== semi.id ? w : { ...w, games: w.games.map((g) => (g.id === sf1.id ? { ...g, publishedResult: oneAll } : g)) },
    )
    expect(makeResolver(c.settings, weeks)({ label: 'Winner SF1' })).toEqual({ label: 'Winner SF1' })
    const resolve = makeResolver({ ...c.settings, levelSets: 'points' }, weeks)
    expect(resolve({ label: 'Winner SF1' })).toEqual(resolve(sf1.away))
  })
})

describe('forfeits', () => {
  it('defaults to what SportsPress recorded: every set needed 25–0, loss points kept', () => {
    expect(forfeitRule({}, 2)).toEqual({ winnerSets: 2, loserSets: 0, winnerSetPoints: 25, loserSetPoints: 0, lossPoints: true })
    expect(forfeitRule({}, 5).winnerSets).toBe(3)
    expect(forfeitResult(forfeitRule({}, 2), 'home')).toEqual({
      home: 0,
      away: 2,
      homePoints: 0,
      awayPoints: 50,
      sets: [
        [0, 25],
        [0, 25],
      ],
      outcome: 'away',
      note: 'Forfeit',
    })
    expect(forfeitScoreText(forfeitRule({}, 5))).toBe('3–0 (25–0, 25–0, 25–0)')
  })

  it('can record sets only, and give the forfeiting team a set', () => {
    const f = { winnerSets: 2, loserSets: 0, winnerSetPoints: 0, loserSetPoints: 0, lossPoints: true }
    expect(forfeitResult(f, 'away')).toEqual({ home: 2, away: 0, homePoints: 0, awayPoints: 0, outcome: 'home', note: 'Forfeit' })
    const tvsl = { winnerSets: 3, loserSets: 1, winnerSetPoints: 25, loserSetPoints: 0, lossPoints: true }
    expect(forfeitResult(tvsl, 'away')).toMatchObject({ home: 3, away: 1, homePoints: 75, awayPoints: 25 })
    expect(forfeitRuleProblem(tvsl, 5)).toBeNull()
    expect(forfeitRuleProblem(tvsl, 2)).toMatch(/more than 2 sets/)
    expect(forfeitRuleProblem({ ...tvsl, loserSets: 3 }, 5)).toMatch(/more sets/)
  })

  it('takes the loss points off the forfeiting team when the season says so', () => {
    const c = generated()
    const score = forfeitResult(forfeitRule({}, 2), 'home')
    const kept = publishOne(c.settings, c.weeks!, score, 'forfeit')
    expect(kept.row(kept.g.home)).toMatchObject({ lost: 1, points: 1 })
    const none = { ...c.settings, forfeit: { ...forfeitRule({}, 2), lossPoints: false } }
    const taken = publishOne(none, c.weeks!, score, 'forfeit')
    expect(taken.row(taken.g.home)).toMatchObject({ lost: 1, points: 0 })
    expect(taken.row(taken.g.away)).toMatchObject({ won: 1, points: 3 })
    // An ordinary loss still gets its point.
    const plain = publishOne(none, c.weeks!, score)
    expect(plain.row(plain.g.home).points).toBe(1)
  })
})

describe('moving one game to another night', () => {
  const setup = () => {
    const c = generated()
    const weeks = c.weeks!
    const from = weeks[0]!
    const g = from.games[0]!
    return { s: c.settings, weeks, from, g }
  }

  it('moves to a new catch-up night, keeping the game, and remembers where it was', () => {
    const { s, weeks, from, g } = setup()
    const postponed = weeks.map((w) =>
      w.id !== from.id
        ? w
        : { ...w, games: w.games.map((x) => (x.id === g.id ? { ...x, status: 'postponed' as const, statusNote: 'Rain' } : x)) },
    )
    const last = weeks.at(-1)!.date
    const r = moveToNight(s, postponed, g.id, { date: '2099-01-01', newWeekId: 'catchup', session: 0, position: 0 })
    expect(r.problem).toBeNull()
    const plan = r.plan!
    expect(plan.created).toBe(true)
    expect(plan.to).toMatchObject({ id: 'catchup', kind: 'regular', matchDay: from.matchDay })
    expect(plan.game).toMatchObject({ id: g.id, originalWeekId: from.id, home: g.home, away: g.away })
    expect(plan.game.status).toBeUndefined()
    expect(plan.weeks.at(-1)!.id).toBe('catchup')
    expect(plan.weeks.at(-2)!.date).toBe(last)
    expect(movedAway(plan.weeks, from.id).map((m) => m.to.id)).toEqual(['catchup'])
    // Byes: the moved game's teams aren't on a bye on their own night, and the catch-up night has none.
    expect(byesForWeek(s, plan.from, plan.weeks)).toEqual(byesForWeek(s, from, weeks))
    expect(byesForWeek(s, plan.to, plan.weeks)).toEqual([])
    // The ladder heading still counts match days, not nights.
    expect(ladderWeek(plan.weeks)?.of).toBe(ladderWeek(weeks)?.of)
    // Moving it back home forgets the original night.
    const back = moveToNight(s, plan.weeks, g.id, { weekId: from.id, session: g.session, position: g.court })
    expect(back.plan?.game.originalWeekId).toBeUndefined()
  })

  it('refuses a taken slot, a team playing at that time, published results and weeks off', () => {
    const { s, weeks, g } = setup()
    const other = weeks[1]!
    const taken = other.games[0]!
    expect(moveToNight(s, weeks, g.id, { weekId: other.id, session: taken.session, position: taken.court }).problem).toMatch(
      /slot is taken/,
    )
    // A free slot in a session where one of the teams already plays.
    const team = teamOf(g.home)
    const theirs = other.games.find((x) => teamOf(x.home) === team || teamOf(x.away) === team)!
    // Free a slot in that session (every slot is used in the demo) by taking out another game.
    const spare = other.games.find((x) => x.session === theirs.session && x.id !== theirs.id)!
    const freed = weeks.map((w) => (w.id !== other.id ? w : { ...w, games: w.games.filter((x) => x.id !== spare.id) }))
    expect(moveToNight(s, freed, g.id, { weekId: other.id, session: spare.session, position: spare.court }).problem).toMatch(
      /already plays at/,
    )
    const published = weeks.map((w, i) =>
      i !== 0 ? w : { ...w, games: w.games.map((x) => (x.id === g.id ? { ...x, publishedResult: sets([25, 1], [25, 1]) } : x)) },
    )
    expect(moveToNight(s, published, g.id, { date: '2099-01-01', newWeekId: 'n', session: 0, position: 0 }).problem).toMatch(
      /published result/,
    )
    const withSkip: Week[] = [...weeks, { id: 'off', kind: 'skip', date: '2099-02-02', matchDay: 0, games: [], note: 'Holiday' }]
    expect(moveToNight(s, withSkip, g.id, { date: '2099-02-02', newWeekId: 'n', session: 0, position: 0 }).problem).toMatch(/week off/)
    expect(moveToNight(s, weeks, g.id, { date: '2099-01-01', newWeekId: 'n', session: 9, position: 0 }).problem).toMatch(/session/)
  })

  it('allows a double header on another night, with a warning, and validate() agrees', () => {
    const { s: withDuty, weeks: full, g } = setup()
    const s = { ...withDuty, duty: false }
    const team = teamOf(g.home)
    const theirs = full[1]!.games.find((x) => teamOf(x.home) === team || teamOf(x.away) === team)!
    // Free a slot in the other session that night (every slot is used in the demo).
    const spare = full[1]!.games.find((x) => x.session !== theirs.session)!
    const weeks = full.map((w, i) => (i !== 1 ? w : { ...w, games: w.games.filter((x) => x.id !== spare.id) }))
    const other = weeks[1]!
    // Find a free slot in another session that doesn't clash with either team or the duty team.
    let result: ReturnType<typeof moveToNight> | null = null
    for (let session = 0; session < s.sessions.length && !result?.plan; session++)
      for (let position = 0; position < s.courts.length && !result?.plan; position++)
        if (session !== theirs.session) result = moveToNight(s, weeks, g.id, { weekId: other.id, session, position })
    expect(result?.plan).toBeTruthy()
    expect(result!.plan!.warnings.join(' ')).toMatch(/double header/)
    const issues = validate(s, result!.plan!.weeks).filter((i) => i.weekId === other.id)
    expect(issues.some((i) => i.level === 'error' && /playing 2 games/.test(i.message))).toBe(false)
    expect(issues.some((i) => i.level === 'warning' && /plays twice/.test(i.message))).toBe(true)
  })
})
