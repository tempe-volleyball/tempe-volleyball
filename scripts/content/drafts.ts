// The content map's drafted text (docs/content-map.md, docs/admin.md §3.8): the old site's 37 pages rewritten into
// programmes, category intros, venue directions, page revisions and the /enrol intro, for Michael to review on
// staging. Plain data; sql.ts turns it into guarded SQL and apply.ts runs it.
//
// The rules for this text: current, clear and dateless where possible (dates, prices and fees belong in fields that
// change each season: seasons, sessions, products, next_starts_text), no facts that aren't on the old site or in
// CLAUDE.md's domain rules, and anything doubtful flagged in docs/content-map.md for Michael.

import type { ProgrammeKind } from '../../src/server/db/schema/enums'
import { slugify } from '../../src/lib/content/paths'
import { programmePath } from '../../src/lib/programmes'
import { body, contactForm, h2, h3, p, programmeList, ul } from './doc'
import type { ContentBody } from '../../src/server/db/schema/columns'

/** Venue slugs (venues.slug, from the importer). */
const TEMPE = 'robyn-webster-sports-centre'
const BURWOOD = 'mlc-school'
const FIVE_DOCK = 'five-dock-leisure-centre'

/** Category ids seeded by migration 0003. */
export const CAT = {
  mixed: 'cat_mixed_leagues',
  superLeague: 'cat_super_league',
  juniors: 'cat_juniors',
  adultTraining: 'cat_adult_training',
} as const

const VNSW_REGISTER = 'https://www.revolutionise.com.au/usyd/registration/'

/** The Volleyball NSW membership paragraph most pages need. Membership is paid through the USYD portal (Revolutionise). */
const membership = (level: 'recreational' | 'full' = 'recreational') =>
  p(
    `Every player needs a current Volleyball NSW ${level} membership, through our club (Sydney Uni, USYD). [Register with Volleyball NSW](${VNSW_REGISTER}) once your spot is confirmed. Already a member through another club? Choose “Renew” on that page and add USYD to your profile.`,
  )

// ── Programmes ────────────────────────────────────────────────────────────────

export type DraftProgramme = {
  name: string
  code: string
  kind: Exclude<ProgrammeKind, 'league'>
  categoryId: string
  /** 0 = Sunday … 6 = Saturday. Required by the schema; for events, the usual day. */
  weekday: number
  venueSlug: string | null
  startTime: string | null
  endTime: string | null
  /** Hand-written day-and-times text where one weekday and venue can't say it. */
  scheduleLabel: string | null
  ageMin?: number
  ageMax?: number
  capPlayers?: number
  priceCents?: number
  allowFreeAgents?: boolean
  sort: number
  description: ContentBody
}

/** The slug the admin would give it (leagues use the code; other kinds the name). */
export const programmeSlug = (d: Pick<DraftProgramme, 'name'>) => slugify(d.name)
export const draftPath = (d: DraftProgramme) => programmePath(d.kind, programmeSlug(d))

export const ADP: DraftProgramme = {
  name: 'Adult Development Program (ADP)',
  code: 'ADP',
  kind: 'development',
  categoryId: CAT.adultTraining,
  weekday: 6,
  venueSlug: null,
  startTime: '20:00',
  endTime: '22:00',
  scheduleLabel: 'Saturdays 8–10pm at Tempe, Sundays 1–3pm at Burwood',
  ageMin: 18,
  sort: 1,
  description: body([
    p(
      'Coached sessions for adults (18+) who want to learn volleyball, improve their technique or get ready for a social league. Beginners are welcome.',
    ),
    h2('When and where'),
    ul('Saturdays, 8–10pm: Robyn Webster Sports Centre, Tempe', 'Sundays, 1–3pm: MLC School, Burwood'),
    h2('What we cover'),
    ul(
      'Passing (dig), setting, attacking (spike), blocking, serving and serve receive',
      'Court movement and positioning',
      'Game strategy and teamwork',
      'Confidence on court for new players',
    ),
    membership(),
  ]),
}

export const SCRIM: DraftProgramme = {
  name: 'Scrim & Coached Training',
  code: 'SCT',
  kind: 'training',
  categoryId: CAT.adultTraining,
  weekday: 5,
  venueSlug: TEMPE,
  startTime: '20:00',
  endTime: '22:00',
  scheduleLabel: null,
  sort: 2,
  description: body([
    p(
      'Court time for adults who want more games between league nights: open scrimmage, plus coached sessions. Come on your own or bring a team of six or more.',
    ),
    p('Bookings are essential. Pick a session below and we’ll confirm your place by email.'),
    membership(),
  ]),
}

