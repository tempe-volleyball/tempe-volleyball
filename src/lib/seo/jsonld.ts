import type { ContactSettings, SeoSettings, SocialSettings } from '../content/settings'
import { SITE_NAME, SITE_TAGLINE } from '../site'
import { sydneyIso } from '../time'

// Structured data (schema.org JSON-LD) for the public pages (docs/public-site.md "Structured data"). Pure builders:
// the pages pass plain data in and <Seo> (src/components/Seo.astro) writes one <script type="application/ld+json">
// with a @graph. Every page carries the WebSite and the SportsOrganization (built from Site settings), so other
// nodes point at the organisation by @id instead of repeating it.

export type Thing = { '@type': string | string[]; '@id'?: string; [key: string]: unknown }

/**
 * JSON for inside a <script> element: "<", ">" and "&" are written as \u escapes (so "</script>" or "<!--" in a page
 * title can't end the script or open a comment), as are U+2028/U+2029. JSON.parse reads it back unchanged.
 */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** Drops undefined, null, '' and empty arrays/objects, recursively, so builders can list optional fields freely. */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(compact).filter((v) => !isEmpty(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const c = compact(v)
      if (!isEmpty(c)) out[k] = c
    }
    return out as T
  }
  return value
}

const isEmpty = (v: unknown) =>
  v === undefined ||
  v === null ||
  v === '' ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)

/** The page's whole JSON-LD: one @graph. */
export const jsonLdGraph = (nodes: Thing[]) => compact({ '@context': 'https://schema.org', '@graph': nodes })

export const organizationId = (origin: string) => `${origin}/#organization`
export const websiteId = (origin: string) => `${origin}/#website`

/** An Australian number as typed ("0414 911 544", "(02) 9550 1234") in international form ("+61 414 911 544"). */
export function intlPhone(phone: string): string {
  const raw = phone.trim()
  const digits = raw.replace(/\D/g, '')
  const national = raw.startsWith('+')
    ? digits.startsWith('61')
      ? digits.slice(2)
      : null
    : digits.startsWith('0')
      ? digits.slice(1)
      : null
  if (national === null) return raw
  if (national.length !== 9) return `+61 ${national}`
  return national.startsWith('4')
    ? `+61 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`
    : `+61 ${national.slice(0, 1)} ${national.slice(1, 5)} ${national.slice(5)}`
}

export type PlaceInput = { name: string; address: string | null; mapUrl?: string | null }

/**
 * A venue as a schema.org Place. Addresses are typed like "Holbeach Ave, Tempe NSW 2044"; the street, suburb, state
 * and postcode are split out when they're in that shape, otherwise the whole text is the street address.
 */
export function placeLd(v: PlaceInput): Thing {
  const address = (v.address ?? '').trim()
  const m = /^(.+),\s*([^,]+?)\s+(NSW|ACT|VIC|QLD|SA|WA|TAS|NT)\s+(\d{4})(?:,?\s*Australia)?$/i.exec(address)
  return compact({
    '@type': 'Place',
    name: v.name,
    address: address
      ? m
        ? {
            '@type': 'PostalAddress',
            streetAddress: m[1]!.trim(),
            addressLocality: m[2]!.trim(),
            addressRegion: m[3]!.toUpperCase(),
            postalCode: m[4],
            addressCountry: 'AU',
          }
        : { '@type': 'PostalAddress', streetAddress: address, addressRegion: 'NSW', addressCountry: 'AU' }
      : undefined,
    hasMap: v.mapUrl?.startsWith('https://') ? v.mapUrl : undefined,
  })
}

export type OrganizationInput = {
  origin: string
  contact: ContactSettings
  social: SocialSettings
  seo: SeoSettings
  description: string
  venues: PlaceInput[]
  /** Absolute URL of the logo. */
  logo: string
}

/** The club, on every page (Site settings: contact, social links, Search and sharing). */
export function organizationLd(o: OrganizationInput): Thing {
  const telephone = o.contact.phone ? intlPhone(o.contact.phone) : undefined
  return compact({
    '@type': 'SportsOrganization',
    '@id': organizationId(o.origin),
    name: SITE_NAME,
    alternateName: o.seo.alternateName || undefined,
    url: `${o.origin}/`,
    logo: { '@type': 'ImageObject', url: o.logo },
    image: o.logo,
    description: o.description,
    slogan: SITE_TAGLINE,
    sport: 'Volleyball',
    foundingDate: o.seo.foundingYear || undefined,
    email: o.contact.email || undefined,
    telephone,
    contactPoint:
      o.contact.email || telephone
        ? {
            '@type': 'ContactPoint',
            contactType: 'customer support',
            name: o.contact.name || undefined,
            email: o.contact.email || undefined,
            telephone,
            areaServed: 'AU',
            availableLanguage: 'en',
          }
        : undefined,
    areaServed: { '@type': 'City', name: 'Sydney' },
    location: o.venues.map(placeLd),
    sameAs: [...new Set([o.social.instagram, o.social.facebook, ...o.seo.sameAs].filter(Boolean))],
  })
}

