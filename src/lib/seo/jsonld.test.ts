import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../content/settings'
import { programmeEventsLd, seasonEventLd, MAX_EVENTS } from './events'
import {
  breadcrumbLd,
  compact,
  eventLd,
  intlPhone,
  jsonLdGraph,
  jsonLdText,
  newsArticleLd,
  organizationId,
  organizationLd,
  placeLd,
  websiteLd,
} from './jsonld'

const ORIGIN = 'https://www.tempevb.com'
const TEMPE = { name: 'Robyn Webster Sports Centre', address: 'Holbeach Ave, Tempe NSW 2044', mapUrl: 'https://maps.app.goo.gl/x' }

describe('jsonLdText', () => {
  it('cannot end the script or open a comment, and parses back unchanged', () => {
    const evil = { name: 'x</script><script>alert(1)</script><!-- & \u2028\u2029' }
    const text = jsonLdText(evil)
    expect(text).not.toMatch(/<|>|&/)
    expect(text).not.toMatch(/[\u2028\u2029]/)
    expect(text.toLowerCase()).not.toContain('</script')
    expect(JSON.parse(text)).toEqual(evil)
  })
})

describe('compact', () => {
  it('drops empty values recursively but keeps false and 0', () => {
    expect(compact({ a: '', b: null, c: undefined, d: [], e: {}, f: { g: '' }, h: 0, i: false, j: ['', 'x'] })).toEqual({
      h: 0,
      i: false,
      j: ['x'],
    })
  })
})

describe('intlPhone', () => {
  it('writes Australian numbers in international form', () => {
    expect(intlPhone('0414 911 544')).toBe('+61 414 911 544')
    expect(intlPhone('(02) 9550 1234')).toBe('+61 2 9550 1234')
    expect(intlPhone('+61414911544')).toBe('+61 414 911 544')
    expect(intlPhone('+1 555 0100')).toBe('+1 555 0100')
  })
})

describe('placeLd', () => {
  it('splits a typed Australian address into a PostalAddress', () => {
    expect(placeLd(TEMPE)).toEqual({
      '@type': 'Place',
      name: 'Robyn Webster Sports Centre',
      address: {
        '@type': 'PostalAddress',
        streetAddress: 'Holbeach Ave',
        addressLocality: 'Tempe',
        addressRegion: 'NSW',
        postalCode: '2044',
        addressCountry: 'AU',
      },
      hasMap: 'https://maps.app.goo.gl/x',
    })
  })
  it('keeps other shapes as the street address, and drops non-https map links', () => {
    expect(placeLd({ name: 'Hall', address: 'Somewhere in Sydney', mapUrl: 'javascript:x' })).toEqual({
      '@type': 'Place',
      name: 'Hall',
      address: { '@type': 'PostalAddress', streetAddress: 'Somewhere in Sydney', addressRegion: 'NSW', addressCountry: 'AU' },
    })
    expect(placeLd({ name: 'Hall', address: null })).toEqual({ '@type': 'Place', name: 'Hall' })
  })
})

describe('organizationLd', () => {
  const org = organizationLd({
    origin: ORIGIN,
    contact: DEFAULT_SETTINGS.contact,
    social: { instagram: 'https://www.instagram.com/tempe.volleyball/', facebook: '' },
    seo: { ...DEFAULT_SETTINGS.seo, sameAs: ['https://www.instagram.com/tempe.volleyball/', 'https://www.youtube.com/@tempe'] },
    description: 'Social volleyball in Sydney.',
    venues: [TEMPE],
    logo: `${ORIGIN}/images/logo-400.webp`,
  })
  it('is a SportsOrganization from the settings', () => {
    expect(org).toMatchObject({
      '@type': 'SportsOrganization',
      '@id': organizationId(ORIGIN),
      name: 'Tempe Volleyball',
      alternateName: 'Tempe VB',
      url: `${ORIGIN}/`,
      sport: 'Volleyball',
      foundingDate: '2005',
      email: 'tempevb@gmail.com',
      telephone: '+61 414 911 544',
      contactPoint: { '@type': 'ContactPoint', name: 'Michael', telephone: '+61 414 911 544' },
      logo: { '@type': 'ImageObject', url: `${ORIGIN}/images/logo-400.webp` },
    })
    expect(org.location).toHaveLength(1)
  })
  it('lists each profile once and skips empty ones', () => {
    expect(org.sameAs).toEqual(['https://www.instagram.com/tempe.volleyball/', 'https://www.youtube.com/@tempe'])
  })
  it('leaves out contact details that are empty', () => {
    const bare = organizationLd({
      origin: ORIGIN,
      contact: { name: '', phone: '', email: '' },
      social: { instagram: '', facebook: '' },
      seo: { ...DEFAULT_SETTINGS.seo, alternateName: '', foundingYear: '' },
      description: 'x',
      venues: [],
      logo: `${ORIGIN}/l.webp`,
    })
    for (const k of ['email', 'telephone', 'contactPoint', 'sameAs', 'location', 'foundingDate', 'alternateName'])
      expect(bare).not.toHaveProperty(k)
  })
})