export const CASUAL: DraftProgramme = {
  name: 'Thursday Night Casual Training',
  code: 'TCT',
  kind: 'training',
  categoryId: CAT.adultTraining,
  weekday: 4,
  venueSlug: TEMPE,
  startTime: '20:00',
  endTime: '22:00',
  scheduleLabel: null,
  capPlayers: 40,
  priceCents: 1500,
  sort: 3,
  description: body([
    p(
      'Casual training sessions on Thursday evenings at the Robyn Webster Sports Centre in Tempe, run with the Sydney Uni Volleyball Club.',
    ),
    p(
      'Each session takes up to 40 people, first come, first served, so book your place below. The session fee is paid in cash on the night (there’s no ATM or EFTPOS at the venue).',
    ),
  ]),
}

export const JDP: DraftProgramme = {
  name: 'Junior Development Program (JDP)',
  code: 'JDP',
  kind: 'development',
  categoryId: CAT.juniors,
  weekday: 1,
  venueSlug: null,
  startTime: '18:00',
  endTime: '20:00',
  scheduleLabel: 'Mondays 6–8pm at Five Dock, Fridays 8–10pm at Tempe',
  ageMin: 12,
  ageMax: 17,
  sort: 1,
  description: body([
    p(
      'VolleyJoeys, our Junior Development Program, is for players aged 12 to 17 who want to learn the fundamentals of volleyball or work towards playing in competitions.',
    ),
    h2('When and where'),
    ul('Mondays, 6–8pm: Five Dock Leisure Centre', 'Fridays, 8–10pm: Robyn Webster Sports Centre, Tempe'),
    p('All our coaches hold a current Working With Children Check.'),
    p('Enrol for a whole term below. A parent or guardian fills in the form for players under 18.'),
    membership(),
  ]),
}

export const REP: DraftProgramme = {
  name: 'Junior Rep Teams',
  code: 'JREP',
  kind: 'development',
  categoryId: CAT.juniors,
  weekday: 1,
  venueSlug: FIVE_DOCK,
  startTime: '18:00',
  endTime: '20:00',
  scheduleLabel: null,
  sort: 2,
  description: body([
    p(
      'Tempe Volleyball and the Sydney Uni Volleyball Club (USYD) select junior teams to play in the Junior Sydney Volleyball League against other clubs, with qualified coaches, weekly training and club uniforms for rep players.',
    ),
    h2('What selected players commit to'),
    ul(
      'A weekly league game through the season, at Sydney Olympic Park',
      'Weekly coached training, which is an essential part of the program',
    ),
    p('Teams are picked at selection trials before each season. Register your interest below and we’ll be in touch about trial dates.'),
    p(
      `Rep players need a **full** Volleyball NSW membership through USYD. [Register with Volleyball NSW](${VNSW_REGISTER}) once selected. All our coaches hold a current Working With Children Check.`,
    ),
  ]),
}

export const CUP: DraftProgramme = {
  name: 'Tempe Cup',
  code: 'CUP',
  kind: 'event',
  categoryId: CAT.mixed,
  weekday: 6,
  venueSlug: TEMPE,
  startTime: '12:00',
  endTime: '22:00',
  scheduleLabel: null,
  allowFreeAgents: false,
  sort: 9,
  description: body([
    p('A one-day mixed tournament at the Robyn Webster Sports Centre in Tempe for teams with intermediate to advanced experience.'),
    ul('Team entry, with prize money for the winners and runners-up', 'At least one female player on court at all times'),
    p(
      `Every player needs a Volleyball NSW recreational membership or a single-event registration. [Register with Volleyball NSW](${VNSW_REGISTER}).`,
    ),
  ]),
}

/** New programmes, all saved as drafts (hidden on the site until Michael makes them active). */
export const DRAFT_PROGRAMMES: DraftProgramme[] = [ADP, SCRIM, CASUAL, JDP, REP, CUP]

// ── Existing leagues ──────────────────────────────────────────────────────────

export type LeagueUpdate = {
  code: string
  /** HH:MM, set only while both are empty. */
  startTime?: string
  endTime?: string
  /** Set only while the description is empty. */
  description?: ContentBody
}

