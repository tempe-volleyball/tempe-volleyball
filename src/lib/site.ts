// Site-wide details shown in the footer and on contact links. They move to site_settings once the admin can edit
// them (Phase 3); until then they live here, as on the old site.

export const SITE_NAME = 'Tempe Volleyball'
export const SITE_TAGLINE = 'The one and only since 2005'

export const CONTACT = {
  name: 'Michael',
  phone: '0414 911 544',
  phoneHref: 'tel:+61414911544',
  email: 'tempevb@gmail.com',
  instagram: 'tempe.volleyball',
  instagramUrl: 'https://www.instagram.com/tempe.volleyball/',
} as const

/** Full league names in the old site's widget headings ("Thursday Night League Ladder"). */
export const ladderHeading = (leagueName: string) => `${leagueName} Ladder`
