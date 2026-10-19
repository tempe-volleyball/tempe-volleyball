import { and, eq, inArray } from 'drizzle-orm'
import { splitFixtures } from '../../lib/fixture-lists'
import { runBatch, type AppDb } from '../db'
import { seasons, seasonTeams, teams, type Team } from '../db/schema'
import type { Site, LeagueSeason } from '../site'
import { seasonView } from '../site'
import { fixtureRows, type FixtureRow, type LadderRow } from './adapter'
import { assembleSeasons, baseQueries, seasonQueries, type SeasonRows } from './load'

// A team's public page, /teams/<slug> (docs/public-site.md "Team pages"): its current seasons (ladder position,
// fixtures, results) and the seasons it played before (final position). Only published and archived seasons count:
// a team that is only in a draft season has no page, so next season's line-up isn't shown early. Player names are
// never shown (rosters are admin-only). Past seasons load in one batch, whatever their number.

export type TeamCurrent = {
  view: LeagueSeason
  /** The team's ladder row, or null if it isn't on the ladder (withdrawn and hidden). */
  row: LadderRow | null
  teamsOnLadder: number
  upcoming: FixtureRow[]
  played: FixtureRow[]
}

export type TeamPastSeason = {
  seasonId: string
  seasonName: string
  seasonSlug: string
  leagueName: string
  leagueCode: string
  leagueSlug: string
  startDate: string
  position: number | null
  teamsOnLadder: number
  points: number | null
  withdrawn: boolean
}

export type TeamPage = { team: Pick<Team, 'id' | 'name' | 'slug'>; current: TeamCurrent[]; past: TeamPastSeason[] }

/** The rows of a season's fixtures that involve the team: its games, its duties, its byes, and nights off. */
export const teamRows = (rows: readonly FixtureRow[], teamId: string) =>
  rows.filter((r) => r.kind === 'skip' || r.teamIds.home === teamId || r.teamIds.away === teamId || r.teamIds.duty === teamId)

export async function loadTeamPage(db: AppDb, site: Site, slug: string, today: string): Promise<TeamPage | null> {
  const team = await db.select({ id: teams.id, name: teams.name, slug: teams.slug }).from(teams).where(eq(teams.slug, slug)).get()
  if (!team) return null
  const played = await db
    .select({ seasonId: seasonTeams.seasonId })
    .from(seasonTeams)
    .innerJoin(seasons, eq(seasons.id, seasonTeams.seasonId))
    .where(and(eq(seasonTeams.teamId, team.id), inArray(seasons.status, ['published', 'archived'])))
  const ids = new Set(played.map((p) => p.seasonId))
  if (ids.size === 0) return null

  const current: TeamCurrent[] = site.current
    .filter((c) => ids.has(c.summary.id))
    .map((view) => {
      const rows = teamRows(fixtureRows(view.competition, view.data.matches), team.id)
      const split = splitFixtures(rows, view.competition.weeks, today)
      return {
        view,
        row: view.ladder.find((r) => r.teamId === team.id) ?? null,
        teamsOnLadder: view.ladder.length,
        upcoming: split.upcoming,
        played: split.played,
      }
    })

  const currentIds = new Set(current.map((c) => c.view.summary.id))
  const pastIds = [...ids].filter((id) => !currentIds.has(id))
  const past: TeamPastSeason[] = []
  if (pastIds.length > 0) {
    const [, courtQ] = baseQueries(db)
    const res = await runBatch(db, [courtQ, ...seasonQueries(db, { ids: pastIds })])
    const [courtRows, ...rows] = res as unknown as [Awaited<typeof courtQ>, ...SeasonRows]
    const loaded = assembleSeasons(rows as unknown as SeasonRows, site.leagues, courtRows)
    for (const id of pastIds) {
      const data = loaded.get(id)
      const summary = site.seasons.find((s) => s.id === id)
      if (!data || !summary || data.league.status === 'draft') continue
      const view = seasonView(data, summary)
      const row = view.ladder.find((r) => r.teamId === team.id) ?? null
      past.push({
        seasonId: id,
        seasonName: summary.name,
        seasonSlug: summary.slug,
        leagueName: data.league.name,
        leagueCode: data.league.code,
        leagueSlug: data.league.slug,
        startDate: data.season.startDate,
        position: row?.pos ?? null,
        teamsOnLadder: view.ladder.length,
        points: row?.points ?? null,
        withdrawn: !!data.teams.find((t) => t.id === team.id)?.withdrawnAt,
      })
    }
    past.sort((a, b) => (a.startDate < b.startDate ? 1 : a.startDate > b.startDate ? -1 : 0))
  }
  return { team, current, past }
}

/** "1st", "2nd", "3rd", "11th". */
export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}
