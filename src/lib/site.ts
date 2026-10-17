// Fixed site-wide names. Contact details, social links and the announcement banner are site settings, edited in the
// admin (src/lib/content/settings.ts, loaded with the rest of the layout by src/server/site.ts).

export const SITE_NAME = 'Tempe Volleyball'
export const SITE_TAGLINE = 'The one and only since 2005'

/** Full league names in the old site's widget headings ("Thursday Night League Ladder"). */
export const ladderHeading = (leagueName: string) => `${leagueName} Ladder`