const TVSL_DESCRIPTION = body([
  p(
    'The Tempe Volleyball Super League (TVSL) is for teams serious about progressing beyond social volleyball. It’s a structured, competitive league that follows Volleyball NSW’s endorsement framework for the Sydney Volleyball League (SVL), with men’s and women’s divisions at SVL Division 3/4 level.',
  ),
  h2('Promotion pathway'),
  p(
    'Division 3 champions are nominated for the Volleyball NSW Sydney Volleyball League Promotion Day. The winning team there can play in Division 2 of the Sydney Volleyball League the following year.',
  ),
  h2('Format'),
  ul(
    'An eight-week round robin, then semi-finals and a grand final',
    'Each match has a 90-minute court slot: a 10-minute warm-up and 80 minutes of play',
    'Best of five sets: sets 1–4 to 25 points, set 5 to 15',
    'Round-robin matches are timed; the grand final is untimed',
    'Matches are run by qualified referees or officials recognised by Volleyball NSW, depending on availability. There’s no team duty.',
  ),
  h2('Fees'),
  p('Team entry fees cover the officials, court hire, finals and running the league.'),
  h2('Entering a team'),
  p(
    'Enter your team with the form below when entries are open. Entries close before the season starts, or earlier if the league fills, and a place is confirmed once the entry fee is paid in full.',
  ),
  membership(),
])

/**
 * A social league's description (Phase 7: the league pages only said "TNL Q4 2026."). From the old site's home, rules
 * and enrolment pages and CLAUDE.md's domain rules. The day, times and venue are left out: the line above the
 * description is generated from the league's fields, so it can't go stale.
 */
const socialLeague = (opening: string) =>
  body([
    p(opening),
    h2('How it works'),
    ul(
      'Each team plays one match a night, and each match is two sets, so a draw is possible',
      'Ladder points: win 3, draw 2, loss 1',
      'Teams referee each other: on your duty night your team brings five people (1st and 2nd referee, a scorer and two line judges)',
      'After the round robin, the top four play the semi-finals, then the grand final and the 3rd place match',
    ),
    p('The details are in the [league rules](/rules).'),
    h2('Joining'),
    p(
      'Enter a whole team, or enter on your own and we’ll place you in a team that suits your level. Entries open before each season starts; while they’re open, the form is below.',
    ),
    membership(),
  ])

export const TNL_DESCRIPTION = socialLeague(
  'Our Thursday social mixed league, for players of every level. Teams play in an A Division (intermediate to advanced) or a B Division (beginner to intermediate, ideal if you’re new to volleyball or coming back to it).',
)
export const FNL_DESCRIPTION = socialLeague(
  'Our Friday social mixed league: a relaxed way to finish the week, for players of every level. Teams play in an A Division (intermediate to advanced) or a B Division (beginner to intermediate, ideal if you’re new to volleyball or coming back to it).',
)
export const SNL_DESCRIPTION = socialLeague(
  'Our Saturday social mixed league, for players of every level. Teams play in an A Division (intermediate to advanced) or a B Division (beginner to intermediate, ideal if you’re new to volleyball or coming back to it).',
)
export const SAL_DESCRIPTION = socialLeague(
  'Our Sunday afternoon social mixed league, for players of every level: volleyball without giving up a weeknight. Teams play in an A Division (intermediate to advanced) or a B Division (beginner to intermediate, ideal if you’re new to volleyball or coming back to it).',
)

export const LEAGUE_UPDATES: LeagueUpdate[] = [
  { code: 'TNL', startTime: '20:00', endTime: '22:00', description: TNL_DESCRIPTION },
  { code: 'FNL', startTime: '20:00', endTime: '22:00', description: FNL_DESCRIPTION },
  { code: 'SNL', startTime: '20:00', endTime: '22:00', description: SNL_DESCRIPTION },
  { code: 'SAL', startTime: '15:00', endTime: '17:00', description: SAL_DESCRIPTION },
  { code: 'TVSL', startTime: '19:00', endTime: '22:00', description: TVSL_DESCRIPTION },
]

// ── Category intros ───────────────────────────────────────────────────────────