describe('jsonLdGraph', () => {
  it('wraps nodes in one @graph with the schema.org context', () => {
    const g = jsonLdGraph([websiteLd(ORIGIN)])
    expect(g).toEqual({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebSite',
          '@id': `${ORIGIN}/#website`,
          url: `${ORIGIN}/`,
          name: 'Tempe Volleyball',
          inLanguage: 'en-AU',
          publisher: { '@id': organizationId(ORIGIN) },
        },
      ],
    })
  })
})

describe('breadcrumbLd', () => {
  it('numbers the items from 1', () => {
    expect(
      breadcrumbLd([
        { name: 'Home', url: `${ORIGIN}/` },
        { name: 'Mixed Leagues', url: `${ORIGIN}/mixed-leagues` },
      ]),
    ).toEqual({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: 'Mixed Leagues', item: `${ORIGIN}/mixed-leagues` },
      ],
    })
  })
})

describe('eventLd', () => {
  const base = { type: 'Event' as const, origin: ORIGIN, name: 'Scrim', url: `${ORIGIN}/training/scrim`, startDate: '2026-10-22' }
  it('gives times with Sydney’s offset that day and an offline status', () => {
    const e = eventLd({ ...base, startTime: '18:30', endTime: '20:00', location: TEMPE })
    expect(e).toMatchObject({
      startDate: '2026-10-22T18:30:00+11:00',
      endDate: '2026-10-22T20:00:00+11:00',
      eventStatus: 'https://schema.org/EventScheduled',
      eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
      organizer: { '@id': organizationId(ORIGIN) },
      location: { '@type': 'Place', name: 'Robyn Webster Sports Centre' },
    })
    expect(eventLd({ ...base, startDate: '2026-07-02', startTime: '18:30' }).startDate).toBe('2026-07-02T18:30:00+10:00')
  })
  it('marks postponed, cancelled and moved dates', () => {
    expect(eventLd({ ...base, status: 'postponed' }).eventStatus).toBe('https://schema.org/EventPostponed')
    expect(eventLd({ ...base, status: 'cancelled' }).eventStatus).toBe('https://schema.org/EventCancelled')
    expect(eventLd({ ...base, movedFrom: '2026-10-15' })).toMatchObject({
      eventStatus: 'https://schema.org/EventRescheduled',
      previousStartDate: '2026-10-15',
    })
  })
  it('adds an Offer in AUD only with a price, available while enrolment is open', () => {
    expect(eventLd(base)).not.toHaveProperty('offers')
    const url = `${base.url}#enrol`
    expect(eventLd({ ...base, priceCents: 1500, enrolment: { open: true, url } }).offers).toEqual({
      '@type': 'Offer',
      price: '15.00',
      priceCurrency: 'AUD',
      url,
      availability: 'https://schema.org/InStock',
    })
    expect(
      (eventLd({ ...base, priceCents: 1500, enrolment: { open: true, full: true, url } }).offers as { availability: string }).availability,
    ).toBe('https://schema.org/SoldOut')
    expect(
      eventLd({ ...base, priceCents: 0, enrolment: { open: false, url } }).offers as { price: string; availability: string },
    ).toMatchObject({
      price: '0.00',
      availability: 'https://schema.org/OutOfStock',
    })
  })
  it('only SportsEvents name the sport', () => {
    expect(eventLd(base)).not.toHaveProperty('sport')
    expect(eventLd({ ...base, type: 'SportsEvent' }).sport).toBe('Volleyball')
  })
})

describe('seasonEventLd', () => {
  it('runs from the first to the last night that is not cancelled', () => {
    const e = seasonEventLd({
      origin: ORIGIN,
      url: `${ORIGIN}/leagues/tnl`,
      leagueName: 'Thursday Night League',
      seasonName: 'TNL Q4 2026',
      description: 'Ladder and fixtures.',
      dates: [{ date: '2026-10-22' }, { date: '2026-10-15' }, { date: '2026-12-17', cancelled: true }, { date: '2026-12-10' }],
      startDate: '2026-10-15',
      startTime: '20:00',
      venue: TEMPE,
      image: `${ORIGIN}/images/og-default.jpg`,
    })
    expect(e).toMatchObject({
      '@type': 'SportsEvent',
      name: 'Thursday Night League TNL Q4 2026',
      startDate: '2026-10-15T20:00:00+11:00',
      endDate: '2026-12-10',
      image: [`${ORIGIN}/images/og-default.jpg`],
    })
  })
  it('falls back to the season start before there is a draw, and is left out without a venue', () => {
    const input = {
      origin: ORIGIN,
      url: 'u',
      leagueName: 'TNL',
      seasonName: 'TNL Q1 2027',
      description: 'd',
      dates: [],
      startDate: '2027-01-14',
      venue: TEMPE,
      image: 'i',
    }
    const e = seasonEventLd(input)
    expect(e).toMatchObject({ name: 'TNL Q1 2027', startDate: '2027-01-14' })
    expect(e).not.toHaveProperty('endDate')
    expect(seasonEventLd({ ...input, venue: null })).toBeNull()
  })
})

