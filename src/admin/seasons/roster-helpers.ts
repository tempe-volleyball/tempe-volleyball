import type { Team } from '../../lib/fixtures'
import { matchesSearch, PLAYER_GROUP_LABELS, playerName } from '../../lib/players/groups'
import type { DirectoryPlayer, PreviewPlayer, RosterFrom, RosterSources, SourceTeam, TeamInterest, TeamRoster } from '../api'

// Pure helpers for the season builder's teams and rosters (SeasonTeams.tsx, PlayerPicker.tsx, TeamSources.tsx):
// the picker's tabs, filtering and sorting, "Add all of last season's teams", and what an unsaved team will bring.
// No DOM, no fetch, so they're unit-tested in Node.

// ── The player picker ─────────────────────────────────────────────────────────

export const pickerTabs = ['interest', 'last', 'past', 'retired', 'all'] as const
export type PickerTab = (typeof pickerTabs)[number]
export const PICKER_TAB_LABELS: Record<PickerTab, string> = {
  interest: PLAYER_GROUP_LABELS.interest,
  last: PLAYER_GROUP_LABELS.last,
  past: PLAYER_GROUP_LABELS.past,
  retired: PLAYER_GROUP_LABELS.retired,
  all: 'All',
}

/** Who's in a team this season, from the rosters as they are now (the directory's own inSeason goes stale). */
export type Placed = ReadonlyMap<string, { teamId: string; teamName: string }>
export const placedMap = (rosters: readonly TeamRoster[]): Placed =>
  new Map(rosters.flatMap((t) => t.players.map((p) => [p.playerId, { teamId: t.teamId, teamName: t.teamName }] as const)))

/** All = everyone but the retired (they're "hidden unless asked for": the Retired tab). */
export const inTab = (p: DirectoryPlayer, tab: PickerTab) => (tab === 'all' ? !p.retiredAt : p.group === tab)

export function pickerCounts(players: readonly DirectoryPlayer[]): Record<PickerTab, number> {
  const out: Record<PickerTab, number> = { interest: 0, last: 0, past: 0, retired: 0, all: 0 }
  for (const p of players) for (const t of pickerTabs) if (inTab(p, t)) out[t]++
  return out
}

/** One collator for every comparison (localeCompare with options builds one per call: slow over 3,000 players). */
const collator = new Intl.Collator('en', { sensitivity: 'base' })
const byName = (a: DirectoryPlayer, b: DirectoryPlayer) =>
  collator.compare(a.firstName, b.firstName) || collator.compare(a.lastName, b.lastName) || a.id.localeCompare(b.id)
const spotOf = (p: DirectoryPlayer) => p.lastInLeague ?? p.lastAnywhere

/**
 * The rows a tab shows for a search, in the tab's order: New interest newest EOI first; Last season by team, then
 * name; Past players most recent first; Retired and All by name. Searching (matchesSearch: name, email, phone)
 * keeps the order.
 */
export function pickerRows(players: readonly DirectoryPlayer[], tab: PickerTab, query: string): DirectoryPlayer[] {
  const rows = players.filter((p) => inTab(p, tab) && matchesSearch(p, query))
  if (tab === 'interest')
    return rows.toSorted((a, b) => (b.interest?.createdAt ?? '').localeCompare(a.interest?.createdAt ?? '') || byName(a, b))
  if (tab === 'last')
    return rows.toSorted((a, b) => collator.compare(a.lastInLeague?.teamName ?? '', b.lastInLeague?.teamName ?? '') || byName(a, b))
  if (tab === 'past') return rows.toSorted((a, b) => (spotOf(b)?.startDate ?? '').localeCompare(spotOf(a)?.startDate ?? '') || byName(a, b))
  return rows.toSorted(byName)
}

/** Retired players a search in the All tab would have found, for "2 retired players match: see Retired". */
export const retiredMatching = (players: readonly DirectoryPlayer[], query: string) =>
  query.trim() ? players.filter((p) => p.retiredAt && matchesSearch(p, query)).length : 0

