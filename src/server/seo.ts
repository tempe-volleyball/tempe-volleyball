import { programmeEventsLd, seasonEventLd } from '../lib/seo/events'
import type { Thing } from '../lib/seo/jsonld'
import { socialImageUrl } from '../lib/seo/meta'
import type { Programme } from './db/schema'
import type { ProgrammeInstance } from './programmes/public'
import type { LeagueSeason, Site } from './site'

// JSON-LD for the league, season and programme pages, from what those routes already loaded (no queries).
// The builders are in src/lib/seo; this only picks the venue, image and dates out of the server's shapes.

/** The venue a season plays at: the league's default venue, else the venue of the season's first default court. */
export function seasonVenue(view: LeagueSeason, site: Pick<Site, 'venues'>) {
  const byId = new Map(site.venues.map((v) => [v.id, v]))
  const own = view.league.defaultVenueId ? byId.get(view.league.defaultVenueId) : undefined
  if (own) return own
  const courtIds = view.data.season.settings.defaultCourtIds ?? []
  for (const id of courtIds) {
    const court = view.data.courts.find((c) => c.id === id)
    const venue = court && byId.get(court.venueId)
    if (venue) return venue
  }
  return undefined
}

/** A league season as a SportsEvent (current season on the league page, any season on its own page). */
export function seasonJsonLd(
  view: LeagueSeason,
  site: Pick<Site, 'venues' | 'settings'>,
  { origin, url, description, enrolment }: { origin: string; url: string; description: string; enrolment?: { open: boolean; url: string } },
): Thing | null {
  const league = view.league
  return seasonEventLd({
    origin,
    url,
    leagueName: league.name,
    seasonName: view.summary.name,
    description,
    dates: view.data.matchDays.filter((d) => d.kind !== 'skip').map((d) => ({ date: d.date, cancelled: d.status === 'cancelled' })),
    startDate: view.summary.startDate,
    startTime: view.data.season.settings.sessions?.[0] ?? league.startTime,
    venue: seasonVenue(view, site),
    image: socialImageUrl(origin, [league.imageId], site.settings.seo),
    priceCents: league.priceCents,
    enrolment,
  })
}

/** A training, development or event programme's upcoming dates. */
export function programmeJsonLd(
  p: Pick<Programme, 'name' | 'startTime' | 'endTime' | 'defaultVenueId' | 'priceCents' | 'imageId'>,
  upcoming: ProgrammeInstance[],
  site: Pick<Site, 'venues' | 'settings'>,
  opts: {
    origin: string
    url: string
    description: string
    targets: { kind: string; id: string; amountCents: number | null; full: boolean }[]
  },
): Thing[] {
  return programmeEventsLd({
    origin: opts.origin,
    url: opts.url,
    programme: p,
    description: opts.description,
    instances: upcoming,
    venues: site.venues,
    image: socialImageUrl(opts.origin, [p.imageId], site.settings.seo),
    targets: new Map(opts.targets.map((t) => [`${t.kind}:${t.id}`, t])),
    enrolUrl: `${opts.url}#enrol`,
  })
}