describe('programmeEventsLd', () => {
  const venues = [{ id: 'v1', ...TEMPE }]
  const programme = { name: 'Scrim Training', startTime: '18:00', endTime: '20:00', defaultVenueId: 'v1', priceCents: 1500 }
  const instance = {
    kind: 'session' as const,
    id: 's1',
    title: 'Serving',
    startDate: '2026-10-22',
    endDate: null,
    startTime: null,
    endTime: null,
    status: 'scheduled' as const,
    movedFrom: null,
    venueId: null,
    ageGroup: null,
  }
  it('makes an Event per upcoming session with the programme’s times, venue and price', () => {
    const [e] = programmeEventsLd({
      origin: ORIGIN,
      url: `${ORIGIN}/training/scrim`,
      programme,
      description: 'd',
      instances: [instance],
      venues,
      image: 'i',
      targets: new Map([['session:s1', { amountCents: 2000, full: false }]]),
      enrolUrl: `${ORIGIN}/training/scrim#enrol`,
    })
    expect(e).toMatchObject({
      '@type': 'Event',
      name: 'Scrim Training: Serving',
      startDate: '2026-10-22T18:00:00+11:00',
      endDate: '2026-10-22T20:00:00+11:00',
      location: { name: 'Robyn Webster Sports Centre' },
      offers: { price: '20.00', availability: 'https://schema.org/InStock' },
    })
  })
  it('terms end on a date, events are SportsEvents, and the list is capped', () => {
    const term = { ...instance, kind: 'term' as const, title: 'Term 4 2026', endDate: '2026-12-10', ageGroup: 'Under 12s' }
    const many = Array.from({ length: MAX_EVENTS + 5 }, (_, i) => ({ ...term, id: `t${i}` }))
    const out = programmeEventsLd({
      origin: ORIGIN,
      url: 'u',
      programme: { ...programme, priceCents: null },
      description: 'd',
      instances: many,
      venues,
      image: 'i',
      targets: new Map(),
      enrolUrl: 'u#enrol',
    })
    expect(out).toHaveLength(MAX_EVENTS)
    // A date with no venue at all is left out (Google requires a location).
    expect(
      programmeEventsLd({
        origin: ORIGIN,
        url: 'u',
        programme: { ...programme, defaultVenueId: null },
        description: 'd',
        instances: [term],
        venues,
        image: 'i',
        targets: new Map(),
        enrolUrl: 'u#enrol',
      }),
    ).toEqual([])
    expect(out[0]).toMatchObject({ name: 'Term 4 2026', endDate: '2026-12-10', typicalAgeRange: 'Under 12s' })
    expect(out[0]).not.toHaveProperty('offers')
    const [ev] = programmeEventsLd({
      origin: ORIGIN,
      url: 'u',
      programme,
      description: 'd',
      instances: [{ ...instance, kind: 'event', title: 'Tempe Cup 2026' }],
      venues,
      image: 'i',
      targets: new Map(),
      enrolUrl: 'u#enrol',
    })
    expect(ev).toMatchObject({ '@type': 'SportsEvent', name: 'Tempe Cup 2026', offers: { availability: 'https://schema.org/OutOfStock' } })
  })
})

describe('newsArticleLd', () => {
  it('is a NewsArticle published by the club', () => {
    const a = newsArticleLd({
      origin: ORIGIN,
      url: `${ORIGIN}/news/grand-final`,
      headline: 'x'.repeat(130),
      description: 'Grand final night.',
      publishedAt: '2023-12-08T09:00:00.000Z',
      updatedAt: null,
      image: `${ORIGIN}/media/abc/social`,
      section: 'News',
    })
    expect(a).toMatchObject({
      '@type': 'NewsArticle',
      datePublished: '2023-12-08T09:00:00.000Z',
      dateModified: '2023-12-08T09:00:00.000Z',
      publisher: { '@id': organizationId(ORIGIN) },
      author: { '@type': 'Organization', name: 'Tempe Volleyball' },
      image: [`${ORIGIN}/media/abc/social`],
      articleSection: 'News',
    })
    expect((a.headline as string).length).toBeLessThanOrEqual(110)
  })
})
