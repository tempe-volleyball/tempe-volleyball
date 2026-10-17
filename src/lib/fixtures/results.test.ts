import { describe, expect, it } from 'vitest'
import { withGenerated } from './competition'
import { publishWeekResults, setResult, undoWeekResultChanges } from './edit'
import { fullCsv, publicRows } from './export'
import { isFinished, makeResolver, progress, publishProblem, standings, weekResultsState } from './results'
import { demoCompetition } from './demo'
import { isTeam, type Game, type Ref, type Result, type Week } from './types'

const generated = () => withGenerated(demoCompetition())

/** Sets plus some made-up rally points. */
const r = (home: number, away: number, homePoints = 25 * home + 20 * away, awayPoints = 25 * away + 20 * home): Result => ({
  home,
  away,
  homePoints,
  awayPoints,
})

/** Enter and publish a result for every round-robin game: home wins 2-0. */
function playRoundRobin(weeks: Week[]): Week[] {
  return weeks.map((w) =>
    w.kind !== 'regular' ? w : { ...w, games: w.games.map((g) => ({ ...g, result: r(2, 0), publishedResult: r(2, 0) })) },
  )
}

const teamOf = (ref: Ref) => (isTeam(ref) ? ref.team : '')

describe('publishing a match day', () => {
  it('the ladder only changes once the match day is published', () => {
    const c = generated()
    const w = c.weeks![0]!
    let weeks = w.games.reduce((ws, g) => setResult(ws, w.id, g.id, r(2, 1)), c.weeks!)
    expect(weekResultsState(weeks[0]!)).toBe('ready')
    expect(standings(c.settings, weeks).every((t) => t.played === 0)).toBe(true)

    weeks = publishWeekResults(weeks, w.id)
    expect(weekResultsState(weeks[0]!)).toBe('published')
    expect(standings(c.settings, weeks).filter((t) => t.played === 1)).toHaveLength(8)
  })

  it('needs every game entered, with points, before it can be published', () => {
    const c = generated()
    const w = c.weeks![0]!
    let weeks = setResult(c.weeks!, w.id, w.games[0]!.id, r(2, 0))
    expect(weekResultsState(weeks[0]!)).toBe('entering')
    expect(publishProblem(weeks[0]!)).toBe('Enter sets and points for the 3 remaining games to publish.')
    weeks = w.games.slice(1).reduce((ws, g) => setResult(ws, w.id, g.id, { home: 2, away: 0, homePoints: 50, awayPoints: null }), weeks)
    expect(publishProblem(weeks[0]!)).toMatch(/3 remaining games/)
  })

  it('edits to a published match day stay off the ladder until republished, and can be undone', () => {
    const c = generated()
    const w = c.weeks![0]!
    const g = w.games[0]!
    let weeks = publishWeekResults(
      w.games.reduce((ws, x) => setResult(ws, w.id, x.id, r(2, 0)), c.weeks!),
      w.id,
    )
    const winner = () => standings(c.settings, weeks).find((t) => t.teamId === teamOf(g.home))!

    weeks = setResult(weeks, w.id, g.id, r(0, 2))
    expect(weekResultsState(weeks[0]!)).toBe('changed')
    expect(winner().won).toBe(1)

    expect(weekResultsState(undoWeekResultChanges(weeks, w.id)[0]!)).toBe('published')

    weeks = publishWeekResults(weeks, w.id)
    expect(winner().lost).toBe(1)
  })

  it('a drawn finals game can’t be published', () => {
    const c = generated()
    const weeks = playRoundRobin(c.weeks!)
    const semi = weeks.find((w) => w.kind === 'semi')!
    const entered = setResult(setResult(weeks, semi.id, semi.games[0]!.id, r(1, 1)), semi.id, semi.games[1]!.id, r(2, 0))
    expect(publishProblem(entered.find((w) => w.id === semi.id)!)).toBe('Semi Final 1 is a draw, but finals need a winner.')
  })

  it('the season is finished once every match day is published', () => {
    const c = generated()
    let weeks = playRoundRobin(c.weeks!)
    expect(isFinished(weeks)).toBe(false)
    for (const w of weeks.filter((x) => x.kind === 'semi' || x.kind === 'final'))
      weeks = publishWeekResults(
        w.games.reduce((ws, g) => setResult(ws, w.id, g.id, r(2, 1)), weeks),
        w.id,
      )
    expect(isFinished(weeks)).toBe(true)
  })
})

