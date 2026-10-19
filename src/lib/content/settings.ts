import type { UserRole } from '../roles'
import { isMediaId } from './media'
import { safeHref } from './render'

// Site settings (the site_settings table, one JSON value per key): contact details, PayID, social links, the
// Revolutionise URL, the announcement banner, the home page hero, where the ladder widgets go and the footer
// links (docs/public-site.md). The public site reads them through readSettings(); the admin
// edits them through checkSetting(). Missing keys fall back to DEFAULT_SETTINGS (the old site's details).

export type ContactSettings = { name: string; phone: string; email: string }
export type PayIdSettings = { name: string; payId: string; instructions: string }
export type SocialSettings = { instagram: string; facebook: string }
export type AnnouncementSettings = {
  enabled: boolean
  text: string
  linkUrl: string
  linkLabel: string
  tone: 'info' | 'warning'
  /** UTC ISO; hide the banner after this. Empty = no end. */
  endsAt: string
}

/** How the GA4 tag loads (docs/admin.md §2, "Tag loading"). */
export const tagLoadings = ['interaction', 'idle', 'eager'] as const
export type TagLoading = (typeof tagLoadings)[number]

/**
 * Analytics (docs/admin.md §2). Tags are only emitted in production on www.tempevb.com (src/lib/indexing.ts);
 * the API ids say where the daily cron reads from. Secrets (GOOGLE_SERVICE_ACCOUNT_JSON, CF_ANALYTICS_TOKEN) are
 * Worker secrets, never settings.
 */
export type AnalyticsSettings = {
  /** The Google tag on public pages ("G-…" or "GT-…"). Empty = no tag. */
  ga4MeasurementId: string
  tagLoading: TagLoading
  /** The GA4 property's numeric id, for the Data API. */
  ga4PropertyId: string
  /** Cloudflare Web Analytics beacon token (the site's "JS snippet" token). Empty = no beacon. */
  cfBeaconToken: string
  /** Cloudflare account id and the Web Analytics site tag, for the GraphQL API. */
  cfAccountId: string
  cfSiteTag: string
  /** "sc-domain:tempevb.com" or "https://www.tempevb.com/" (exactly as Search Console names the property). */
  searchConsoleSite: string
  /** Optional google-site-verification meta content (the property is meant to be verified by DNS TXT). */
  searchConsoleVerification: string
  /** Per-source switch for the daily fetch (on, but it only runs once the source is configured). */
  fetch: { ga4: boolean; searchConsole: boolean; cloudflare: boolean }
  /** How many days the first fetch of a source goes back. */
  backfillDays: number
  /** Daily rows older than this are pruned. */
  retentionDays: number
}

/** Enrolment and email housekeeping (docs/admin.md §3.7). */
export type EnrolmentSettings = {
  /** How long someone has to click the confirm link before an unconfirmed entry expires (hours). */
  confirmHours: number
  /**
   * Sent and failed emails (with their addresses) are deleted from the outbox after this many days, and so are
   * unconfirmed entries that lapsed or were replaced (with their player row when nothing else uses it).
   */
  emailRetentionDays: number
  /**
   * Waitlist offers stop this many hours before the session, event or season's first game starts: an offer's hold
   * never runs past that point, and once it has passed no new offers go out (the admin can still confirm by hand).
   */
  offerCutoffHours: number
}

/**
 * The contact form (docs/admin.md §3.15): its topics, who is told about new messages, the optional automatic reply
 * to the sender, and how long handled messages are kept.
 */
/** Off, asked but optional, or required: each team member detail on the EOI form (docs/interest.md). */
export const memberFieldModes = ['off', 'optional', 'required'] as const
export type MemberFieldMode = (typeof memberFieldModes)[number]
export const memberDetailKeys = ['email', 'phone', 'gender', 'birthYear', 'vnswNumber'] as const
export type MemberDetailKey = (typeof memberDetailKeys)[number]

