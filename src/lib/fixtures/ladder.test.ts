import { describe, expect, it } from 'vitest'
import { withGenerated } from './competition'
import { demoCompetition } from './demo'
import { publishWeekResults, setResult, undoWeekResultChanges } from './edit'
import { ladderUpdatedLabel, ladderWeek, ladderWeekLabel, lastResultsPublishedAt } from './results'
import type { Week } from './types'

const enterAll = (weeks: Week[], w: Week) =>
  w.games.reduce(
    (ws, g) =>
      setResult(ws, w.id, g.id, {
        home: 2,
        away: 0,
        sets: [
          [25, 20],
          [25, 20],
        ],
      }),
    weeks,
  )

describe('ladder heading', () => {
  // 9 teams: 9 round-robin match days, then semis and finals, like "TNL – Week 4 of 9".
  const c = withGenerated({ ...demoCompetition() })

  it('counts round-robin match days only, and says nothing before any results', () => {
    expect(c.weeks!.filter((w) => w.kind !== 'skip')).toHaveLength(11)
    expect(ladderWeek(c.weeks!)).toEqual({ week: 0, of: 9 })
    expect(ladderWeekLabel(c.weeks!)).toBeNull()
    expect(ladderUpdatedLabel(c.weeks!)).toBeNull()
  })

  it('"Week N of M" follows the last published match day, not entered results', () => {
    let weeks = c.weeks!
    for (const i of [0, 1, 2, 3]) weeks = publishWeekResults(enterAll(weeks, weeks[i]!), weeks[i]!.id)
    expect(ladderWeekLabel(weeks)).toBe('Week 4 of 9')
    weeks = enterAll(weeks, weeks[4]!) // entered, not published
    expect(ladderWeekLabel(weeks)).toBe('Week 4 of 9')
  })

  it('ignores weeks off', () => {
    const s = { ...c.settings, skipDates: [{ date: '2027-02-11', reason: 'Venue closed' }] }
    const weeks = withGenerated({ ...c, settings: s }).weeks!
    expect(weeks[1]!.kind).toBe('skip')
    const published = publishWeekResults(enterAll(weeks, weeks[2]!), weeks[2]!.id)
    expect(ladderWeekLabel(published)).toBe('Week 2 of 9')
  })

  it('"Updated dd/mm/yyyy" is the Sydney date of the last results publish', () => {
    let weeks = c.weeks!
    const [w1, w2] = weeks as [Week, Week]
    // 13:30 UTC on 15 Oct is 00:30 on 16 Oct in Sydney (AEDT)
    weeks = publishWeekResults(enterAll(weeks, w2), w2.id, new Date('2026-10-15T13:30:00Z'))
    weeks = publishWeekResults(enterAll(weeks, w1), w1.id, new Date('2026-10-09T08:00:00Z'))
    expect(lastResultsPublishedAt(weeks)).toBe('2026-10-15T13:30:00.000Z')
    expect(ladderUpdatedLabel(weeks)).toBe('Updated 16/10/2026')
    // undoing unpublished edits doesn't count as a publish
    expect(ladderUpdatedLabel(undoWeekResultChanges(weeks, w1.id))).toBe('Updated 16/10/2026')
  })
})