describe('ladder', () => {
  it('3 for a win, 2 for a draw, 1 for a loss, with sets and points both ways', () => {
    const c = generated()
    const w = c.weeks![0]!
    const [a, b] = w.games as [Game, Game]
    let weeks = setResult(c.weeks!, w.id, a.id, r(2, 1, 60, 51))
    weeks = setResult(weeks, w.id, b.id, r(1, 1, 45, 44))
    weeks = publishWeekResults(weeks, w.id)
    const table = standings(c.settings, weeks)
    const row = (ref: Ref) => table.find((t) => t.teamId === teamOf(ref))!
    expect(row(a.home)).toMatchObject({ won: 1, points: 3, setsFor: 2, setsAgainst: 1, pointsFor: 60, pointsAgainst: 51 })
    expect(row(a.away)).toMatchObject({ lost: 1, points: 1, setsFor: 1, setsAgainst: 2, pointsFor: 51, pointsAgainst: 60 })
    expect(row(b.home)).toMatchObject({ drawn: 1, points: 2, pointsFor: 45 })
    expect(table[0]!.teamId).toBe(teamOf(a.home))
  })

  it('breaks ties on set difference, then points difference', () => {
    const c = generated()
    const w = c.weeks![0]!
    const [a, b] = w.games as [Game, Game]
    let weeks = setResult(c.weeks!, w.id, a.id, r(2, 0, 50, 49))
    weeks = setResult(weeks, w.id, b.id, r(2, 0, 50, 30))
    weeks = publishWeekResults(weeks, w.id)
    expect(
      standings(c.settings, weeks)
        .slice(0, 2)
        .map((t) => t.teamId),
    ).toEqual([teamOf(b.home), teamOf(a.home)])
  })

  it('uses the season points when set', () => {
    const c = generated()
    const w = c.weeks![0]!
    const weeks = publishWeekResults(setResult(c.weeks!, w.id, w.games[0]!.id, r(0, 2)), w.id)
    expect(standings({ ...c.settings, points: { win: 2, draw: 1, loss: 0 } }, weeks)[0]!).toMatchObject({ won: 1, points: 2 })
  })
})

describe('finals fill themselves in from published results', () => {
  it('keeps placeholders until every round-robin result is published', () => {
    const c = generated()
    const weeks = playRoundRobin(c.weeks!)
    const last = weeks.filter((w) => w.kind === 'regular').at(-1)!
    const unpublished = weeks.map((w) =>
      w.id !== last.id ? w : { ...w, games: w.games.map((g, i) => (i ? g : { ...g, publishedResult: undefined })) },
    )
    expect(makeResolver(c.settings, unpublished)({ label: '1st' })).toEqual({ label: '1st' })
    expect(progress(unpublished).regular.done).toBe(progress(weeks).regular.done - 1)
  })

  it('seeds the semis from the ladder, then the final from the semis', () => {
    const c = generated()
    let weeks = playRoundRobin(c.weeks!)
    const table = standings(c.settings, weeks)
    let resolve = makeResolver(c.settings, weeks)
    expect(resolve({ label: '1st' })).toEqual({ team: table[0]!.teamId })
    expect(resolve({ label: '4th' })).toEqual({ team: table[3]!.teamId })

    // SF1 is 2nd v 3rd: 3rd wins. SF2 is 1st v 4th: 1st wins.
    const semi = weeks.find((w) => w.kind === 'semi')!
    weeks = setResult(weeks, semi.id, semi.games[0]!.id, r(1, 2))
    weeks = setResult(weeks, semi.id, semi.games[1]!.id, r(2, 0))
    expect(makeResolver(c.settings, weeks)({ label: 'Winner SF1' })).toEqual({ label: 'Winner SF1' }) // not published yet
    weeks = publishWeekResults(weeks, semi.id)
    resolve = makeResolver(c.settings, weeks)
    expect(resolve({ label: 'Winner SF1' })).toEqual({ team: table[2]!.teamId })
    expect(resolve({ label: 'Loser SF1' })).toEqual({ team: table[1]!.teamId })
    expect(resolve({ label: 'Winner SF2' })).toEqual({ team: table[0]!.teamId })

    const final = weeks.find((w) => w.kind === 'final')!
    weeks = setResult(weeks, final.id, final.games[0]!.id, r(2, 1))
    weeks = setResult(weeks, final.id, final.games[1]!.id, r(2, 0))
    weeks = publishWeekResults(weeks, final.id)
    expect(makeResolver(c.settings, weeks)({ label: 'Loser GF' })).toEqual({ team: table[0]!.teamId })

    const name = (id: string) => c.settings.teams.find((t) => t.id === id)!.name.toUpperCase()
    expect(publicRows(c.settings, weeks).find((x) => x.match.startsWith('GRAND FINAL'))).toMatchObject({
      match: `GRAND FINAL - ${name(table[2]!.teamId)} vs ${name(table[0]!.teamId)}`,
      result: '2 - 1',
    })
  })
})

describe('exports use published results only', () => {
  it('full CSV has sets and points, once published', () => {
    const c = generated()
    const w = c.weeks![0]!
    let weeks = setResult(c.weeks!, w.id, w.games[0]!.id, r(2, 1, 61, 55))
    expect(fullCsv(c.settings, weeks).split('\r\n')[1]!).toMatch(/,,$/) // entered, not published
    weeks = publishWeekResults(weeks, w.id)
    const [header, first] = fullCsv(c.settings, weeks).split('\r\n')
    expect(header).toMatch(/,Sets,Points$/)
    expect(first).toMatch(/,2 - 1,61 - 55$/)
  })

  it('names the finals teams once they are known', () => {
    const c = generated()
    const semi = (weeks: Week[]) =>
      fullCsv(c.settings, weeks)
        .split('\r\n')
        .find((l) => l.includes('Semi Final 1'))!
    expect(semi(c.weeks!)).toContain('(2ND),(3RD)')
    const weeks = playRoundRobin(c.weeks!)
    const table = standings(c.settings, weeks)
    const name = (i: number) => c.settings.teams.find((t) => t.id === table[i]!.teamId)!.name
    expect(semi(weeks)).toContain(`${name(1)},${name(2)}`)
  })
})