export const CATEGORY_INTROS: Record<string, ContentBody> = {
  [CAT.mixed]: body([
    p(
      'Our mixed social leagues run on several nights of the week (each one is listed below). They’re relaxed, friendly and a good way to get some exercise and meet people, whether you’re new to volleyball or coming back to it.',
    ),
    ul(
      '**A Division**: intermediate to advanced',
      '**B Division**: beginner to intermediate, ideal for new players',
      'Matches are two sets, so draws happen. Teams take turns refereeing each other (duty).',
      'Seasons run every quarter, with finals at the end',
    ),
    p(
      'Enter as a team or on your own: we place individual players in a team that suits their level. Read the [league rules](/rules) before your first night.',
    ),
  ]),
  [CAT.superLeague]: body([
    p(
      'The Tempe Volleyball Super League (TVSL) is our competitive league, endorsed by Volleyball NSW, for teams working towards the Sydney Volleyball League. Matches are best of five sets with Volleyball NSW referees.',
    ),
  ]),
  [CAT.juniors]: body([
    p(
      'Volleyball for players aged 12 to 17, from first-timers learning the basics to rep teams playing in the Junior Sydney Volleyball League. All our coaches hold a current Working With Children Check.',
    ),
  ]),
  [CAT.adultTraining]: body([
    p(
      'Coached sessions and court time for adults, whether you’ve never played or want to sharpen your game before joining a league. No team needed: come on your own.',
    ),
  ]),
}

// ── Venues ────────────────────────────────────────────────────────────────────

/** venues.directions (plain text, set only while empty). Five Dock has none on the old site. */
export const VENUE_DIRECTIONS: Record<string, string> = {
  [TEMPE]: [
    'Car: about 15 minutes from the city down King St, Newtown. Turn right onto the Princes Highway; Holbeach Ave is the first left at the traffic lights after the old Harp Hotel. Free parking at the sports centre.',
    'Train: T4 Eastern Suburbs & Illawarra Line from Central to Wolli Creek, then a short walk across the Princes Highway to Holbeach Ave.',
    'Bus: the 422 from King St near Newtown Station to Tempe Bus Depot, then a short walk across the Princes Highway to Holbeach Ave.',
  ].join('\n'),
  [BURWOOD]: [
    'Car: street parking around Rowley St, Grantham St and Park Rd.',
    'Train and bus: a 10-minute walk from Burwood Station and nearby bus stops.',
  ].join('\n'),
}

// ── Pages kept: proposed versions saved as revisions ──────────────────────────

/** A kept page's proposed version: saved as a revision just behind the current one, for Michael to view and restore. */
export type PageDraft = {
  path: string
  wpId: number
  /** The imported title, part of the guard: the page must still be the one the importer wrote. */
  importedTitle: string
  title: string
  body: ContentBody
}

const whereWePlay = [
  h2('Robyn Webster Sports Centre, Tempe'),
  p('Holbeach Ave, Tempe NSW 2044.'),
  h3('By car'),
  p(
    'About 15 minutes from the city down King St, Newtown. Turn right onto the Princes Highway; Holbeach Ave is the first left at the traffic lights after the old Harp Hotel. There’s free parking at the sports centre.',
  ),
  h3('By train'),
  p('Take the T4 Eastern Suburbs & Illawarra Line from Central to Wolli Creek, then walk across the Princes Highway to Holbeach Ave.'),
  h3('By bus'),
  p('Take the 422 from King St near Newtown Station to Tempe Bus Depot, then walk across the Princes Highway to Holbeach Ave.'),
  h2('MLC School, Burwood'),
  p('Rowley St, Burwood NSW 2134.'),
  h3('By car'),
  p('Street parking around Rowley St, Grantham St and Park Rd.'),
  h3('By train or bus'),
  p('A 10-minute walk from Burwood Station and nearby bus stops.'),
  h2('Five Dock Leisure Centre'),
  p('William St, Five Dock NSW 2046.'),
]

