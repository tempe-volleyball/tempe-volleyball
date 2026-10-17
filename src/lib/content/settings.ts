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

export type SiteSettings = {
  contact: ContactSettings
  payid: PayIdSettings
  social: SocialSettings
  revolutioniseUrl: string
  announcement: AnnouncementSettings
}

export type SettingKey = keyof SiteSettings
export const settingKeys = ['contact', 'payid', 'social', 'revolutioniseUrl', 'announcement'] as const satisfies readonly SettingKey[]

/** Who may change each key. PayID is where players send money, so it's admin+ like other payment settings. */
export const settingMinRole: Record<SettingKey, UserRole> = {
  contact: 'editor',
  payid: 'admin',
  social: 'editor',
  revolutioniseUrl: 'admin',
  announcement: 'editor',
}

export const DEFAULT_SETTINGS: SiteSettings = {
  contact: { name: 'Michael', phone: '0414 911 544', email: 'tempevb@gmail.com' },
  payid: { name: '', payId: '', instructions: 'Use your registration reference as the payment description.' },
  social: { instagram: 'https://www.instagram.com/tempe.volleyball/', facebook: '' },
  revolutioniseUrl: '',
  announcement: { enabled: false, text: '', linkUrl: '', linkLabel: '', tone: 'info', endsAt: '' },
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
