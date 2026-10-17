import { describe, expect, it } from 'vitest'
import { demoCompetition, moveGame, withGenerated, withSettings } from '../../lib/fixtures'
import { isEmptyPlan, nextQuarter, planSave, settingsBody, type Draft } from './draft'

const saved = (): Draft => ({ competition: withGenerated(demoCompetition()), setsPerMatch: 2 })

describe('planSave', () => {
  it('has nothing to do for an unchanged copy', () => {
    const d = saved()
    expect(isEmptyPlan(planSave(d, { ...d }))).toBe(true)
  })

  it('sends settings alone when only a setting changed', () => {
    const d = saved()
    const next: Draft = { ...d, competition: { ...d.competition, settings: { ...d.competition.settings, name: 'TNL Q1 2027' } } }
    const plan = planSave(d, next)
    expect(plan).toMatchObject({ teamIds: null, draw: false })
    expect(plan.settings).toEqual(settingsBody(next.competition.settings, 2))
    expect(plan.settings).not.toHaveProperty('teams')
  })

  it('sends sets per match as a setting', () => {
    const d = saved()
    expect(planSave(d, { ...d, setsPerMatch: 5 }).settings?.setsPerMatch).toBe(5)
  })

  it('sends the draw after a hand edit, and the team list when teams changed', () => {
    const d = saved()
    const w = d.competition.weeks![0]!
    const g = w.games[0]!
    const moved = moveGame(d.competition.weeks!, { weekId: w.id, gameId: g.id }, { weekId: w.id, session: 1, court: 1 })
    expect(planSave(d, { ...d, competition: { ...d.competition, weeks: moved, edited: true } })).toMatchObject({
      teamIds: null,
      draw: true,
      settings: null,
    })

    const teams = d.competition.settings.teams.slice(1)
    const fewer: Draft = { ...d, competition: { ...d.competition, settings: { ...d.competition.settings, teams } } }
    expect(planSave(d, fewer)).toMatchObject({ teamIds: teams.map((t) => t.id), draw: false, settings: null })
  })

  it('a new start date re-lays the weeks, so the draw and settings go together', () => {
    const d = saved()
    const next = withSettings(d.competition, { ...d.competition.settings, startDate: '2027-02-11' })
    const plan = planSave(d, { ...d, competition: next })
    expect(plan.draw).toBe(true)
    expect(plan.settings?.startDate).toBe('2027-02-11')
  })

  it('never sends a draw for a season without one', () => {
    const d: Draft = { competition: demoCompetition(), setsPerMatch: 2 }
    expect(planSave(d, { ...d, competition: { ...d.competition, edited: true } }).draw).toBe(false)
  })
})

describe('nextQuarter', () => {
  it('follows the newest season, rolling over the year', () => {
    expect(
      nextQuarter(
        [
          { year: 2026, quarter: 3 },
          { year: 2026, quarter: 4 },
        ],
        '2026-10-18',
      ),
    ).toEqual({ year: 2027, quarter: 1 })
    expect(nextQuarter([{ year: 2027, quarter: 1 }], '2026-10-18')).toEqual({ year: 2027, quarter: 2 })
  })

  it('uses the current quarter for a league with no seasons', () => {
    expect(nextQuarter([], '2026-10-18')).toEqual({ year: 2026, quarter: 4 })
    expect(nextQuarter([], '2027-03-31')).toEqual({ year: 2027, quarter: 1 })
  })
})
