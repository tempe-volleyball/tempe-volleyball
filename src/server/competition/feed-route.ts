import type { APIContext } from 'astro'
import { eq } from 'drizzle-orm'
import { buildCalendar, ICAL_CONTENT_TYPE } from '../../lib/ical'
import { SITE_NAME } from '../../lib/site'
import { leagueCalendarPath, teamCalendarPath } from '../../lib/fixture-lists'
import { leagueRoute } from '../../lib/wp-import/routes'
import { cachePublic, tags } from '../cache'
import { teams } from '../db/schema'
import { publicDb, publicSite, redirectFor } from '../public'
import { renamedLeagueSlug } from '../site'
import { seasonCalendarEvents } from './calendar'

// The iCal feed routes: /leagues/<league>/calendar.ics (every game of the league's current season) and
// /leagues/<league>/teams/<team>.ics (one team's games and duties). They follow the current season, so a
// subscription made once keeps working season after season; between seasons a feed is valid but empty rather than
// a 404, so calendar apps don't drop it. Cached like the league page and purged with it (tags.league, SITE).
// A league whose URL changed keeps its subscribers: the old feed URLs 301 to the new ones (renamedLeagueSlug).

const notFound = () => new Response('No such calendar.\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })

export async function calendarFeed(context: APIContext, leagueSlug: string, teamSlug: string | null): Promise<Response> {
  const db = publicDb()
  const site = await publicSite(db)
  const league = site.leagues.find((l) => l.slug === leagueSlug && l.status !== 'draft')
  if (!league) {
    const renamed = await renamedLeagueSlug(db, leagueSlug)
    if (!renamed) return notFound()
    cachePublic(context.cache, tags.programme(renamed))
    const to = teamSlug ? teamCalendarPath(renamed, teamSlug) : leagueCalendarPath(renamed)
    return new Response(null, { status: 301, headers: { Location: to } })
  }
  const view = site.current.find((c) => c.league.id === league.id && c.summary.status === 'published')
  let team: { id: string; name: string; slug: string } | undefined = teamSlug
    ? view?.data.teams.find((t) => t.slug === teamSlug)
    : undefined
  if (teamSlug && !team) {
    // Not in the current season: an empty feed if the team exists (it may play again next season), else a 404.
    team = await db.select({ id: teams.id, name: teams.name, slug: teams.slug }).from(teams).where(eq(teams.slug, teamSlug)).get()
    // A team merged into another leaves a 301 to the other team's feed (teams.ts mergeTeams).
    if (!team) return (await redirectFor(context, db, context.url.pathname)) ?? notFound()
  }
  const venue = league.defaultVenueId ? site.venues.find((v) => v.id === league.defaultVenueId) : undefined
  const pageUrl = new URL(leagueRoute(league.slug), context.site ?? context.url).toString()
  const teamId = team?.id ?? null
  const inSeason = !!view && (!teamId || view.data.teams.some((t) => t.id === teamId))
  const events = view && inSeason ? seasonCalendarEvents(view, { venue, teamId, pageUrl }) : []
  const name = team ? `${team.name} (${league.code}) – ${SITE_NAME}` : `${league.name} – ${SITE_NAME}`
  const body = buildCalendar({
    name,
    description: team
      ? `${team.name}'s ${league.code} games and duties.`
      : `Every ${league.name} game, ${view?.summary.name ?? 'this season'}.`,
    events,
    now: new Date(),
  })
  cachePublic(context.cache, tags.league(league.slug), tags.programme(league.slug), tags.venues)
  return new Response(body, {
    headers: {
      'Content-Type': ICAL_CONTENT_TYPE,
      'Content-Disposition': `inline; filename="${team ? `${league.slug}-${team.slug}` : league.slug}.ics"`,
    },
  })
}