export const PAGE_DRAFTS: PageDraft[] = [
  {
    path: '/',
    wpId: 3465,
    importedTitle: 'Welcome to Tempe Volleyball!',
    title: 'Welcome to Tempe Volleyball',
    body: body([
      p(
        'Tempe Volleyball runs social mixed leagues, a competitive Super League, and training and development programs for adults and juniors across Sydney’s inner west, in Tempe, Burwood and Five Dock, together with the [Sydney Uni Volleyball Club](https://www.suvolleyball.com/).',
      ),
      p(
        'Whether you’re completely new to volleyball or coming back after a break, our coaches and competitions give you a relaxed, friendly place to build confidence and enjoy the game.',
      ),
      h2('Leagues'),
      p(
        'Our mixed leagues have an A Division (intermediate to advanced) and a B Division (beginner to intermediate, perfect for new players). Individuals and full teams are welcome: we place players in teams by skill level.',
      ),
      programmeList({ filter: { categoryIds: [CAT.mixed, CAT.superLeague], kinds: ['league'] } }),
      h2('Training and development'),
      p('Coaching for adults (18+) and juniors (12 to 17), from the basics to rep teams.'),
      programmeList({
        filter: { categoryIds: [CAT.adultTraining, CAT.juniors] },
        emptyText: 'Training and junior programs are listed here when their next term or session is set. Contact Michael for details.',
      }),
      h2('How to join'),
      p('See what’s open on the [Enrol](/enrol) page, or [contact Michael](/contact) for help choosing the right program.'),
      p(
        'Follow us on [Instagram (@tempe.volleyball)](https://www.instagram.com/tempe.volleyball/) for news, and see [Where we play](/where-we-play) for directions.',
      ),
    ]),
  },
  {
    path: '/about-tempe-vb',
    wpId: 6261,
    importedTitle: 'About Tempe VB',
    title: 'About Tempe Volleyball',
    body: body([
      p(
        'Founded in 2005, Tempe Volleyball is one of the longest-running volleyball clubs in Sydney, built on a simple mission: to introduce more people to volleyball and make it accessible to players of all ages and skill levels.',
      ),
      p(
        'What began as a small community initiative has grown into a volleyball hub with mixed social competitions, development programs for beginners through to advanced players, and pathways for juniors and adults. We’ve welcomed thousands of players into a friendly, supportive and inclusive environment.',
      ),
      p('If you’re looking to start playing volleyball or return to it, Tempe Volleyball is the perfect place to begin.'),
      h2('Find out more'),
      ul(
        '[Where we play](/where-we-play): venues and directions',
        '[League rules](/rules)',
        '[Frequently asked questions](/faq)',
        '[Contact us](/contact)',
      ),
    ]),
  },
  {
    path: '/where-we-play',
    wpId: 694,
    importedTitle: 'WHERE WE PLAY',
    title: 'Where we play',
    body: body(whereWePlay),
  },
  {
    path: '/contact',
    wpId: 62,
    importedTitle: 'CONTACT',
    title: 'Contact',
    body: body([
      p('Questions about a league, a program or your enrolment? Get in touch with Michael:'),
      ul(
        'Email [tempevb@gmail.com](mailto:tempevb@gmail.com) or [m.mouhajer@bigpond.com](mailto:m.mouhajer@bigpond.com)',
        'Phone [0414 911 544](tel:+61414911544)',
      ),
      p('Ready to play? Enrol on the [Enrol](/enrol) page.'),
      p('Directions to each venue are on [Where we play](/where-we-play).'),
    ]),
  },
  {
    path: '/rules',
    wpId: 127,
    importedTitle: 'RULES',
    title: 'League rules',
    body: body([
      p(
        'How our social leagues run. The [Super League](/leagues/tvsl) has its own format and Volleyball NSW referees, so it has no team duty.',
      ),
      h2('Matches and points'),
      ul(
        'Each match is two sets, so a draw is possible',
        'Ladder points: win 3, draw 2, loss 1',
        'The duty team does the coin toss during the warm-up',
      ),
      h2('Duty'),
      p(
        'Teams referee each other’s matches. A duty team needs **five people**: 1st referee, 2nd referee, scorer and two line judges. You’ll see your duties in the fixtures.',
      ),
      h2('Match schedule (8–10pm nights)'),
      h3('First matches, 8:00–9:00pm'),
      ul('8:00–8:05: duty team sets up', '8:05–8:15: warm-up', '8:15–9:00: play'),
      h3('Second matches, 9:00–10:00pm'),
      ul('9:00–9:10: warm-up', '9:10–9:55: play', '9:55–10:00: duty team packs up'),
      h2('Promotion and relegation'),
      p(
        'At the end of a season we may promote the B Division winners to A Division, and move the last-placed A Division team to B Division.',
      ),
    ]),
  },
  {
    path: '/faq',
    wpId: 6266,
    importedTitle: 'FAQ',
    title: 'Frequently asked questions',
    body: body([
      h2('What programs do you offer?'),
      p(
        'Weekly social [mixed leagues](/mixed-leagues), a competitive [Super League](/super-league), and training and development sessions for [adults](/adult-training) and [juniors](/juniors) throughout the year. We welcome beginners and players just starting out.',
      ),
      h2('Can beginners join?'),
      p(
        'Yes. Every program welcomes beginners, and the leagues’ B Division is ideal for new players. [Contact Michael](/contact) if you’d like help choosing a day or program.',
      ),
      h2('Where do you play?'),
      p(
        'In Tempe, Burwood and Five Dock: see [Where we play](/where-we-play). Each league and program page shows its venue, and we post changes on [Instagram](https://www.instagram.com/tempe.volleyball/).',
      ),
      h2('Do I need a team to join?'),
      p('No. Enter on your own and we’ll place you in a team that suits your level.'),
      h2('How do I enrol?'),
      p('Pick a league or program on the [Enrol](/enrol) page and fill in its form. We’ll confirm your spot by email.'),
      h2('Do I need a Volleyball NSW membership?'),
      p(
        `Yes, every player needs at least a recreational membership through our club (USYD). Wait until your spot is confirmed, then [register with Volleyball NSW](${VNSW_REGISTER}).`,
      ),
    ]),
  },
]

