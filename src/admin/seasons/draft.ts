import { DEFAULT_POINTS, dutyEnabled, type Competition, type Settings } from '../../lib/fixtures'
import type { RosterCopySummary, RosterFrom } from '../api'

// Pure helpers for the season editor: what an unsaved working copy is, and which API calls saving it takes
// (docs/api/seasons.md). No DOM, no fetch, so they're unit-tested in Node.

/**
 * The organiser's working copy of a season: the lib's Competition, plus the sets per match the lib doesn't carry.
 * `source: 'csv'` marks a draw that came from a CSV import, so its save is audited as fixtures.import.
 * `rosterFrom`: for teams added in the working copy, where their roster comes from on Save (last time's roster or a
 * team EOI's members; docs/api/rosters.md). Entries for teams that aren't being added are dropped by planSave.
 */
export type Draft = { competition: Competition; setsPerMatch: number; source?: 'csv'; rosterFrom?: Record<string, RosterFrom> }

/** The body for PATCH /seasons/:id (and the `settings` of PUT /draw): every setting except the team list. */
export function settingsBody(s: Settings, setsPerMatch: number) {
  return {
    name: s.name,
    startDate: s.startDate,
    skipDates: s.skipDates,
    courts: s.courts,
    sessions: s.sessions,
    sessionMinutes: s.sessionMinutes,
    meetings: s.meetings,
    includeFinals: s.includeFinals,
    seed: s.seed,
    points: s.points ?? DEFAULT_POINTS,
    duty: dutyEnabled(s),
    setsPerMatch,
    // Ladder rules: only sent once set, so seasons that never chose keep today's defaults.
    ...(s.tieBreaks ? { tieBreaks: s.tieBreaks } : {}),
    ...(s.withdrawn ? { withdrawn: s.withdrawn } : {}),
    ...(s.levelSets ? { levelSets: s.levelSets } : {}),
    ...(s.forfeit ? { forfeit: s.forfeit } : {}),
  }
}
export type SettingsBody = ReturnType<typeof settingsBody>

export type SavePlan = {
  /** PUT /teams first, with these ids in this order (drafts only). */
  teamIds: string[] | null
  /** …and, with it, the rosters the added teams bring (null: none). */
  rosterFrom: Record<string, RosterFrom> | null
  /** PUT /draw with the weeks (and the settings in the same batch). */
  draw: boolean
  /** The settings, if they changed: sent with the draw, else with PATCH. */
  settings: SettingsBody | null
}

const teamIds = (c: Competition) => c.settings.teams.map((t) => t.id)

/**
 * The calls that turn `saved` into `draft`, in order: team list, then draw (with settings) or settings alone. The
 * draw counts as changed when the weeks aren't the saved ones (the editor replaces the array on every edit) or its
 * generatedFrom / edited flags moved.
 */
export function planSave(saved: Draft, draft: Draft): SavePlan {
  const ids = teamIds(draft.competition)
  const body = settingsBody(draft.competition.settings, draft.setsPerMatch)
  const before = settingsBody(saved.competition.settings, saved.setsPerMatch)
  const c = draft.competition
  const s = saved.competition
  const savedIds = new Set(teamIds(s))
  const adding = Object.entries(draft.rosterFrom ?? {}).filter(([t]) => ids.includes(t) && !savedIds.has(t))
  const teamsChanged = ids.join() !== teamIds(s).join()
  return {
    teamIds: teamsChanged ? ids : null,
    rosterFrom: teamsChanged && adding.length ? Object.fromEntries(adding) : null,
    draw: !!c.weeks && (c.weeks !== s.weeks || (c.generatedFrom ?? null) !== (s.generatedFrom ?? null) || c.edited !== s.edited),
    settings: JSON.stringify(body) !== JSON.stringify(before) ? body : null,
  }
}

export const isEmptyPlan = (p: SavePlan) => !p.teamIds && !p.draw && !p.settings

/** " 24 players copied into the new teams' rosters (2 skipped: Sam Lee is in Aces, Jo Park is retired)." */
export function rosterCopyNote(c: RosterCopySummary | undefined): string {
  if (!c || (c.copied === 0 && c.skipped.length === 0)) return ''
  const n = (k: number) => `${k} player${k === 1 ? '' : 's'}`
  const skipped = c.skipped.length
    ? ` (${c.skipped.length} skipped: ${c.skipped
        .slice(0, 4)
        .map((x) => (x.reason === 'retired' ? `${x.name} is retired` : `${x.name} is already in a team`))
        .join(', ')}${c.skipped.length > 4 ? ' …' : ''})`
    : ''
  return ` ${n(c.copied)} copied into the new teams’ rosters${skipped}.`
}

/** The quarter after the newest season, or the current one (Sydney date `today`) for a league with none. */
export function nextQuarter(seasons: { year: number; quarter: number }[], today: string): { year: number; quarter: number } {
  const newest = seasons.toSorted((a, b) => b.year - a.year || b.quarter - a.quarter)[0]
  if (!newest) {
    const [y = '2026', m = '1'] = today.split('-')
    return { year: Number(y), quarter: Math.floor((Number(m) - 1) / 3) + 1 }
  }
  return newest.quarter === 4 ? { year: newest.year + 1, quarter: 1 } : { year: newest.year, quarter: newest.quarter + 1 }
}
