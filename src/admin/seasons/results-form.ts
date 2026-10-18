import { effectiveResult, hasEntry, sameResult, type Result, type SetScore, type Week } from '../../lib/fixtures'
import type { MatchOutcome } from '../../server/db/schema/enums'

// The results entry form, as plain data: what's typed in each box (strings, so a half-typed score survives), and
// the lib Result it makes. Set by set by default; totals for results recorded without set scores (most imported
// ones), which the organiser can switch between.

export type ResultForm = {
  mode: 'sets' | 'totals'
  /** [home, away] per set. As many rows as the season's sets per match. */
  sets: [string, string][]
  /** Sets won and rally points: [home sets, away sets, home points, away points]. */
  totals: [string, string, string, string]
  /** Decided by hand ('' = from the scores), and why. */
  outcome: '' | MatchOutcome
  note: string
}

const str = (v: number | null | undefined) => (typeof v === 'number' ? String(v) : '')

/** The form for a result, with one row per set the season plays (more if the result already has more). */
export function formFromResult(r: Result | undefined, setsPerMatch: number): ResultForm {
  const sets = r?.sets ?? []
  const rows = Math.max(setsPerMatch, sets.length)
  const scored = !!r && ([r.home, r.away, r.homePoints, r.awayPoints].some((v) => typeof v === 'number') || sets.length > 0)
  return {
    mode: r && sets.length === 0 && scored && hasEntry(r) ? 'totals' : 'sets',
    outcome: r?.outcome ?? '',
    note: r?.outcome ? (r.note ?? '') : '',
    sets: Array.from({ length: rows }, (_, i) => {
      const s = sets[i]
      return s ? [String(s[0]), String(s[1])] : ['', '']
    }),
    totals: [str(r?.home), str(r?.away), str(r?.homePoints), str(r?.awayPoints)],
  }
}

const num = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null)

export type FormResult = { result: Result | undefined; problem: string | null }

/**
 * The Result the form makes (undefined when it's blank), and what's wrong with it if anything. Set mode derives sets
 * won and point totals from the set scores, as the server does.
 */
export function resultFromForm(f: ResultForm): FormResult {
  const scores = scoresFromForm(f)
  if (!f.outcome) return scores
  // Decided by hand: the outcome stands even with no scores, but needs a reason.
  const result: Result = { ...(scores.result ?? { home: null, away: null }), outcome: f.outcome, note: f.note.trim() }
  return { result, problem: scores.problem ?? (f.note.trim() ? null : 'Say why the outcome was decided by hand.') }
}

function scoresFromForm(f: ResultForm): FormResult {
  if (f.mode === 'totals') {
    const [home, away, homePoints, awayPoints] = f.totals.map(num) as [number | null, number | null, number | null, number | null]
    if ([home, away, homePoints, awayPoints].every((v) => v === null)) return { result: undefined, problem: null }
    const problem = f.totals.some((v) => v.trim() !== '' && num(v) === null) ? 'Scores must be whole numbers.' : null
    return { result: { home, away, homePoints, awayPoints }, problem }
  }
  const sets: SetScore[] = []
  let problem: string | null = null
  let gap = -1
  f.sets.forEach(([h, a], i) => {
    const hn = num(h)
    const an = num(a)
    if (h.trim() === '' && a.trim() === '') {
      if (gap < 0) gap = i
      return
    }
    if (gap >= 0 && !problem) problem = `Set ${gap + 1} is blank but set ${i + 1} isn't.`
    if (hn === null || an === null) {
      problem ??= `Set ${i + 1}: enter both teams' points.`
      return
    }
    if (hn > 99 || an > 99) problem ??= `Set ${i + 1}: a set score can't be over 99.`
    sets.push([hn, an])
  })
  if (sets.length === 0) return { result: undefined, problem }
  return { result: effectiveResult({ home: null, away: null, sets }), problem }
}

/** The results that differ between the saved day and the edited one, as PUT …/results wants them (null clears). */
export function changedResults(saved: Week, edited: Week): Record<string, Result | null> {
  const out: Record<string, Result | null> = {}
  for (const g of edited.games) {
    const before = saved.games.find((x) => x.id === g.id)
    if (!sameResult(before?.result, g.result)) out[g.id] = g.result ?? null
  }
  return out
}
