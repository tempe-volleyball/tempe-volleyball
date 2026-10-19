import { addDays, parseISO } from './fixtures/dates'

// Public fixture views (docs/admin.md §1 "Fixture lists", §3.5): the league page's Fixtures / Ladder / Results tabs and
// the "This week" / "Upcoming" lists at /leagues/fixtures. Pure: rows in, rows out. Dates are YYYY-MM-DD in Sydney
// local time; `today` comes from sydneyDate(now).

/** The tabs on a league (and season) page, in display order. The ids double as the old #fixtures / #ladder anchors. */
export const LEAGUE_TABS = ['fixtures', 'ladder', 'results'] as const
export type LeagueTab = (typeof LEAGUE_TABS)[number]

export const LEAGUE_TAB_LABELS: Record<LeagueTab, string> = { fixtures: 'Fixtures', ladder: 'Ladder', results: 'Results' }

type WeekLike = { date: string; kind: string; resultsPublishedAt?: string | undefined }

/**
 * The tab a league page opens on: the fixtures before the season's first game night (and while there's no draw),
 * the ladder from then on, including once the season is over. An #anchor in the URL still wins (in the browser).
 */
export function defaultLeagueTab(weeks: readonly WeekLike[], today: string): LeagueTab {
  const nights = weeks.filter((w) => w.kind !== 'skip')
  if (nights.length === 0) return 'fixtures'
  if (nights.some((w) => w.resultsPublishedAt)) return 'ladder'
  const first = nights.reduce((min, w) => (w.date < min ? w.date : min), nights[0]!.date)
  return today < first ? 'fixtures' : 'ladder'
}

type RowLike = { date: string }

/**
 * Splits a season's fixture rows into what's still to come (Fixtures, in date order) and what's been played
 * (Results, latest night first, each night's games in their usual order). A night counts as played once its date
 * has passed or its results are published, so a night shows under Results the moment Michael publishes it.
 */
export function splitFixtures<T extends RowLike>(rows: readonly T[], weeks: readonly WeekLike[], today: string) {
  const published = new Set(weeks.filter((w) => w.resultsPublishedAt).map((w) => w.date))
  const upcoming: T[] = []
  const playedByDate = new Map<string, T[]>()
  for (const r of rows) {
    if (r.date < today || published.has(r.date)) {
      const list = playedByDate.get(r.date)
      if (list) list.push(r)
      else playedByDate.set(r.date, [r])
    } else upcoming.push(r)
  }
  const played = [...playedByDate.entries()].toSorted(([a], [b]) => b.localeCompare(a)).flatMap(([, list]) => list)
  return { upcoming, played }
}

/** Monday to Sunday of the week `today` falls in. */
export function weekRange(today: string): { from: string; to: string } {
  const dow = parseISO(today).getUTCDay() // 0 = Sunday
  const from = addDays(today, -((dow + 6) % 7))
  return { from, to: addDays(from, 6) }
}

export const FIXTURE_VIEWS = ['week', 'upcoming'] as const
export type FixtureView = (typeof FIXTURE_VIEWS)[number]

export const FIXTURE_VIEW_LABELS: Record<FixtureView, string> = { week: 'This week', upcoming: 'Upcoming' }

/** `date` (YYYY-MM-DD): one night's games across leagues (the home page calendar links here); it overrides `view`. */
export type FixtureQuery = { view: FixtureView; league: string; team: string; date?: string }

const cleanDate = (v: string | null) => {
  const d = (v ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return ''
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : ''
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const cleanSlug = (v: string | null) => {
  const s = (v ?? '').trim().toLowerCase()
  return s.length <= 100 && SLUG.test(s) ? s : ''
}

/** ?view=upcoming&league=tnl&team=ice-cold, tolerating junk: anything unknown falls back to the default. */
export function parseFixtureQuery(params: URLSearchParams): FixtureQuery {
  const view = params.get('view')
  return {
    view: (FIXTURE_VIEWS as readonly string[]).includes(view ?? '') ? (view as FixtureView) : 'week',
    league: cleanSlug(params.get('league')),
    team: cleanSlug(params.get('team')),
    date: cleanDate(params.get('date')),
  }
}

/** The query string for a fixture list (defaults left out), "" when everything is default. */
export function fixtureQueryString(q: Partial<FixtureQuery>): string {
  const p = new URLSearchParams()
  if (q.date) p.set('date', q.date)
  else if (q.view && q.view !== 'week') p.set('view', q.view)
  if (q.league) p.set('league', q.league)
  if (q.team) p.set('team', q.team)
  const s = p.toString()
  return s ? `?${s}` : ''
}

type ListRow = RowLike & { kind: string; teamIds: { home: string | null; away: string | null; duty: string | null } }

/**
 * The rows a fixture list shows: games and byes (not weeks off) from `from` to `to` inclusive (`to` null = no end),
 * and only the given team's games, byes and duty games when a team is picked.
 */
export function filterFixtureRows<T extends ListRow>(
  rows: readonly T[],
  opts: { from: string; to: string | null; teamId?: string | null },
) {
  return rows.filter((r) => {
    if (r.kind === 'skip' || r.date < opts.from || (opts.to && r.date > opts.to)) return false
    if (!opts.teamId) return true
    const t = r.teamIds
    return t.home === opts.teamId || t.away === opts.teamId || t.duty === opts.teamId
  })
}

/** The cross-league fixture list ("This week" / "Upcoming"). Under /leagues so no content page can take it. */
export const FIXTURE_LIST_ROUTE = '/leagues/fixtures'