export const websiteLd = (origin: string): Thing => ({
  '@type': 'WebSite',
  '@id': websiteId(origin),
  url: `${origin}/`,
  name: SITE_NAME,
  inLanguage: 'en-AU',
  publisher: { '@id': organizationId(origin) },
})

export type Crumb = { name: string; url: string }

/** "Home › Mixed Leagues › Thursday Night League" (absolute URLs, the last one the page itself). */
export function breadcrumbLd(crumbs: Crumb[]): Thing {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })),
  }
}

export type EventStatus = 'scheduled' | 'postponed' | 'cancelled'

export type EventInput = {
  /** SportsEvent for league seasons and event programmes; Event for training sessions and development terms. */
  type: 'SportsEvent' | 'Event'
  name: string
  /** Absolute URL of the page that describes it. */
  url: string
  description?: string | undefined
  /** YYYY-MM-DD (Sydney) and optional HH:MM wall-clock times. */
  startDate: string
  endDate?: string | null | undefined
  startTime?: string | null | undefined
  endTime?: string | null | undefined
  status?: EventStatus | undefined
  /** The date it was first planned for, once it moved (eventStatus EventRescheduled). */
  movedFrom?: string | null | undefined
  location?: PlaceInput | null | undefined
  image?: string | undefined
  origin: string
  /** Price per player in cents; an Offer is added when set. */
  priceCents?: number | null | undefined
  /** Whether people can enrol now (Offer availability), and where. */
  enrolment?: { open: boolean; url: string; full?: boolean } | undefined
  /** Age group text ("Under 12s"): typicalAgeRange is free text too. */
  ageRange?: string | null | undefined
}

const STATUS_URL: Record<EventStatus | 'rescheduled', string> = {
  scheduled: 'https://schema.org/EventScheduled',
  postponed: 'https://schema.org/EventPostponed',
  cancelled: 'https://schema.org/EventCancelled',
  rescheduled: 'https://schema.org/EventRescheduled',
}

/** A season, session, term or event day as a schema.org (Sports)Event. Times are Sydney local with the day's offset. */
export function eventLd(e: EventInput): Thing {
  const status = e.status ?? 'scheduled'
  const rescheduled = status === 'scheduled' && !!e.movedFrom && e.movedFrom !== e.startDate
  const end = e.endDate && e.endDate !== e.startDate ? e.endDate : e.endTime ? e.startDate : null
  const organizer = { '@id': organizationId(e.origin) }
  return compact({
    '@type': e.type,
    name: e.name,
    url: e.url,
    description: e.description,
    startDate: sydneyIso(e.startDate, e.startTime),
    endDate: end ? sydneyIso(end, e.endTime) : undefined,
    eventStatus: STATUS_URL[rescheduled ? 'rescheduled' : status],
    previousStartDate: rescheduled ? e.movedFrom : undefined,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: e.location ? placeLd(e.location) : undefined,
    image: e.image ? [e.image] : undefined,
    organizer,
    sport: e.type === 'SportsEvent' ? 'Volleyball' : undefined,
    typicalAgeRange: e.ageRange || undefined,
    offers:
      e.priceCents !== null && e.priceCents !== undefined && e.enrolment
        ? {
            '@type': 'Offer',
            price: (e.priceCents / 100).toFixed(2),
            priceCurrency: 'AUD',
            url: e.enrolment.url,
            availability: !e.enrolment.open
              ? 'https://schema.org/OutOfStock'
              : e.enrolment.full
                ? 'https://schema.org/SoldOut'
                : 'https://schema.org/InStock',
          }
        : undefined,
  })
}

export type ArticleInput = {
  origin: string
  url: string
  headline: string
  description: string
  /** UTC ISO instants. */
  publishedAt: string | null
  updatedAt: string | null
  image: string
  section?: string | null | undefined
}

/** A news post. Headlines over 110 characters are cut (Google's limit). */
export function newsArticleLd(a: ArticleInput): Thing {
  const headline = a.headline.length > 110 ? `${a.headline.slice(0, 109).trimEnd()}…` : a.headline
  return compact({
    '@type': 'NewsArticle',
    headline,
    description: a.description,
    url: a.url,
    mainEntityOfPage: a.url,
    image: [a.image],
    datePublished: a.publishedAt ?? undefined,
    dateModified: a.updatedAt ?? a.publishedAt ?? undefined,
    articleSection: a.section || undefined,
    inLanguage: 'en-AU',
    author: { '@type': 'Organization', name: SITE_NAME, url: `${a.origin}/` },
    publisher: { '@id': organizationId(a.origin) },
  })
}