/** Expressions of interest (docs/interest.md): the EOI form at /interest and the Admin → Interest inbox. */
export type InterestSettings = {
  /** The enrolment form whose questions the EOI form asks. Empty = the built-in default (defaultInterestFields). */
  formId: string
  /** The most programmes one EOI can pick. 0 = no limit. */
  maxProgrammes: number
  /** The most people on a team EOI, counting the captain (1 = just the captain). */
  maxMembers: number
  /** Which details are asked for each team member besides the captain (first and last name always are). */
  memberFields: Record<MemberDetailKey, MemberFieldMode>
  /** Email the person (or captain) what they sent, with its reference. */
  acknowledge: boolean
  /** Email the contact address (and notifyEmails) about each EOI. */
  notify: boolean
  notifyEmails: string[]
  /** At most this many notification emails a day (one per address; a rolling 24 hours), so a burst of spam can't use up the day's emails. */
  notifyPerDay: number
  /** The form's intro and the thank-you line shown after sending. */
  introText: string
  successText: string
  /** Days to keep archived EOIs before the cron deletes them. 0 = keep. */
  archivedRetentionDays: number
}

export type ContactFormSettings = {
  /** Off: Contact form blocks show the contact details instead of the form, and the API refuses messages. */
  enabled: boolean
  /** What the "About" choice offers, in this order. Empty = no topic question. */
  topics: string[]
  /** Email each new message to the notification addresses. */
  notify: boolean
  /** Where new messages are emailed. Empty = Settings → Contact details' email. */
  notifyEmails: string[]
  /**
   * At most this many notification emails a day (one per address; a rolling 24 hours), so a burst of spam can't use up the day's emails; messages
   * past it are still saved and counted on the admin home page.
   */
  notifyPerDay: number
  /** Send the sender an automatic "we got your message" email (off by default: it's mail to an unconfirmed address). */
  autoReply: boolean
  /** The automatic reply's text (plain text; the sender's name and a copy of their message are added). */
  autoReplyText: string
  /** What the form says once a message is sent. */
  successText: string
  /** Handled messages are deleted this many days after they were marked handled. Unhandled ones are kept. */
  retentionDays: number
}

/** Where the privacy policy lives. Forms and the footer link to it only while a page is published there. */
export type PrivacySettings = { pagePath: string }

/** Sign-in security (owners only). */
export type SecuritySettings = {
  /**
   * How many days "Trust this device" skips the authenticator code after an email code or link sign-in, counted
   * from when the code was entered (not extended by later sign-ins). 0 turns trusted devices off.
   */
  trustDeviceDays: number
}

/**
 * Search and sharing (docs/public-site.md "SEO"): the site-wide defaults behind every page's meta tags and the
 * organisation's JSON-LD. Per-page titles, descriptions and images are set on the page, post, programme or category.
 */
export type SeoSettings = {
  /** The meta description of pages with nothing better to say (no field, no body text). Empty = the built-in one. */
  description: string
  /** The default social-sharing image (a media id). Empty = the built-in /images/og-default.jpg. */
  imageId: string
  /** The organisation's other names ("Tempe VB"), for search engines. */
  alternateName: string
  /** The year Tempe Volleyball started (JSON-LD foundingDate). Empty = left out. */
  foundingYear: string
  /** More profiles of the club (https URLs) for JSON-LD sameAs; Instagram and Facebook come from Social links. */
  sameAs: string[]
}

/** A labelled link set in the admin (home page buttons, footer links). Empty label or URL = not shown. */
export type LinkSetting = { label: string; url: string }

/**
 * The home page's hero (docs/public-site.md, "Home page"): the H1 over the photo, a sentence or two on what Tempe
 * Volleyball is and how to join, and up to two buttons. An empty heading uses the home page's own title.
 */
export type HomeSettings = {
  heading: string
  intro: string
  primary: LinkSetting
  secondary: LinkSetting
  /** The "Leagues this season" cards under the hero (each league's night, place, fixtures and ladder links). */
  showLeagues: boolean
}

/** Where the league ladder widgets go (docs/public-site.md, "Ladders"). */
export const ladderPlacements = ['sidebar', 'footer', 'off'] as const
export type LadderPlacement = (typeof ladderPlacements)[number]
export type LadderSettings = {
  /**
   * sidebar: beside the content of the home page, content pages, news and the league list (the footer then just
   * links each ladder); footer: across the footer on every page instead; off: neither (league pages still have
   * their full ladders).
   */
  placement: LadderPlacement
  /** Teams shown in each widget (the top N). */
  rows: number
}

/** The footer: a line about the club under the logo, and the "Explore" links. */
export type FooterSettings = { blurb: string; links: LinkSetting[] }

export const MAX_FOOTER_LINKS = 16

/** The longest a device can be trusted (the trust cookie's own lifetime). */
export const MAX_TRUST_DEVICE_DAYS = 90