/** The active row after a key press in the list (arrows, Home, End, Page Up/Down), clamped; -1 when it's empty. */
export function moveActive(current: number, key: string, length: number, page = 10): number {
  if (length === 0) return -1
  const next =
    key === 'ArrowDown'
      ? current + 1
      : key === 'ArrowUp'
        ? current - 1
        : key === 'Home'
          ? 0
          : key === 'End'
            ? length - 1
            : key === 'PageDown'
              ? current + page
              : key === 'PageUp'
                ? current - page
                : current
  return Math.min(length - 1, Math.max(0, next))
}

/** "Beginner", "Middle hitter": an EOI answer's stored value as words. */
export function answerLabel(v: string | null | undefined): string | null {
  if (!v) return null
  const words = v.replace(/[_-]+/g, ' ').trim()
  if (words === 'middle') return 'Middle hitter'
  if (words === 'outside') return 'Outside hitter'
  return words ? words[0]!.toUpperCase() + words.slice(1) : null
}

export const GENDER_SHORT: Record<string, string> = { female: 'F', male: 'M', non_binary: 'NB', prefer_not_to_say: '–' }

/** "Aces · TNL Q3 2026": where a player last played (this league first). */
export function lastPlayed(p: DirectoryPlayer): string | null {
  const s = spotOf(p)
  return s ? `${s.teamName} · ${s.seasonName}` : null
}

export { playerName }

// ── Teams ─────────────────────────────────────────────────────────────────────

/** "Add all of last season's teams": who it adds (not withdrawn, not already in), and who it leaves out and why. */
export function lastSeasonPlan(sources: RosterSources | null, inSeason: ReadonlySet<string>) {
  const last = (sources?.teams ?? []).filter((t) => t.group === 'last')
  return {
    season: sources?.lastSeason ?? null,
    add: last.filter((t) => !t.from.withdrawn && !inSeason.has(t.teamId)),
    withdrawn: last.filter((t) => t.from.withdrawn && !inSeason.has(t.teamId)),
    already: last.filter((t) => inSeason.has(t.teamId)),
  }
}

/** Teams added to the working copy (and their rosterFrom), appended in order, skipping any already in. */
export function addTeams(
  teams: readonly Team[],
  rosterFrom: Readonly<Record<string, RosterFrom>> | undefined,
  add: readonly { team: Team; from: RosterFrom | null }[],
): { teams: Team[]; rosterFrom: Record<string, RosterFrom> } {
  const ids = new Set(teams.map((t) => t.id))
  const out = [...teams]
  const from = { ...rosterFrom }
  for (const a of add) {
    if (ids.has(a.team.id)) continue
    ids.add(a.team.id)
    out.push(a.team)
    if (a.from) from[a.team.id] = a.from
    else delete from[a.team.id]
  }
  return { teams: out, rosterFrom: from }
}

/** The roster an unsaved team will bring on Save, from its rosterFrom and the sources. */
export function pendingRoster(
  teamId: string,
  from: RosterFrom | undefined,
  sources: RosterSources | null,
): { label: string; players: PreviewPlayer[] } | null {
  if (!from || !sources) return null
  if ('seasonId' in from) {
    const t: SourceTeam | undefined = sources.teams.find((x) => x.teamId === teamId && x.from.seasonId === from.seasonId)
    return t ? { label: `Copied from ${t.from.seasonName}`, players: t.players } : { label: 'Copied from an earlier season', players: [] }
  }
  const e: TeamInterest | undefined = sources.interests.find((x) => x.interestId === from.interestId)
  return e ? { label: `From ${e.reference} (team EOI)`, players: e.members } : { label: 'From a team EOI', players: [] }
}

/** Case-insensitive, accent-insensitive team search ("ice" finds "Ice Cold"). */
export const teamMatches = (name: string, q: string) => matchesSearch({ firstName: name, lastName: '' }, q)