// ── Pages made live now (Phase 7) ─────────────────────────────────────────────

/**
 * A kept page whose reviewed draft goes live now, because the live version is broken rather than just dated. Same
 * guard as the proposals (the page as the importer left it); the old version stays in Revisions (restorable).
 */
export type LivePage = {
  path: string
  wpId: number
  importedTitle: string
  title: string
  metaDescription: string
  body: ContentBody
  /** Why it couldn't wait for review, for the audit row and the docs. */
  why: string
}

/**
 * /contact: the old page's embedded "contact form" is really the New Player Google Form (4.7 MB, third-party cookies,
 * Lighthouse best practices 79). The proposal's text plus a real Contact form block replaces it.
 */
export const CONTACT_LIVE: LivePage = {
  path: '/contact',
  wpId: 62,
  importedTitle: 'CONTACT',
  title: 'Contact',
  metaDescription:
    'Contact Tempe Volleyball: send us a message, or email or phone Michael about our leagues, training and junior programs in Sydney.',
  why: 'The embedded Google Form was the New Player form, not a contact form (QA: 4.7 MB and third-party cookies).',
  body: body([
    p('Questions about a league, a program or your enrolment? Send us a message with the form below, or get in touch with Michael:'),
    ul(
      'Email [tempevb@gmail.com](mailto:tempevb@gmail.com) or [m.mouhajer@bigpond.com](mailto:m.mouhajer@bigpond.com)',
      'Phone [0414 911 544](tel:+61414911544)',
    ),
    contactForm({ title: 'Send us a message' }),
    p('Ready to play? Enrol on the [Enrol](/enrol) page.'),
    p('Directions to each venue are on [Where we play](/where-we-play).'),
  ]),
}

export const LIVE_PAGES: LivePage[] = [CONTACT_LIVE]

// ── /enrol intro: a new draft page ────────────────────────────────────────────

export const ENROL_PAGE = {
  path: '/enrol',
  title: 'Enrol',
  metaDescription: 'Enrol in Tempe Volleyball’s social leagues, Super League, training and junior programs in Sydney.',
  body: body([
    p(
      'Pick a league, training session or program below and fill in its form. Leagues take whole teams and individual players: enter on your own and we’ll place you in a team that suits your level.',
    ),
    h2('What happens next'),
    ul(
      'We email you to confirm your spot. If it’s full, you join the waitlist, and we email you if a spot comes up.',
      'Once your spot is confirmed, pay by PayID to 0414 911 544, with your name (or your child’s) as the reference.',
      `Then register with Volleyball NSW if you haven’t already: every player needs at least a recreational membership through our club (USYD). [Register with Volleyball NSW](${VNSW_REGISTER}). Already a member through another club? Choose “Renew” and add USYD to your profile.`,
    ),
    p('Questions? [Contact Michael](/contact).'),
  ]),
}

// ── /privacy: a new draft page (Phase 7) ──────────────────────────────────────

/**
 * The privacy policy, in plain English, for Michael to check and publish (Admin → Pages → Privacy policy). Enrolment
 * collects juniors', guardians' and emergency contacts' details, so the site needs one. Every period here is a
 * setting or a fact of the setup (docs/admin.md §3.7, §3.15); if one changes, change this page too. The footer, the
 * contact form and the enrolment forms link to it once it's published (Settings → Privacy policy).
 */