export type SiteSettings = {
  contact: ContactSettings
  payid: PayIdSettings
  social: SocialSettings
  revolutioniseUrl: string
  announcement: AnnouncementSettings
  analytics: AnalyticsSettings
  enrolment: EnrolmentSettings
  security: SecuritySettings
  contactForm: ContactFormSettings
  interest: InterestSettings
  privacy: PrivacySettings
  seo: SeoSettings
  home: HomeSettings
  ladders: LadderSettings
  footer: FooterSettings
}

export type SettingKey = keyof SiteSettings
export const settingKeys = [
  'contact',
  'payid',
  'social',
  'revolutioniseUrl',
  'announcement',
  'analytics',
  'enrolment',
  'security',
  'contactForm',
  'interest',
  'privacy',
  'seo',
  'home',
  'ladders',
  'footer',
] as const satisfies readonly SettingKey[]

/** Who may change each key. PayID is where players send money, so it's admin+ like other payment settings. */
export const settingMinRole: Record<SettingKey, UserRole> = {
  contact: 'editor',
  payid: 'admin',
  social: 'editor',
  revolutioniseUrl: 'admin',
  announcement: 'editor',
  analytics: 'admin',
  enrolment: 'admin',
  security: 'owner',
  // Where messages (personal data) are emailed and how long they're kept.
  contactForm: 'admin',
  // Where EOIs (personal data) are emailed and how long they're kept.
  interest: 'admin',
  privacy: 'editor',
  seo: 'editor',
  home: 'editor',
  ladders: 'editor',
  footer: 'editor',
}

/** Keys the public site never reads, so saving them doesn't purge the edge cache. */
export const privateSettingKeys: readonly SettingKey[] = ['security']

export const DEFAULT_SETTINGS: SiteSettings = {
  contact: { name: 'Michael', phone: '0414 911 544', email: 'tempevb@gmail.com' },
  payid: { name: '', payId: '', instructions: 'Use your registration reference as the payment description.' },
  social: { instagram: 'https://www.instagram.com/tempe.volleyball/', facebook: '' },
  revolutioniseUrl: '',
  announcement: { enabled: false, text: '', linkUrl: '', linkLabel: '', tone: 'info', endsAt: '' },
  analytics: {
    // The old site's Google tag (Site Kit), so GA4's history carries on.
    ga4MeasurementId: 'GT-PLFFMCMT',
    tagLoading: 'interaction',
    ga4PropertyId: '',
    cfBeaconToken: '',
    cfAccountId: '',
    cfSiteTag: '',
    searchConsoleSite: '',
    searchConsoleVerification: '',
    fetch: { ga4: true, searchConsole: true, cloudflare: true },
    backfillDays: 90,
    retentionDays: 1095,
  },
  enrolment: { confirmHours: 24, emailRetentionDays: 30, offerCutoffHours: 2 },
  security: { trustDeviceDays: 30 },
  contactForm: {
    enabled: true,
    topics: ['General', 'Leagues', 'Juniors', 'Training', 'Teams looking for players'],
    notify: true,
    notifyEmails: [],
    notifyPerDay: 20,
    autoReply: false,
    autoReplyText: 'Thanks for getting in touch. We read every message and will reply as soon as we can, usually within a few days.',
    successText: 'Thanks, your message has been sent. We’ll reply by email, usually within a few days.',
    retentionDays: 365,
  },
  interest: {
    formId: '',
    maxProgrammes: 0,
    maxMembers: 8,
    memberFields: { email: 'optional', phone: 'optional', gender: 'optional', birthYear: 'off', vnswNumber: 'optional' },
    acknowledge: true,
    notify: true,
    notifyEmails: [],
    notifyPerDay: 30,
    introText:
      'Tell us you’re interested and we’ll be in touch before the next season starts. Come on your own and we’ll find you a team, or enter a whole team.',
    successText: 'Thanks, we’ve got your details. We’ll be in touch before the next season starts.',
    archivedRetentionDays: 365,
  },
  privacy: { pagePath: '/privacy' },
  seo: { description: '', imageId: '', alternateName: 'Tempe VB', foundingYear: '2005', sameAs: [] },
  home: {
    heading: "Social volleyball in Sydney's inner west",
    intro:
      'Mixed social leagues from Thursday to Sunday, the Super League, and training and development programs for adults and juniors, in Tempe, Burwood and Five Dock. Come on your own or bring a team: every level is welcome.',
    // No buttons and no "Leagues this season" cards by default (2026-10-20); both stay in Settings → Home page.
    primary: { label: '', url: '' },
    secondary: { label: '', url: '' },
    showLeagues: false,
  },
  ladders: { placement: 'sidebar', rows: 4 },
  footer: {
    blurb: 'Social volleyball in Sydney since 2005, with the Sydney Uni Volleyball Club.',
    links: [
      { label: 'Leagues', url: '/leagues' },
      { label: "This week's games", url: '/leagues/fixtures' },
      { label: 'Enrol', url: '/enrol' },
      { label: 'Training', url: '/training' },
      { label: 'Programs', url: '/programs' },
      { label: 'Events', url: '/events' },
      { label: 'News', url: '/news' },
      { label: 'Where we play', url: '/where-we-play' },
      { label: 'Rules', url: '/rules' },
      { label: 'FAQ', url: '/faq' },
      { label: 'Contact', url: '/contact' },
    ],
  },
}

