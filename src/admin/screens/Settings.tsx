import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  MAX_FOOTER_LINKS,
  MAX_TRUST_DEVICE_DAYS,
  type LadderPlacement,
  type LinkSetting,
  type SettingKey,
  type SiteSettings,
} from '../../lib/content/settings'
import { atLeast, type UserRole } from '../../lib/roles'
import { api, type Me, type PurgeResult } from '../api'
import { ImageField } from '../media/MediaLibrary'
import { useUnsavedWarning } from '../unsaved'
import { LoadError, Skeleton, toast, Button, Card, Field, Notice, Select, TextArea, errorMessage, purgeNote } from '../ui'

// Site settings: contact details, announcement banner, the home page hero, where the ladders go, the footer links,
// social links, PayID, the Revolutionise link, enrolment and email housekeeping, the contact form, the privacy page
// and analytics. Each card saves its own key; PayID, Revolutionise, enrolment, the contact form and analytics are
// admin+ (the server checks too).

type Data = { settings: SiteSettings; minRole: Record<SettingKey, UserRole> }

function Section<K extends SettingKey>({
  me,
  data,
  k,
  title,
  intro,
  onSaved,
  children,
}: {
  me: Me
  data: Data
  k: K
  title: string
  intro?: string
  onSaved: (d: Data) => void
  children: (value: SiteSettings[K], set: (v: SiteSettings[K]) => void, disabled: boolean) => ReactNode
}) {
  const [value, setValue] = useState<SiteSettings[K]>(data.settings[k])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const allowed = atLeast(me.user.role, data.minRole[k])
  const dirty = JSON.stringify(value) !== JSON.stringify(data.settings[k])
  useUnsavedWarning(dirty)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api<Data & { cache: PurgeResult }>('/api/admin/settings', { method: 'PUT', body: { [k]: value } })
      setValue(r.settings[k])
      onSaved(r)
      toast(`${title}: saved.${purgeNote(r.cache)}`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={title} id={`settings-${k}`}>
      <form className="space-y-4" onSubmit={(e) => void submit(e)}>
        {intro && <p className="text-sm text-black/70">{intro}</p>}
        {!allowed && <Notice kind="info">Only {data.minRole[k]}s and owners can change this.</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        <fieldset disabled={!allowed} className="space-y-4">
          {children(value, setValue, !allowed)}
        </fieldset>
        {allowed && (
          <Button type="submit" busy={busy} disabled={!dirty}>
            Save
          </Button>
        )}
      </form>
    </Card>
  )
}

const SECTIONS: [SettingKey, string][] = [
  ['announcement', 'Banner'],
  ['home', 'Home page'],
  ['ladders', 'Ladders'],
  ['footer', 'Footer'],
  ['contact', 'Contact'],
  ['social', 'Social links'],
  ['seo', 'Search and sharing'],
  ['payid', 'PayID'],
  ['revolutioniseUrl', 'Membership'],
  ['enrolment', 'Enrolment and email'],
  ['contactForm', 'Contact form'],
  ['privacy', 'Privacy policy'],
  ['security', 'Sign-in security'],
  ['analytics', 'Analytics'],
]

const pad = (n: number) => String(n).padStart(2, '0')

/** Text and link of one button or footer link (both, or neither). */
function LinkFields({ label, value, onChange }: { label: string; value: LinkSetting; onChange: (v: LinkSetting) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={`${label}: text`} maxLength={60} value={value.label} onChange={(e) => onChange({ ...value, label: e.target.value })} />
      <Field
        label={`${label}: link`}
        placeholder="/enrol or https://…"
        value={value.url}
        onChange={(e) => onChange({ ...value, url: e.target.value })}
      />
    </div>
  )
}

/** The footer's Explore links: edit, reorder, remove, add. */
function FooterLinks({ links, onChange }: { links: LinkSetting[]; onChange: (v: LinkSetting[]) => void }) {
  const move = (i: number, by: number) => {
    const next = [...links]
    const [item] = next.splice(i, 1)
    if (item) next.splice(i + by, 0, item)
    onChange(next)
  }
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-semibold">Explore links</legend>
      <ol className="space-y-2">
        {links.map((l, i) => (
          <li key={i} className="flex flex-wrap items-end gap-2 rounded border border-black/10 p-2">
            <div className="min-w-32 flex-1">
              <Field
                label={`Link ${i + 1} text`}
                maxLength={60}
                value={l.label}
                onChange={(e) => onChange(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
            </div>
            <div className="min-w-40 flex-[2]">
              <Field
                label={`Link ${i + 1} address`}
                placeholder="/news or https://…"
                value={l.url}
                onChange={(e) => onChange(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
              />
            </div>
            <div className="flex gap-1">
              <Button
                variant="secondary"
                className="px-2"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                aria-label={`Move link ${i + 1} up`}
              >
                ↑
              </Button>
              <Button
                variant="secondary"
                className="px-2"
                disabled={i === links.length - 1}
                onClick={() => move(i, 1)}
                aria-label={`Move link ${i + 1} down`}
              >
                ↓
              </Button>
              <Button
                variant="danger"
                className="px-2"
                onClick={() => onChange(links.filter((_, j) => j !== i))}
                aria-label={`Remove link ${i + 1}`}
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ol>
      {links.length < MAX_FOOTER_LINKS && (
        <Button variant="secondary" onClick={() => onChange([...links, { label: '', url: '' }])}>
          Add a link
        </Button>
      )}
    </fieldset>
  )
}

/** ISO -> datetime-local value in the browser's zone. */
const toLocal = (iso: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function Settings({ me }: { me: Me }) {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api<Data>('/api/admin/settings')
      .then(setData)
      .catch((e) => setError(errorMessage(e)))
  }, [])
  // Links such as /settings#settings-payid (from the home page) land on that card once it's there.
  const loaded = !!data
  useEffect(() => {
    if (loaded && location.hash.startsWith('#settings-')) document.getElementById(location.hash.slice(1))?.scrollIntoView()
  }, [loaded])
  if (!data) return error ? <LoadError message={error} onRetry={() => location.reload()} /> : <Skeleton />
  const common = { me, data, onSaved: setData }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Site settings</h1>
        {/* A long page on a phone: jump straight to a card (also the targets of the home page's setup links). */}
        <nav aria-label="Settings sections" className="mt-2 flex flex-wrap gap-x-1 gap-y-1 text-sm">
          {SECTIONS.map(([k, label]) => (
            <a key={k} href={`#settings-${k}`} className="text-brand rounded px-2 py-1.5 underline underline-offset-2 hover:bg-black/5">
              {label}
            </a>
          ))}
        </nav>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Section
          {...common}
          k="announcement"
          title="Announcement banner"
          intro="A short notice across the top of every page, e.g. a washed-out night."
        >
          {(v, set) => (
            <>
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={v.enabled} onChange={(e) => set({ ...v, enabled: e.target.checked })} /> Show the banner
              </label>
              <TextArea label="Text" rows={2} maxLength={280} value={v.text} onChange={(e) => set({ ...v, text: e.target.value })} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Link (optional)"
                  placeholder="/rules or https://…"
                  value={v.linkUrl}
                  onChange={(e) => set({ ...v, linkUrl: e.target.value })}
                />
                <Field label="Link text" maxLength={60} value={v.linkLabel} onChange={(e) => set({ ...v, linkLabel: e.target.value })} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Select label="Style" value={v.tone} onChange={(e) => set({ ...v, tone: e.target.value as 'info' | 'warning' })}>
                  <option value="info">Information (blue)</option>
                  <option value="warning">Warning (amber)</option>
                </Select>
                <Field
                  label="Hide after (optional)"
                  type="datetime-local"
                  value={toLocal(v.endsAt)}
                  onChange={(e) => set({ ...v, endsAt: e.target.value ? new Date(e.target.value).toISOString() : '' })}
                />
              </div>
            </>
          )}
        </Section>

        <Section
          {...common}
          k="home"
          title="Home page"
          intro="The big heading over the photo on the home page, a line or two on what Tempe Volleyball is and how to join, and up to two buttons. The home page's own text (Pages → Home) follows underneath."
        >
          {(v, set) => (
            <>
              <Field
                label="Heading"
                maxLength={90}
                value={v.heading}
                hint="Leave empty to use the home page's title."
                onChange={(e) => set({ ...v, heading: e.target.value })}
              />
              <TextArea label="Intro" rows={3} maxLength={400} value={v.intro} onChange={(e) => set({ ...v, intro: e.target.value })} />
              <LinkFields label="Amber button" value={v.primary} onChange={(primary) => set({ ...v, primary })} />
              <LinkFields label="Second button" value={v.secondary} onChange={(secondary) => set({ ...v, secondary })} />
              <p className="text-xs text-black/60">Leave a button's text and link empty to hide it.</p>
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={v.showLeagues} onChange={(e) => set({ ...v, showLeagues: e.target.checked })} /> Show
                “Leagues this season” (each league's night, fixtures and ladder) under the heading
              </label>
            </>
          )}
        </Section>

        <Section
          {...common}
          k="ladders"
          title="Ladder widgets"
          intro="The small top-of-the-ladder tables for every league. League pages always show their full ladder; this is about the widgets on other pages."
        >
          {(v, set) => (
            <>
              <Select
                label="Show them"
                value={v.placement}
                onChange={(e) => set({ ...v, placement: e.target.value as LadderPlacement })}
                hint="Beside the content: on the home page, content pages, news and the league list; the footer then just links each ladder. In the footer: on every page, and no sidebar."
              >
                <option value="sidebar">Beside the content</option>
                <option value="footer">In the footer</option>
                <option value="off">Nowhere (league pages only)</option>
              </Select>
              <Field
                label="Teams in each"
                type="number"
                min={1}
                max={12}
                value={v.rows}
                hint="The top teams shown. Default 4."
                onChange={(e) => set({ ...v, rows: Number(e.target.value) })}
              />
            </>
          )}
        </Section>

        <Section
          {...common}
          k="footer"
          title="Footer"
          intro="The line under the logo and the Explore links at the foot of every page. Contact details, social links and venues fill the rest by themselves."
        >
          {(v, set) => (
            <>
              <TextArea
                label="Line about the club"
                rows={2}
                maxLength={200}
                value={v.blurb}
                onChange={(e) => set({ ...v, blurb: e.target.value })}
              />
              <FooterLinks links={v.links} onChange={(links) => set({ ...v, links })} />
            </>
          )}
        </Section>

        <Section {...common} k="contact" title="Contact details" intro="Shown in the footer and on the contact page.">
          {(v, set) => (
            <>
              <Field label="Name" maxLength={80} value={v.name} onChange={(e) => set({ ...v, name: e.target.value })} />
              <Field label="Phone" type="tel" maxLength={30} value={v.phone} onChange={(e) => set({ ...v, phone: e.target.value })} />
              <Field label="Email" type="email" maxLength={254} value={v.email} onChange={(e) => set({ ...v, email: e.target.value })} />
            </>
          )}
        </Section>

        <Section {...common} k="social" title="Social links">
          {(v, set) => (
            <>
              <Field
                label="Instagram"
                type="url"
                placeholder="https://www.instagram.com/…"
                value={v.instagram}
                onChange={(e) => set({ ...v, instagram: e.target.value })}
              />
              <Field
                label="Facebook"
                type="url"
                placeholder="https://www.facebook.com/…"
                value={v.facebook}
                onChange={(e) => set({ ...v, facebook: e.target.value })}
              />
            </>
          )}
        </Section>

        <Section
          {...common}
          k="seo"
          title="Search and sharing"
          intro="Defaults for what Google and link previews show. Each page, post, programme and category can set its own title, description and image; these fill the gaps."
        >
          {(v, set) => (
            <>
              <TextArea
                label="Default description"
                rows={3}
                maxLength={300}
                value={v.description}
                placeholder="Social mixed volleyball leagues, junior and adult development programs and training in Tempe, Burwood and Five Dock, Sydney."
                onChange={(e) => set({ ...v, description: e.target.value })}
                hint="Used by pages with no description and no text of their own, and to describe the club to search engines."
              />
              <ImageField
                label="Default social image"
                mediaId={v.imageId || null}
                onChange={(id) => set({ ...v, imageId: id ?? '' })}
                hint="Shown when a page without its own image is shared. Best at 1200 × 630 px. Empty = the built-in photo with the logo."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Other name"
                  maxLength={80}
                  value={v.alternateName}
                  onChange={(e) => set({ ...v, alternateName: e.target.value })}
                  hint="What people also call the club, e.g. Tempe VB."
                />
                <Field
                  label="Year founded"
                  inputMode="numeric"
                  maxLength={4}
                  value={v.foundingYear}
                  onChange={(e) => set({ ...v, foundingYear: e.target.value })}
                />
              </div>
              <TextArea
                label="Other profiles (one link per line)"
                rows={3}
                value={v.sameAs.join('\n')}
                placeholder="https://www.youtube.com/@…"
                onChange={(e) => set({ ...v, sameAs: e.target.value.split('\n') })}
                hint="Links search engines can use to recognise the club, beyond Instagram and Facebook above. Up to 10."
              />
            </>
          )}
        </Section>

        <Section
          {...common}
          k="payid"
          title="PayID"
          intro="Shown to players who choose to pay by PayID. Check it carefully: this is where the money goes."
        >
          {(v, set) => (
            <>
              <Field
                label="PayID (email, mobile or ABN)"
                maxLength={254}
                value={v.payId}
                onChange={(e) => set({ ...v, payId: e.target.value })}
              />
              <Field label="Account name" maxLength={120} value={v.name} onChange={(e) => set({ ...v, name: e.target.value })} />
              <TextArea
                label="Instructions"
                rows={3}
                maxLength={500}
                value={v.instructions}
                onChange={(e) => set({ ...v, instructions: e.target.value })}
              />
            </>
          )}
        </Section>

        <Section
          {...common}
          k="revolutioniseUrl"
          title="Volleyball NSW membership"
          intro="The Revolutionise (Sydney Uni) sign-up link that registration forms point players to."
        >
          {(v, set) => (
            <Field label="Revolutionise link" type="url" placeholder="https://…" value={v} onChange={(e) => set(e.target.value)} />
          )}
        </Section>

        <Section
          {...common}
          k="enrolment"
          title="Enrolment and email"
          intro="Where a programme asks people to confirm their email address before a spot is held, how long the link works. When waitlist offers stop before a session, event or season starts. And how long sent emails (with their addresses) and lapsed unconfirmed entries are kept before they're deleted."
        >
          {(v, set) => (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Hours to confirm an email address"
                type="number"
                min={1}
                max={168}
                value={v.confirmHours}
                hint="Unconfirmed entries expire after this. Default 24."
                onChange={(e) => set({ ...v, confirmHours: Number(e.target.value) })}
              />
              <Field
                label="Days to keep sent emails"
                type="number"
                min={1}
                max={365}
                value={v.emailRetentionDays}
                hint="Default 30. Also how long lapsed unconfirmed entries are kept. Queued emails are always kept."
                onChange={(e) => set({ ...v, emailRetentionDays: Number(e.target.value) })}
              />
              <Field
                label="Hours before the start that waitlist offers stop"
                type="number"
                min={0}
                max={168}
                value={v.offerCutoffHours}
                hint="Default 2. An offer is never held past this, and none go out after it. Development terms aren't affected."
                onChange={(e) => set({ ...v, offerCutoffHours: Number(e.target.value) })}
              />
            </div>
          )}
        </Section>

        <Section
          {...common}
          k="contactForm"
          title="Contact form"
          intro="For every Contact form block (Admin → Pages: + Block… → Contact form). Messages are always kept in Admin → Messages, so nothing is lost if an email doesn’t go."
        >
          {(v, set) => <ContactFormFields v={v} set={set} contactEmail={data.settings.contact.email} />}
        </Section>

        <Section
          {...common}
          k="privacy"
          title="Privacy policy"
          intro="The page the footer, the contact form and the enrolment forms link to. They only show the link while a page is published at this path."
        >
          {(v, set) => (
            <Field
              label="Page path"
              value={v.pagePath}
              placeholder="/privacy"
              maxLength={200}
              hint="A page in Admin → Pages. Default /privacy."
              onChange={(e) => set({ ...v, pagePath: e.target.value.trim() })}
            />
          )}
        </Section>

        <Section
          {...common}
          k="security"
          title="Sign-in security"
          intro="After an email code or link, people with an authenticator app can tick “Trust this device” so that browser skips the app's code for a while. The time counts from when the code was entered; later sign-ins don't extend it."
        >
          {(v, set) => (
            <Field
              label="Days to trust a device"
              type="number"
              min={0}
              max={MAX_TRUST_DEVICE_DAYS}
              value={v.trustDeviceDays}
              hint={`0 turns trusted devices off (every sign-in asks for the code). At most ${MAX_TRUST_DEVICE_DAYS}. A shorter period applies to devices already trusted.`}
              onChange={(e) => set({ ...v, trustDeviceDays: Number(e.target.value) })}
            />
          )}
        </Section>
      </div>

      <Section
        {...common}
        k="analytics"
        title="Analytics"
        intro="Tags on the live site and where the Stats page reads its numbers from. Tags only appear on www.tempevb.com in production. The API keys are Worker secrets, set by whoever runs the Cloudflare account (docs/admin.md §2)."
      >
        {(v, set) => (
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="space-y-4">
              <h3 className="font-bold">Google Analytics</h3>
              <Field
                label="Measurement ID (tag)"
                placeholder="GT-XXXXXXX or G-XXXXXXX"
                value={v.ga4MeasurementId}
                hint="Empty = no Google tag. GT-PLFFMCMT is the old site's tag."
                onChange={(e) => set({ ...v, ga4MeasurementId: e.target.value.trim() })}
              />
              <Select
                label="Load the tag"
                value={v.tagLoading}
                hint="Later loading keeps pages fast; 'straight away' counts every visit but costs some speed."
                onChange={(e) => set({ ...v, tagLoading: e.target.value as typeof v.tagLoading })}
              >
                <option value="interaction">On first scroll, tap or key (or after 15 s)</option>
                <option value="idle">When the page has finished loading</option>
                <option value="eager">Straight away</option>
              </Select>
              <Field
                label="Property ID (for Stats)"
                inputMode="numeric"
                placeholder="312345678"
                value={v.ga4PropertyId}
                hint="GA4 → Admin → Property details."
                onChange={(e) => set({ ...v, ga4PropertyId: e.target.value.trim() })}
              />
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={v.fetch.ga4}
                  onChange={(e) => set({ ...v, fetch: { ...v.fetch, ga4: e.target.checked } })}
                />{' '}
                Fetch daily numbers
              </label>
            </div>
            <div className="space-y-4">
              <h3 className="font-bold">Search Console</h3>
              <Field
                label="Property"
                placeholder="sc-domain:tempevb.com"
                value={v.searchConsoleSite}
                hint={'Exactly as Search Console shows it: "sc-domain:…" or a URL ending in /.'}
                onChange={(e) => set({ ...v, searchConsoleSite: e.target.value.trim() })}
              />
              <Field
                label="Verification code (optional)"
                placeholder="Paste the google-site-verification meta tag"
                value={v.searchConsoleVerification}
                hint="Only needed if the property isn't verified by DNS."
                onChange={(e) => set({ ...v, searchConsoleVerification: e.target.value })}
              />
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={v.fetch.searchConsole}
                  onChange={(e) => set({ ...v, fetch: { ...v.fetch, searchConsole: e.target.checked } })}
                />{' '}
                Fetch daily numbers
              </label>
            </div>
            <div className="space-y-4">
              <h3 className="font-bold">Cloudflare Web Analytics</h3>
              <Field
                label="Beacon token (tag)"
                placeholder="32 letters and digits"
                value={v.cfBeaconToken}
                hint="From the site's manual JS snippet. Empty = no beacon."
                onChange={(e) => set({ ...v, cfBeaconToken: e.target.value.trim() })}
              />
              <Field label="Account ID" value={v.cfAccountId} onChange={(e) => set({ ...v, cfAccountId: e.target.value.trim() })} />
              <Field
                label="Site tag (for Stats)"
                value={v.cfSiteTag}
                hint="Web Analytics → the site → its URL's siteTag."
                onChange={(e) => set({ ...v, cfSiteTag: e.target.value.trim() })}
              />
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={v.fetch.cloudflare}
                  onChange={(e) => set({ ...v, fetch: { ...v.fetch, cloudflare: e.target.checked } })}
                />{' '}
                Fetch daily numbers
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:col-span-3">
              <Field
                label="Days to fetch the first time"
                type="number"
                min={1}
                max={480}
                value={v.backfillDays}
                hint="Search Console keeps 16 months, Cloudflare 6."
                onChange={(e) => set({ ...v, backfillDays: Number(e.target.value) })}
              />
              <Field
                label="Days of history to keep"
                type="number"
                min={30}
                max={3650}
                value={v.retentionDays}
                onChange={(e) => set({ ...v, retentionDays: Number(e.target.value) })}
              />
            </div>
          </div>
        )}
      </Section>
    </div>
  )
}

/** One item per line <-> a list (blank lines dropped on save; kept while typing so Enter works). */
const lines = (list: readonly string[]) => list.join('\n')
const fromLines = (text: string) => text.split('\n').map((l) => l.trim())

function ContactFormFields({
  v,
  set,
  contactEmail,
}: {
  v: SiteSettings['contactForm']
  set: (v: SiteSettings['contactForm']) => void
  contactEmail: string
}) {
  // The text areas keep what's typed (blank lines too, while typing); the setting gets the tidied list.
  const [topics, setTopics] = useState(lines(v.topics))
  const [emails, setEmails] = useState(lines(v.notifyEmails))
  return (
    <>
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={v.enabled} onChange={(e) => set({ ...v, enabled: e.target.checked })} /> Take messages
      </label>
      <p className="-mt-2 text-xs text-black/60">Off: the forms show the contact details instead.</p>
      <TextArea
        label="Topics (one per line)"
        rows={5}
        value={topics}
        hint="What “What is it about?” offers, in this order. Leave empty to not ask. A block can start on one of them."
        onChange={(e) => {
          setTopics(e.target.value)
          set({ ...v, topics: fromLines(e.target.value).filter(Boolean) })
        }}
      />
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={v.notify} onChange={(e) => set({ ...v, notify: e.target.checked })} /> Email me about new messages
      </label>
      <TextArea
        label="Send them to (one address per line)"
        rows={2}
        value={emails}
        placeholder={contactEmail}
        hint={`Empty = the contact email (${contactEmail || 'not set'}). Up to 5. Replying to the email replies to the sender.`}
        onChange={(e) => {
          setEmails(e.target.value)
          set({ ...v, notifyEmails: fromLines(e.target.value).filter(Boolean) })
        }}
      />
      <Field
        label="Notification emails a day, at most"
        type="number"
        min={1}
        max={50}
        value={v.notifyPerDay}
        hint="Default 20. Keeps a burst of spam from using up the day’s emails; later messages still arrive in Admin → Messages."
        onChange={(e) => set({ ...v, notifyPerDay: Number(e.target.value) })}
      />
      <TextArea
        label="Thank-you text on the page"
        rows={2}
        maxLength={1000}
        value={v.successText}
        onChange={(e) => set({ ...v, successText: e.target.value })}
      />
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={v.autoReply} onChange={(e) => set({ ...v, autoReply: e.target.checked })} /> Send an automatic reply
      </label>
      <p className="-mt-2 text-xs text-black/60">
        Off by default: anyone can type any address into the form, so an automatic reply is email to someone who may not have asked for it.
      </p>
      {v.autoReply && (
        <TextArea
          label="Automatic reply"
          rows={3}
          maxLength={1000}
          value={v.autoReplyText}
          hint="Their name and a copy of their message are added."
          onChange={(e) => set({ ...v, autoReplyText: e.target.value })}
        />
      )}
      <Field
        label="Days to keep handled messages"
        type="number"
        min={30}
        max={3650}
        value={v.retentionDays}
        hint="Default 365. Counted from when a message is marked handled; open messages are kept."
        onChange={(e) => set({ ...v, retentionDays: Number(e.target.value) })}
      />
    </>
  )
}
