import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { SettingKey, SiteSettings } from '../../lib/content/settings'
import { atLeast, type UserRole } from '../../lib/roles'
import { api, type Me, type PurgeResult } from '../api'
import { Button, Card, Field, Notice, Select, TextArea, errorMessage, purgeNote } from '../ui'

// Site settings: contact details, announcement banner, social links, PayID and the Revolutionise link. Each card
// saves its own key; PayID and Revolutionise are admin+ (the server checks too).

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
  const [message, setMessage] = useState<string | null>(null)
  const allowed = atLeast(me.user.role, data.minRole[k])
  const dirty = JSON.stringify(value) !== JSON.stringify(data.settings[k])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const r = await api<Data & { cache: PurgeResult }>('/api/admin/settings', { method: 'PUT', body: { [k]: value } })
      setValue(r.settings[k])
      onSaved(r)
      setMessage(`Saved.${purgeNote(r.cache)}`)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={title}>
      <form className="space-y-4" onSubmit={(e) => void submit(e)}>
        {intro && <p className="text-sm text-black/70">{intro}</p>}
        {!allowed && <Notice kind="info">Only {data.minRole[k]}s and owners can change this.</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        {message && <Notice kind="success">{message}</Notice>}
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

const pad = (n: number) => String(n).padStart(2, '0')

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
  if (!data) return error ? <Notice kind="error">{error}</Notice> : <p className="text-sm text-black/60">Loading…</p>
  const common = { me, data, onSaved: setData }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Site settings</h1>
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
      </div>
    </div>
  )
}
