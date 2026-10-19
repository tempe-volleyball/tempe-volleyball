import { and, asc, count, eq, inArray, ne } from 'drizzle-orm'
import { runBatch, type AppDb } from '../db'
import { leagues, matchDays, matches, seasons } from '../db/schema'
import { seasonView, type LeagueSeason, type Site } from '../site'
import { assembleSeasons, baseQueries, seasonQueries, type SeasonRows } from './load'

// The home page calendar (docs/public-site.md "Calendar") and the one-night view it links to
// (/leagues/fixtures?date=…). Only published and archived seasons count; drafts never show.

/** One league's game night, as the calendar shows it. */
export type CalendarNight = {
  /** YYYY-MM-DD, Sydney. */
  date: string
  code: string
  /** scheduled | postponed | cancelled (the whole night). */
  status: string
  /** The public reason for a postponed or cancelled night. */
  note: string
  games: number
}

const visible = and(inArray(seasons.status, ['published', 'archived']), ne(leagues.status, 'draft'), eq(leagues.kind, 'league'))

/** Every game night of every published or archived season (weeks off left out): a few hundred small rows. */
export async function calendarNights(db: AppDb): Promise<CalendarNight[]> {
  const rows = await db
    .select({
      date: matchDays.date,
      code: leagues.code,
      status: matchDays.status,
      note: matchDays.note,
      games: count(matches.id),
    })
    .from(matchDays)
    .innerJoin(seasons, eq(seasons.id, matchDays.seasonId))
    .innerJoin(leagues, eq(leagues.id, seasons.leagueId))
    .leftJoin(matches, eq(matches.matchDayId, matchDays.id))
    .where(and(visible, ne(matchDays.kind, 'skip')))
    .groupBy(matchDays.id)
    .orderBy(asc(matchDays.date), asc(leagues.sort))
  return rows.map((r) => ({ ...r, note: r.status === 'scheduled' ? '' : (r.note ?? '') }))
}

/** The seasons with games on `date` (current ones from `site`, older ones loaded in one batch). */
export async function seasonsOnDate(db: AppDb, site: Site, date: string): Promise<LeagueSeason[]> {
  const ids = (
    await db
      .selectDistinct({ id: seasons.id })
      .from(matchDays)
      .innerJoin(seasons, eq(seasons.id, matchDays.seasonId))
      .innerJoin(leagues, eq(leagues.id, seasons.leagueId))
      .where(and(visible, eq(matchDays.date, date), ne(matchDays.kind, 'skip')))
  ).map((r) => r.id)
  const current = site.current.filter((c) => ids.includes(c.summary.id))
  const rest = ids.filter((id) => !current.some((c) => c.summary.id === id))
  const out = [...current]
  if (rest.length) {
    const [, courtQ] = baseQueries(db)
    const res = await runBatch(db, [courtQ, ...seasonQueries(db, { ids: rest })])
    const [courtRows, ...rows] = res as unknown as [Awaited<typeof courtQ>, ...SeasonRows]
    const loaded = assembleSeasons(rows as unknown as SeasonRows, site.leagues, courtRows)
    for (const id of rest) {
      const data = loaded.get(id)
      const summary = site.seasons.find((s) => s.id === id)
      if (data && summary) out.push(seasonView(data, summary))
    }
  }
  const order = new Map(site.leagues.map((l, i) => [l.id, i]))
  return out.toSorted((a, b) => (order.get(a.league.id) ?? 0) - (order.get(b.league.id) ?? 0))
}