/** Bounds for the contact form settings. */
export const CONTACT_FORM_LIMITS = { topics: 20, topic: 60, notifyEmails: 5, text: 1000 } as const

export const isSettingKey = (k: unknown): k is SettingKey => typeof k === 'string' && (settingKeys as readonly string[]).includes(k)

export type SettingCheck<K extends SettingKey = SettingKey> = { ok: true; value: SiteSettings[K] } | { ok: false; message: string }

class Invalid extends Error {}

const str = (v: unknown, label: string, max: number) => {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new Invalid(`${label} must be text.`)
  const s = v.trim()
  if (s.length > max) throw new Invalid(`${label} is too long (at most ${max} characters).`)
  return s
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^\+?[\d\s()-]{6,20}$/

const email = (v: unknown, label: string) => {
  const s = str(v, label, 254)
  if (s && !EMAIL_RE.test(s)) throw new Invalid(`${label} doesn't look like an email address.`)
  return s.toLowerCase()
}

const httpsUrl = (v: unknown, label: string) => {
  const s = str(v, label, 500)
  if (s && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(s)) throw new Invalid(`${label} must be a full https:// address.`)
  return s
}

const obj = (v: unknown, label: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Invalid(`${label} is malformed.`)
  return v as Record<string, unknown>
}

const pattern = (v: unknown, label: string, max: number, re: RegExp, hint: string) => {
  const s = str(v, label, max)
  if (s && !re.test(s)) throw new Invalid(`${label} ${hint}`)
  return s
}

const intIn = (v: unknown, label: string, min: number, max: number, fallback: number) => {
  if (v === undefined || v === null || v === '') return fallback
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
    throw new Invalid(`${label} must be a whole number from ${min} to ${max}.`)
  return n
}

const upper = (v: unknown) => (typeof v === 'string' ? v.toUpperCase() : v)

const HEX32 = /^[0-9a-f]{32}$/i

/** A link from the admin: label and URL both set (a relative path, https:// or mailto:), or both empty. */
const link = (v: unknown, label: string): LinkSetting => {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const text = str(o.label, `${label} text`, 60)
  const url = str(o.url, `${label} link`, 500)
  if (url && !safeHref(url)) throw new Invalid(`${label}: the link must start with https://, / or mailto:.`)
  if (!!text !== !!url) throw new Invalid(`${label}: give both the text and the link, or leave both empty.`)
  return { label: text, url }
}

const checkers: { [K in SettingKey]: (v: unknown) => SiteSettings[K] } = {
  contact: (v) => {
    const o = obj(v, 'Contact details')
    const phone = str(o.phone, 'Phone', 30)
    if (phone && !PHONE_RE.test(phone)) throw new Invalid('Phone should be digits, spaces and an optional leading +.')
    return {
      name: str(o.name, 'Contact name', 80),
      phone,
      email: email(o.email, 'Contact email'),
    }
  },
  payid: (v) => {
    const o = obj(v, 'PayID')
    const payId = str(o.payId, 'PayID', 254)
    // A PayID is an email address, a phone number or an ABN.
    if (payId && !EMAIL_RE.test(payId) && !PHONE_RE.test(payId) && !/^\d{2}\s?\d{3}\s?\d{3}\s?\d{3}$/.test(payId))
      throw new Invalid('The PayID should be an email address, a mobile number or an ABN.')
    return { name: str(o.name, 'Account name', 120), payId, instructions: str(o.instructions, 'Payment instructions', 500) }
  },
  social: (v) => {
    const o = obj(v, 'Social links')
    return { instagram: httpsUrl(o.instagram, 'Instagram link'), facebook: httpsUrl(o.facebook, 'Facebook link') }
  },
  revolutioniseUrl: (v) => httpsUrl(v, 'Revolutionise link'),
  announcement: (v) => {
    const o = obj(v, 'Announcement')
    const enabled = o.enabled === true
    const text = str(o.text, 'Announcement text', 280)
    if (enabled && !text) throw new Invalid('Write the announcement text, or turn the banner off.')
    const linkUrl = str(o.linkUrl, 'Announcement link', 500)
    if (linkUrl && !safeHref(linkUrl)) throw new Invalid('The announcement link must start with https://, / or mailto:.')
    const endsAt = str(o.endsAt, 'End time', 40)
    if (endsAt && Number.isNaN(Date.parse(endsAt))) throw new Invalid('The end time is not a valid date.')
    return {
      enabled,
      text,
      linkUrl,
      linkLabel: str(o.linkLabel, 'Link label', 60),
      tone: o.tone === 'warning' ? 'warning' : 'info',
      endsAt: endsAt ? new Date(endsAt).toISOString() : '',
    }
  },
  analytics: (v) => {
    const o = obj(v, 'Analytics')
    const d = DEFAULT_SETTINGS.analytics
    const f = o.fetch && typeof o.fetch === 'object' ? (o.fetch as Record<string, unknown>) : {}
    const searchConsoleSite = str(o.searchConsoleSite, 'Search Console property', 200)
    if (
      searchConsoleSite &&
      !/^sc-domain:[a-z0-9.-]+\.[a-z]{2,}$/i.test(searchConsoleSite) &&
      !/^https?:\/\/[^\s/]+\.[^\s]+\/$/i.test(searchConsoleSite)
    )
      throw new Invalid('The Search Console property is "sc-domain:example.com" or a URL ending in "/", as Search Console shows it.')
    const verification = str(o.searchConsoleVerification, 'Search Console verification', 200)
    // People paste the whole <meta> tag; keep just its content.
    const content = /content=["']([^"']+)["']/i.exec(verification)?.[1] ?? verification
    if (content && !/^[\w-]{10,100}$/.test(content))
      throw new Invalid('The Search Console verification code should be letters, digits, - and _.')
    return {
      ga4MeasurementId: pattern(
        upper(o.ga4MeasurementId),
        'The GA4 measurement ID',
        30,
        /^(G|GT)-[A-Z0-9]{4,20}$/,
        'looks like G-XXXXXXX or GT-XXXXXXX.',
      ),
      tagLoading: tagLoadings.includes(o.tagLoading as TagLoading) ? (o.tagLoading as TagLoading) : d.tagLoading,
      ga4PropertyId: pattern(o.ga4PropertyId, 'The GA4 property ID', 20, /^\d{5,15}$/, 'is a number (GA4 → Admin → Property details).'),
      cfBeaconToken: pattern(o.cfBeaconToken, 'The Web Analytics token', 32, HEX32, 'is 32 letters and digits.').toLowerCase(),
      cfAccountId: pattern(o.cfAccountId, 'The Cloudflare account ID', 32, HEX32, 'is 32 letters and digits.').toLowerCase(),
      cfSiteTag: pattern(o.cfSiteTag, 'The Web Analytics site tag', 32, HEX32, 'is 32 letters and digits.').toLowerCase(),
      searchConsoleSite,
      searchConsoleVerification: content,
      fetch: { ga4: f.ga4 !== false, searchConsole: f.searchConsole !== false, cloudflare: f.cloudflare !== false },
      backfillDays: intIn(o.backfillDays, 'Days to fetch the first time', 1, 480, d.backfillDays),
      retentionDays: intIn(o.retentionDays, 'Days of history to keep', 30, 3650, d.retentionDays),
    }
  },
  enrolment: (v) => {
    const o = obj(v, 'Enrolment')
    const d = DEFAULT_SETTINGS.enrolment
    return {
      confirmHours: intIn(o.confirmHours, 'Hours to confirm an email address', 1, 168, d.confirmHours),
      emailRetentionDays: intIn(o.emailRetentionDays, 'Days to keep sent emails', 1, 365, d.emailRetentionDays),
      offerCutoffHours: intIn(o.offerCutoffHours, 'Hours before the start that waitlist offers stop', 0, 168, d.offerCutoffHours),
    }
  },
  contactForm: (v) => {
    const o = obj(v, 'Contact form')
    const d = DEFAULT_SETTINGS.contactForm
    const L = CONTACT_FORM_LIMITS
    const list = (x: unknown, label: string) => {
      if (x === undefined || x === null) return []
      if (!Array.isArray(x)) throw new Invalid(`${label} must be a list.`)
      return x
    }
    // Trimmed, with repeats (in any case) dropped; the first spelling wins.
    const topics: string[] = []
    for (const raw of list(o.topics, 'Topics')) {
      const t = str(raw, 'A topic', L.topic).replace(/\s+/g, ' ')
      if (t && !topics.some((x) => x.toLowerCase() === t.toLowerCase())) topics.push(t)
    }
    if (topics.length > L.topics) throw new Invalid(`At most ${L.topics} topics.`)
    const notifyEmails = [
      ...new Set(
        list(o.notifyEmails, 'Notification addresses')
          .map((e) => email(e, 'A notification address'))
          .filter(Boolean),
      ),
    ]
    if (notifyEmails.length > L.notifyEmails) throw new Invalid(`At most ${L.notifyEmails} notification addresses.`)
    return {
      enabled: o.enabled !== false,
      topics,
      notify: o.notify !== false,
      notifyEmails,
      notifyPerDay: intIn(o.notifyPerDay, 'Notification emails a day', 1, 50, d.notifyPerDay),
      autoReply: o.autoReply === true,
      autoReplyText: str(o.autoReplyText, 'The automatic reply', L.text) || d.autoReplyText,
      successText: str(o.successText, 'The thank-you text', L.text) || d.successText,
      retentionDays: intIn(o.retentionDays, 'Days to keep handled messages', 30, 3650, d.retentionDays),
    }
  },
  interest: (v) => {
    const o = obj(v, 'Expressions of interest')
    const d = DEFAULT_SETTINGS.interest
    const formId = str(o.formId, 'The form', 64)
    if (formId && !/^[A-Za-z0-9_-]{1,64}$/.test(formId)) throw new Invalid('Pick the form from the list.')
    const mf = o.memberFields && typeof o.memberFields === 'object' ? (o.memberFields as Record<string, unknown>) : {}
    const memberFields = Object.fromEntries(
      memberDetailKeys.map((k) => [
        k,
        memberFieldModes.includes(mf[k] as MemberFieldMode) ? (mf[k] as MemberFieldMode) : d.memberFields[k],
      ]),
    ) as Record<MemberDetailKey, MemberFieldMode>
    if (o.notifyEmails !== undefined && o.notifyEmails !== null && !Array.isArray(o.notifyEmails))
      throw new Invalid('Notification addresses must be a list.')
    const notifyEmails = [
      ...new Set(((o.notifyEmails as unknown[] | undefined) ?? []).map((e) => email(e, 'A notification address')).filter(Boolean)),
    ]
    if (notifyEmails.length > CONTACT_FORM_LIMITS.notifyEmails)
      throw new Invalid(`At most ${CONTACT_FORM_LIMITS.notifyEmails} notification addresses.`)
    return {
      formId,
      maxProgrammes: intIn(o.maxProgrammes, 'Most programmes per entry', 0, 20, d.maxProgrammes),
      maxMembers: intIn(o.maxMembers, 'Most team members', 1, 30, d.maxMembers),
      memberFields,
      acknowledge: o.acknowledge !== false,
      notify: o.notify !== false,
      notifyEmails,
      notifyPerDay: intIn(o.notifyPerDay, 'Notification emails a day', 1, 50, d.notifyPerDay),
      introText: str(o.introText, 'The intro', CONTACT_FORM_LIMITS.text) || d.introText,
      successText: str(o.successText, 'The thank-you text', CONTACT_FORM_LIMITS.text) || d.successText,
      archivedRetentionDays: intIn(o.archivedRetentionDays, 'Days to keep archived EOIs', 0, 3650, d.archivedRetentionDays),
    }
  },
  privacy: (v) => {
    const o = obj(v, 'Privacy policy')
    const path = str(o.pagePath, 'The privacy page', 200) || DEFAULT_SETTINGS.privacy.pagePath
    if (!/^\/[a-z0-9][a-z0-9\-/]*$/.test(path) || path.endsWith('/') || path.includes('//'))
      throw new Invalid('The privacy page is a page path such as /privacy.')
    return { pagePath: path }
  },
  security: (v) => {
    const o = obj(v, 'Security')
    return {
      trustDeviceDays: intIn(
        o.trustDeviceDays,
        'Days to trust a device',
        0,
        MAX_TRUST_DEVICE_DAYS,
        DEFAULT_SETTINGS.security.trustDeviceDays,
      ),
    }
  },
  seo: (v) => {
    const o = obj(v, 'Search and sharing')
    const imageId = str(o.imageId, 'Social image', 64).toLowerCase()
    if (imageId && !isMediaId(imageId)) throw new Invalid('Pick the social image from the media library.')
    const foundingYear = pattern(o.foundingYear, 'The year founded', 4, /^(19|20)\d\d$/, 'is a four-digit year.')
    const list = Array.isArray(o.sameAs) ? o.sameAs : typeof o.sameAs === 'string' ? o.sameAs.split(/\s+/) : []
    if (list.length > 10) throw new Invalid('List at most 10 other profiles.')
    const sameAs = [...new Set(list.map((u) => httpsUrl(u, 'Each other profile')).filter(Boolean))]
    return {
      description: str(o.description, 'Default description', 300),
      imageId,
      alternateName: str(o.alternateName, 'Other name', 80),
      foundingYear,
      sameAs,
    }
  },
  home: (v) => {
    const o = obj(v, 'Home page')
    return {
      heading: str(o.heading, 'Heading', 90),
      intro: str(o.intro, 'Intro', 400),
      primary: link(o.primary, 'First button'),
      secondary: link(o.secondary, 'Second button'),
      showLeagues: o.showLeagues !== false,
    }
  },
  ladders: (v) => {
    const o = obj(v, 'Ladders')
    const d = DEFAULT_SETTINGS.ladders
    return {
      placement: ladderPlacements.includes(o.placement as LadderPlacement) ? (o.placement as LadderPlacement) : d.placement,
      rows: intIn(o.rows, 'Teams in each ladder', 1, 12, d.rows),
    }
  },
  footer: (v) => {
    const o = obj(v, 'Footer')
    if (o.links !== undefined && !Array.isArray(o.links)) throw new Invalid('The footer links are malformed.')
    const links = ((o.links as unknown[] | undefined) ?? []).map((l, i) => link(l, `Footer link ${i + 1}`)).filter((l) => l.url)
    if (links.length > MAX_FOOTER_LINKS) throw new Invalid(`The footer has room for ${MAX_FOOTER_LINKS} links at most.`)
    return { blurb: str(o.blurb, 'Footer text', 200), links }
  },
}

/** Validates and normalises a value for `key`. */
export function checkSetting<K extends SettingKey>(key: K, value: unknown): SettingCheck<K> {
  try {
    return { ok: true, value: checkers[key](value) }
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, message: e.message }
    throw e
  }
}

/** Settings from stored rows, with defaults for missing or unreadable keys (a bad row never breaks the site). */
export function readSettings(rows: readonly { key: string; value: unknown }[]): SiteSettings {
  const out: SiteSettings = structuredClone(DEFAULT_SETTINGS)
  for (const r of rows) {
    if (!isSettingKey(r.key)) continue
    const checked = checkSetting(r.key, r.value)
    if (checked.ok) (out as Record<SettingKey, unknown>)[r.key] = checked.value
  }
  return out
}

/** A tel: link for an Australian number as typed ("0414 911 544" -> "tel:+61414911544"). */
export function telHref(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return `tel:${digits}`
  return `tel:${digits.startsWith('0') ? `+61${digits.slice(1)}` : digits}`
}

/** "tempe.volleyball" from an Instagram profile URL, for link text. */
export function instagramHandle(url: string): string {
  const m = /instagram\.com\/([\w.]+)/i.exec(url)
  return m ? m[1]! : url.replace(/^https?:\/\//, '')
}

/** Is the banner showing at `now`? */
export const announcementActive = (a: AnnouncementSettings, now: Date) =>
  a.enabled && !!a.text && (!a.endsAt || Date.parse(a.endsAt) > now.getTime())