export const PRIVACY_PAGE = {
  path: '/privacy',
  title: 'Privacy policy',
  metaDescription: 'How Tempe Volleyball collects, uses, stores and deletes your details when you enrol or contact us.',
  body: body([
    p(
      'This page explains what Tempe Volleyball collects when you enrol in a league or program or send us a message, why we need it, who can see it, where it’s kept, how long for, and how to ask us to delete it.',
    ),
    h2('What we collect'),
    ul(
      '**When you enrol:** your name, email address and mobile number, and only what that program’s form asks: for example your year of birth (not your full date of birth), your skill level, your team’s name, and an emergency contact (their name and phone number).',
      '**For juniors:** a parent or guardian fills in the form, and the email address and phone number we keep are the parent’s or guardian’s.',
      '**When you send us a message:** your name, email address, what it’s about, your message, and which page you sent it from.',
      '**Payments:** whether you’ve paid and how (PayID, cash or bank transfer), marked by hand. We never see or keep card or bank details.',
    ),
    h2('Why we need it'),
    ul(
      'To take your enrolment, hold your spot or place you on the waitlist, and put you in a team',
      'To email you about your enrolment, your games, changes to the draw and spots that come up',
      'To contact your emergency contact, or a junior’s parent or guardian, if something happens at a game or session',
      'To reply to your messages',
      'To keep the forms free of spam and abuse',
    ),
    p(
      'We don’t sell your details, use them for advertising, or share them with anyone outside the club except the services below that run the website.',
    ),
    h2('Who can see it'),
    p(
      'Only the club’s organisers with admin access to the website (admins and owners). People who only edit the website’s pages and results can’t see enrolments or messages. Every export of enrolments or messages is recorded.',
    ),
    h2('Where it’s stored'),
    ul(
      '**The website and its database** run on [Cloudflare](https://www.cloudflare.com/privacypolicy/). Cloudflare stores and processes data on its network in Australia and other countries.',
      '**Emails** we send you (confirmations, waitlist offers) go through [Resend](https://resend.com/legal/privacy-policy), which processes them in the United States.',
      '**The spam check** on our forms is Cloudflare Turnstile, which looks at your browser to tell people from bots.',
      '**Visitor statistics:** on the live site, Google Analytics (which uses cookies) and Cloudflare Web Analytics (which doesn’t) count which pages are visited. They see page addresses, never what you type into a form.',
      '**Volleyball NSW membership** is registered directly with Volleyball NSW through Sydney Uni’s portal, under their own privacy policies. We don’t see your membership payment.',
    ),
    h2('How long we keep it'),
    ul(
      '**Enrolments** are kept while we need them to run the season and for the club’s records, until we or you delete them.',
      '**Enrolments that were never confirmed** (the confirmation email wasn’t clicked) are deleted 30 days after they lapse.',
      '**Messages** are deleted 365 days after we’ve dealt with them.',
      '**Copies of the emails we send you** (with your address) are deleted after 30 days.',
      '**Backups:** the database is backed up every night and each backup is kept for 30 days; the database can also be restored to any point in the last 7 days. So after something is deleted, it’s completely gone within 30 days.',
      '**Spam-check counters** keep a scrambled code of your internet address and email address (not the addresses themselves) for an hour or a day.',
    ),
    h2('Seeing, correcting or deleting your details'),
    p(
      'Ask us and we’ll tell you what we hold about you, correct it, or delete it. When we delete an enrolment for good, your details go with it unless you have another enrolment with us. Email [tempevb@gmail.com](mailto:tempevb@gmail.com) or use the [contact form](/contact).',
    ),
    h2('Keeping it safe'),
    p(
      'The website only works over a secure (HTTPS) connection. Your details are never put in web addresses or stored in shared caches, and organisers sign in with a one-time code sent to their email, plus an authenticator app for owners.',
    ),
    h2('Questions or complaints'),
    p(
      'Contact us first at [tempevb@gmail.com](mailto:tempevb@gmail.com). If you’re not happy with our answer, you can contact the [Office of the Australian Information Commissioner](https://www.oaic.gov.au/).',
    ),
    p('If we change how we handle your details, we’ll update this page.'),
  ]),
}

// ── Redirect fixes (Phase 7): old URLs the first import missed ────────────────

/**
 * Old URLs that 404'd or went somewhere vaguer than they should (checked against the old site's sitemaps on
 * 2026-10-19). The importer now writes the same (src/lib/wp-import/routes.ts), so these rows are 'wp-import' ones:
 * written only where the importer's row is missing or still the old target, never over a redirect Michael edited.
 */
export const REDIRECT_FIXES: { from: string; to: string; was: string | null }[] = [
  { from: '/category/uncategorized', to: '/news', was: null },
  { from: '/calendar/this-weeks-fixtures', to: '/leagues/fixtures', was: '/leagues' },
]

