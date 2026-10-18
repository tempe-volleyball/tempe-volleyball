import { eventLd, type PlaceInput, type Thing } from './jsonld'

// The (Sports)Event nodes of the league, season and programme pages (docs/public-site.md "Structured data"):
// a league season is one SportsEvent from its first to its last night; an event programme's dates are
// SportsEvents; training sessions and development terms are Events. Pure: the pages pass what they already loaded.

/** At most this many upcoming dates go into a page's JSON-LD (a weekly session list can be long). */
export const MAX_EVENTS = 12

export type SeasonEventInput = {
  origin: string
  url: string
  leagueName: string
  seasonName: string
  description: string
  /** The season's nights (YYYY-MM-DD), any order; skipped weeks left out by the caller or ignored when cancelled. */
  dates: { date: string; cancelled?: boolean }[]
  /** Fallback when there's no draw yet. */
  startDate: string
  startTime?: string | null | undefined
  endTime?: string | null | undefined
  venue: PlaceInput | null | undefined
  image: string
  priceCents?: number | null | undefined
  enrolment?: { open: boolean; url: string; full?: boolean } | undefined
}

/**
 * A league season as one SportsEvent ("Thursday Night League TNL Q4 2026"). Null without a venue: Google requires
 * an event's location, and an event it can't use is only an error in Search Console.
 */
export function seasonEventLd(s: SeasonEventInput): Thing | null {
  if (!s.venue) return null
  const nights = s.dates
    .filter((d) => !d.cancelled)
    .map((d) => d.date)
    .toSorted()
  return eventLd({
    type: 'SportsEvent',
    origin: s.origin,
    name: s.seasonName.toLowerCase().includes(s.leagueName.toLowerCase()) ? s.seasonName : `${s.leagueName} ${s.seasonName}`,
    url: s.url,
    description: s.description,
    startDate: nights[0] ?? s.startDate,
    endDate: nights.at(-1),
    // A season spans weeks, so only its first night gets a start time; the end is the last night's date.
    startTime: s.startTime,
    location: s.venue,
    image: s.image,
    priceCents: s.priceCents,
    enrolment: s.enrolment,
  })
}

export type InstanceInput = {
  kind: 'session' | 'term' | 'event'
  id: string
  title: string
  startDate: string
  endDate: string | null
  startTime: string | null
  endTime: string | null
  status: 'scheduled' | 'postponed' | 'cancelled'
  movedFrom: string | null
  venueId: string | null
  ageGroup: string | null
}

export type ProgrammeEventsInput = {
  origin: string
  url: string
  programme: { name: string; startTime: string | null; endTime: string | null; defaultVenueId: string | null; priceCents: number | null }
  description: string
  instances: InstanceInput[]
  venues: (PlaceInput & { id: string })[]
  image: string
  /** Open enrolment targets by "<kind>:<id>" (from the enrolment form's props). */
  targets: Map<string, { amountCents: number | null; full: boolean }>
  enrolUrl: string
}

/**
 * A training, development or event programme's upcoming dates as Events / SportsEvents (at most MAX_EVENTS). Dates
 * with no venue (their own or the programme's) are left out, as for seasons.
 */
export function programmeEventsLd(p: ProgrammeEventsInput): Thing[] {
  const venueById = new Map(p.venues.map((v) => [v.id, v]))
  const where = (i: InstanceInput) => venueById.get(i.venueId ?? p.programme.defaultVenueId ?? '')
  return p.instances
    .filter((i) => where(i))
    .slice(0, MAX_EVENTS)
    .map((i) => {
      const target = p.targets.get(`${i.kind}:${i.id}`)
      const name = i.kind === 'session' ? (i.title ? `${p.programme.name}: ${i.title}` : p.programme.name) : i.title || p.programme.name
      const price = target?.amountCents ?? p.programme.priceCents
      return eventLd({
        type: i.kind === 'event' ? 'SportsEvent' : 'Event',
        origin: p.origin,
        name,
        url: p.url,
        description: p.description,
        startDate: i.startDate,
        endDate: i.endDate,
        startTime: i.startTime ?? p.programme.startTime,
        // A term runs for weeks: its end is a date, not that day's finishing time.
        endTime: i.kind === 'term' ? null : (i.endTime ?? p.programme.endTime),
        status: i.status,
        movedFrom: i.movedFrom,
        location: where(i),
        image: p.image,
        ageRange: i.ageGroup,
        priceCents: price,
        enrolment: price === null ? undefined : { open: !!target, full: target?.full ?? false, url: p.enrolUrl },
      })
    })
}
