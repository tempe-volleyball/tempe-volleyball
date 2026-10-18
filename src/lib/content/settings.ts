import type { UserRole } from '../roles'
import { safeHref } from './render'

// Site settings (the site_settings table, one JSON value per key): contact details, PayID, social links, the
// Revolutionise URL and the announcement banner. The public site reads them through readSettings(); the admin
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
  /** Sent and failed emails (with their addresses) are deleted from the outbox after this many days. */
  emailRetentionDays: number
}

/** Sign-in security (owners only). */
export type SecuritySettings = {
  /**
   * How many days "Trust this device" skips the authenticator code after an email code or link sign-in, counted
   * from when the code was entered (not extended by later sign-ins). 0 turns trusted devices off.
   */
  trustDeviceDays: number
}

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
  enrolment: { confirmHours: 24, emailRetentionDays: 30 },
  security: { trustDeviceDays: 30 },
}

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
    }
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