// ── Pages archived now (clearly stale), each with a redirect to a page that's live today ──

export type Archive = { path: string; wpId: number; importedTitle: string; to: string }

export const ARCHIVE: Archive[] = [
  { path: '/82-2', wpId: 82, importedTitle: 'ABOUT', to: '/about-tempe-vb' },
  {
    path: '/covid-guidelines-oct-21',
    wpId: 1458,
    importedTitle: 'Tempe VB League Covid-19 Guidelines (updated October 27th, 2021)',
    to: '/rules',
  },
  { path: '/sample-page', wpId: 2, importedTitle: 'Sample Page', to: '/' },
  { path: '/monday-evening-league-2021', wpId: 712, importedTitle: 'Monday Evening League 2021', to: '/mixed-leagues' },
  { path: '/thursday-evening-league-2021', wpId: 710, importedTitle: 'Thursday Evening Winter League 2021', to: '/leagues/tnl' },
  { path: '/juniors-tournament-25-june-2022', wpId: 2313, importedTitle: 'Juniors Tournament 25 June 2022', to: '/juniors' },
  { path: '/juniors-tournament-29-october-2022', wpId: 2700, importedTitle: 'Juniors Tournament 29 October 2022', to: '/juniors' },
  { path: '/tempe-juniors-tournament', wpId: 1802, importedTitle: 'Tempe Volleyball Juniors 1-day Tournament Spring 2022', to: '/juniors' },
  { path: '/juniors-development-sessions-wrap-up', wpId: 2731, importedTitle: 'Juniors Development Sessions Wrap Up', to: '/juniors' },
  {
    path: '/volley-joeys-friday-evening-training-2021',
    wpId: 714,
    importedTitle: 'JUNIOR DEVELOPMENT PROGRAM (JDP) Volleyjoeys Training',
    to: '/juniors',
  },
  {
    path: '/volley-joeys-friday-night-junior-training-booking',
    wpId: 1042,
    importedTitle: 'Junior Development Program (JDP) Volleyjoeys Session Booking',
    to: '/juniors',
  },
  { path: '/thursday-night-casual-training', wpId: 677, importedTitle: 'THURSDAY NIGHT CASUAL TRAINING', to: '/adult-training' },
  {
    path: '/thank-you-for-registering-your-team-in-the-tempe-cup',
    wpId: 666,
    importedTitle: 'Thank you for registering your team in the Tempe Cup',
    to: '/enrol',
  },
  { path: '/thank-you-for-your-interest', wpId: 551, importedTitle: 'Thanks for contacting us!', to: '/contact' },
  // Old enrolment pages (2020–2022). Their redirects to /enrol already exist (ENROL_REDIRECTS, source 'manual').
  { path: '/2021-interest-in-playing', wpId: 614, importedTitle: '2022 Enrolment', to: '/enrol' },
  { path: '/new-player', wpId: 629, importedTitle: 'New Player', to: '/enrol' },
  { path: '/new-team-group', wpId: 624, importedTitle: 'New Team/Group', to: '/enrol' },
  { path: '/returning-player', wpId: 632, importedTitle: 'Returning Player', to: '/enrol' },
  { path: '/returning-team', wpId: 598, importedTitle: 'Returning Team/Group', to: '/enrol' },
]

// ── Redirects waiting for their page to be archived ───────────────────────────

/**
 * Pages that stay published until Michael makes their replacement live. Their redirect rows are written now; a
 * published page wins over a redirect, so each one takes effect the moment its page is archived or unpublished.
 */
export const LATER_REDIRECTS: { from: string; to: string }[] = [
  { from: '/saturday-night-endorsed-league', to: '/leagues/tvsl' },
  { from: '/adult-development-program-adp', to: draftPath(ADP) },
  { from: '/adults-social-training', to: draftPath(SCRIM) },
  { from: '/friday-night-scrimmage', to: draftPath(SCRIM) },
  { from: '/junior-development-program-jdp', to: draftPath(JDP) },
  { from: '/junior-development-program-jdp-volleyjoeys', to: draftPath(JDP) },
  { from: '/tempe-cup-registration', to: draftPath(CUP) },
  { from: '/tempe-volleyball-usyd-junior-rep-team-program', to: draftPath(REP) },
  { from: '/tempe-vb-usyd-junior-rep-team-program-eoi', to: draftPath(REP) },
]
