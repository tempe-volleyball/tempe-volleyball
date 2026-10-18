import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'wouter'
import { checkSlug } from '../../lib/content/paths'
import { generatedSummaryLine, scheduleText } from '../../lib/programme-text'
import { programmePath } from '../../lib/programmes'
import { sydneyToUtc, utcToSydneyInput } from '../../lib/time'
import { api, formatWhen, isConflict, type Me, type Programme, type ProgrammeKind, type ProgrammeView, type PurgeResult } from '../api'
import { RichText } from '../editor/LazyRichText'
import { ImageField } from '../media/MediaLibrary'
import { useUnsavedWarning } from '../screens/Pages'
import { Button, Card, Checkbox, Field, Notice, Select, StatusBadge, TabLinks, TextArea, errorMessage, purgeNote } from '../ui'
import { KINDS, WEEKDAY_NAMES, centsToDollars, dollarsToCents, intOrNull, statusLabel } from './kinds'
import { InstancesTab } from './Schedule'

// One programme: /admin/<kind base>/<id>/<tab>. Details and Enrolment edit the programme row (one Save for both);
// the third tab is the kind's instances (seasons, sessions, terms or dates). Editors can look but not change
// anything here (the server enforces it too).

type Form = {
  name: string
  code: string
  slug: string
  categoryId: string
  weekday: string
  defaultVenueId: string
  format: string
  sort: string
  startTime: string
  endTime: string
  scheduleLabel: string
  /** null = generated ("automatic"). */
  summaryLine: string | null
  moreInfoUrl: string
  menuVisible: boolean
  ageMin: string
  ageMax: string
  seoTitle: string
  seoDescription: string
  imageId: string | null
  enrolmentOpen: boolean
  enrolmentOpensAt: string
  enrolmentClosesAt: string
  nextStartsOn: string
  nextStartsText: string
  enrolmentFormId: string
  capTeams: string
  capPlayers: string
  price: string
  allowTeamEntries: boolean
  allowFreeAgents: boolean
  waitlistEnabled: boolean
  waitlistOfferHours: string
  /** '' = automatic (on when capped), 'true' = always, 'false' = never. */
  enrolmentEmailConfirm: string
}

const str = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v))

const formOf = (p: Programme): Form => ({
  name: p.name,
  code: p.code,
  slug: p.slug,
  categoryId: p.categoryId ?? '',
  weekday: String(p.weekday),
  defaultVenueId: p.defaultVenueId ?? '',
  format: p.format,
  sort: String(p.sort),
  startTime: p.startTime ?? '',
  endTime: p.endTime ?? '',
  scheduleLabel: p.scheduleLabel ?? '',
  summaryLine: p.summaryLine,
  moreInfoUrl: p.moreInfoUrl ?? '',
  menuVisible: p.menuVisible,
  ageMin: str(p.ageMin),
  ageMax: str(p.ageMax),
  seoTitle: p.seoTitle ?? '',
  seoDescription: p.seoDescription ?? '',
  imageId: p.imageId,
  enrolmentOpen: p.enrolmentOpen,
  enrolmentOpensAt: utcToSydneyInput(p.enrolmentOpensAt),
  enrolmentClosesAt: utcToSydneyInput(p.enrolmentClosesAt),
  nextStartsOn: p.nextStartsOn ?? '',
  nextStartsText: p.nextStartsText ?? '',
  enrolmentFormId: p.enrolmentFormId ?? '',
  capTeams: str(p.capTeams),
  capPlayers: str(p.capPlayers),
  price: centsToDollars(p.priceCents),
  allowTeamEntries: p.allowTeamEntries,
  allowFreeAgents: p.allowFreeAgents,
  waitlistEnabled: p.waitlistEnabled,
  waitlistOfferHours: String(p.waitlistOfferHours),
  enrolmentEmailConfirm: p.enrolmentEmailConfirm === null ? '' : String(p.enrolmentEmailConfirm),
})

const orNull = (s: string) => (s.trim() === '' ? null : s.trim())

/** The API body for a form (every field). */
const instant = (s: string) => (s ? (sydneyToUtc(s) ?? s) : null)

function payloadOf(f: Form, kind: ProgrammeKind): Record<string, unknown> {
  return {
    name: f.name,
    code: f.code,
    slug: f.slug,
    categoryId: f.categoryId,
    weekday: Number(f.weekday),
    defaultVenueId: f.defaultVenueId || null,
    ...(kind === 'league' ? { format: f.format } : {}),
    sort: Number(f.sort),
    startTime: f.startTime || null,
    endTime: f.endTime || null,
    scheduleLabel: orNull(f.scheduleLabel),
    summaryLine: f.summaryLine === null ? null : orNull(f.summaryLine),
    moreInfoUrl: orNull(f.moreInfoUrl),
    menuVisible: f.menuVisible,
    ageMin: intOrNull(f.ageMin),
    ageMax: intOrNull(f.ageMax),
    seoTitle: orNull(f.seoTitle),
    seoDescription: orNull(f.seoDescription),
    imageId: f.imageId,
    enrolmentOpen: f.enrolmentOpen,
    enrolmentOpensAt: instant(f.enrolmentOpensAt),
    enrolmentClosesAt: instant(f.enrolmentClosesAt),
    nextStartsOn: f.nextStartsOn || null,
    nextStartsText: orNull(f.nextStartsText),
    enrolmentFormId: f.enrolmentFormId || null,
    capTeams: intOrNull(f.capTeams),
    capPlayers: intOrNull(f.capPlayers),
    priceCents: dollarsToCents(f.price),
    allowTeamEntries: f.allowTeamEntries,
    allowFreeAgents: f.allowFreeAgents,
    waitlistEnabled: f.waitlistEnabled,
    waitlistOfferHours: Number(f.waitlistOfferHours),
    enrolmentEmailConfirm: f.enrolmentEmailConfirm === '' ? null : f.enrolmentEmailConfirm === 'true',
  }
}

/** Only the fields that differ from what was loaded. */
function changedPayload(form: Form, loaded: Form, kind: ProgrammeKind) {
  const a = payloadOf(form, kind)
  const b = payloadOf(loaded, kind)
  return Object.fromEntries(Object.entries(a).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(b[k])))
}

export function ProgrammePage({ me, kind, id, tab: requested }: { me: Me; kind: ProgrammeKind; id: string; tab: string | undefined }) {
  const cfg = KINDS[kind]
  const isAdmin = me.user.role !== 'editor'
  const [, navigate] = useLocation()
  const [view, setView] = useState<ProgrammeView | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [loaded, setLoaded] = useState<Form | null>(null)
  const blocks = useRef<unknown[] | undefined>(undefined)
  const [editorKey, setEditorKey] = useState(0)
  const [descDirty, setDescDirty] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const apply = useCallback((v: ProgrammeView) => {
    setView(v)
    const f = formOf(v.programme)
    setLoaded(f)
    setForm(f)
    blocks.current = undefined
    setDescDirty(false)
    setEditorKey((k) => k + 1)
  }, [])

  const load = useCallback(
    () =>
      api<ProgrammeView>(`/api/admin/programmes/${id}`)
        .then((v) => {
          if (v.programme.kind !== kind) {
            navigate(`${KINDS[v.programme.kind].base}/${id}`, { replace: true })
            return
          }
          apply(v)
        })
        .catch((e) => setLoadError(errorMessage(e))),
    [id, kind, apply, navigate],
  )
  useEffect(() => {
    void load()
  }, [load])

  const changes = useMemo(() => (form && loaded ? changedPayload(form, loaded, kind) : {}), [form, loaded, kind])
  const dirty = Object.keys(changes).length > 0 || descDirty
  useUnsavedWarning(dirty)

  const tabs = [{ key: 'details', label: 'Details' }, { key: 'enrolment', label: 'Enrolment' }, cfg.instancesTab]
  const tab = tabs.some((t) => t.key === requested) ? requested! : 'details'

  if (loadError)
    return (
      <div className="space-y-4">
        <Link href={cfg.base} className="text-brand text-sm underline">
          ← {cfg.title}
        </Link>
        <Notice kind="error">{loadError}</Notice>
      </div>
    )
  if (!view || !form) return <p className="text-sm text-black/60">Loading…</p>

  const p = view.programme
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))
  const ro = !isAdmin

  const save = async (): Promise<boolean> => {
    setError(null)
    setMessage(null)
    const body: Record<string, unknown> = { ...changes, baseUpdatedAt: p.updatedAt }
    if (descDirty && blocks.current !== undefined) body.description = blocks.current
    try {
      const r = await api<ProgrammeView & { cache: PurgeResult }>(`/api/admin/programmes/${id}`, { method: 'PATCH', body })
      apply(r)
      setMessage(`Saved${r.programme.status !== 'draft' ? ' and updated the public site' : ''}.${purgeNote(r.cache)}`)
      return true
    } catch (e) {
      setError(isConflict(e) ? `${errorMessage(e)}` : errorMessage(e))
      return false
    }
  }

  const setStatus = async (status: 'draft' | 'active' | 'retired') => {
    setBusy(status)
    setError(null)
    setMessage(null)
    try {
      if (dirty && !(await save())) return
      const r = await api<ProgrammeView & { cache: PurgeResult }>(`/api/admin/programmes/${id}/status`, { body: { status } })
      apply(r)
      setMessage(
        `${status === 'active' ? (p.status === 'retired' ? 'Reactivated' : 'Now active') : status === 'retired' ? 'Retired' : 'Back to draft'}.${purgeNote(r.cache)}`,
      )
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!window.confirm(`Delete ${p.name}? This can't be undone.`)) return
    setBusy('delete')
    try {
      await api(`/api/admin/programmes/${id}`, { method: 'DELETE' })
      setLoaded(form)
      navigate(cfg.base)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(null)
    }
  }

  const venue = view.choices.venues.find((v) => v.id === form.defaultVenueId) ?? null
  const preview = {
    kind,
    name: form.name,
    code: form.code,
    weekday: Number(form.weekday),
    startTime: form.startTime || null,
    endTime: form.endTime || null,
    scheduleLabel: orNull(form.scheduleLabel),
    summaryLine: null,
    nextStartsOn: form.nextStartsOn || null,
    nextStartsText: orNull(form.nextStartsText),
  }
  const generatedLine = generatedSummaryLine(preview, venue)
  const slugCheck = checkSlug(form.slug)
  const newPath = slugCheck.ok ? programmePath(kind, slugCheck.slug) : null

  return (
    <div>
      <div className="mb-2">
        <Link href={cfg.base} className="text-brand text-sm underline">
          ← {cfg.title}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-2xl font-bold">
            {p.name} <span className="text-base font-semibold text-black/50">{p.code}</span>
          </h1>
          <StatusBadge status={p.status} />
          {p.status !== 'draft' && (
            <a href={view.path} target="_blank" rel="noopener" className="text-brand text-sm underline">
              View public page
            </a>
          )}
          {isAdmin && (
            <span className="ml-auto flex flex-wrap items-center gap-2">
              {dirty && <span className="text-xs text-black/60">Unsaved changes</span>}
              <Button
                busy={busy === 'save'}
                disabled={!!busy || !dirty}
                onClick={async () => {
                  setBusy('save')
                  await save()
                  setBusy(null)
                }}
              >
                Save
              </Button>
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-black/60">{view.generated.shownSummaryLine}</p>
      </div>
      <TabLinks label={cfg.noun} tabs={tabs} active={tab} href={(k) => `${cfg.base}/${id}/${k}`} />
      <div className="mb-4 space-y-3 empty:hidden">
        {error && <Notice kind="error">{error}</Notice>}
        {message && <Notice kind="success">{message}</Notice>}
        {ro && <Notice>Only admins can change programmes. You can look around.</Notice>}
        {!p.categoryId && <Notice kind="warning">Pick a category for this {cfg.noun}: it needs one to go live.</Notice>}
      </div>

      {tab === 'details' && (
        <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
          <fieldset className="min-w-0 space-y-6" disabled={ro}>
            <Card title="Basics">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" required maxLength={120} value={form.name} onChange={(e) => set('name', e.target.value)} />
                <Field
                  label="Code"
                  required
                  maxLength={16}
                  value={form.code}
                  onChange={(e) => set('code', e.target.value.toUpperCase())}
                  hint="Short and unique across all programmes."
                />
                <Field
                  label="URL name"
                  value={form.slug}
                  onChange={(e) => set('slug', e.target.value)}
                  aria-invalid={!slugCheck.ok}
                  hint={
                    !slugCheck.ok
                      ? slugCheck.message
                      : form.slug !== p.slug && p.status !== 'draft'
                        ? `${view.path} (and the pages under it) will redirect to ${newPath} (301).`
                        : `The page is ${newPath}.`
                  }
                />
                <Select label="Category" value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                  {!form.categoryId && <option value="">Pick one</option>}
                  {view.choices.categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.status !== 'active' ? ` (${c.status})` : ''}
                    </option>
                  ))}
                </Select>
                {cfg.fields.weekday && (
                  <Select label="Usual day" value={form.weekday} onChange={(e) => set('weekday', e.target.value)}>
                    {WEEKDAY_NAMES.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </Select>
                )}
                <Select label="Venue" value={form.defaultVenueId} onChange={(e) => set('defaultVenueId', e.target.value)}>
                  <option value="">None</option>
                  {view.choices.venues.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
                <Field label="Usual start" type="time" value={form.startTime} onChange={(e) => set('startTime', e.target.value)} />
                <Field label="Usual finish" type="time" value={form.endTime} onChange={(e) => set('endTime', e.target.value)} />
                <Field
                  label="Day and times as shown"
                  maxLength={200}
                  value={form.scheduleLabel}
                  placeholder={scheduleText({ ...preview, scheduleLabel: null })}
                  onChange={(e) => set('scheduleLabel', e.target.value)}
                  hint="Leave blank to use the generated text (shown greyed out)."
                />
                {cfg.fields.format && (
                  <Select
                    label="Format"
                    value={form.format}
                    onChange={(e) => set('format', e.target.value)}
                    hint="Used for new seasons: sets per match, slot length and duty."
                  >
                    <option value="social">Social: 2 sets, draws, team duty</option>
                    <option value="super">Super League: best of 5, 90-minute slots, VNSW referees</option>
                  </Select>
                )}
              </div>
            </Card>

            <Card title="Summary line">
              <p className="mb-3 text-sm text-black/60">
                The one line shown wherever this {cfg.noun} is listed (category pages, enrolment, programme lists).
              </p>
              {form.summaryLine === null ? (
                <div className="space-y-2">
                  <p className="rounded border border-black/10 bg-black/[0.02] px-3 py-2 text-sm">{generatedLine}</p>
                  <p className="text-xs text-black/60">Automatic: it follows the name, code, venue and times.</p>
                  {!ro && (
                    <Button variant="secondary" onClick={() => set('summaryLine', generatedLine)}>
                      Edit the line
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <TextArea
                    label="Your summary line"
                    rows={2}
                    maxLength={200}
                    value={form.summaryLine}
                    onChange={(e) => set('summaryLine', e.target.value)}
                  />
                  {form.summaryLine.trim() !== generatedLine && (
                    <p className="text-xs text-black/60">The automatic line would be: {generatedLine}</p>
                  )}
                  {!ro && (
                    <Button variant="link" onClick={() => set('summaryLine', null)}>
                      Reset to automatic
                    </Button>
                  )}
                </div>
              )}
            </Card>

            <Card title="Description">
              <div className="space-y-4">
                <RichText
                  key={editorKey}
                  label="Description"
                  initial={p.description}
                  onChange={(b) => {
                    blocks.current = b
                    setDescDirty(true)
                  }}
                />
                <Field
                  label="More info link"
                  value={form.moreInfoUrl}
                  placeholder="/about/rules or https://…"
                  onChange={(e) => set('moreInfoUrl', e.target.value)}
                  hint="Optional: a page with the full details."
                />
              </div>
            </Card>

            <Card title="Menu, search and sharing">
              <div className="space-y-4">
                <Checkbox
                  label="Show in the menu"
                  hint={`Untick to keep it out of the ${view.category?.name ?? 'category'} dropdown without retiring it.`}
                  checked={form.menuVisible}
                  onChange={(v) => set('menuVisible', v)}
                  disabled={ro}
                />
                <Field
                  label="Order"
                  type="number"
                  value={form.sort}
                  onChange={(e) => set('sort', e.target.value)}
                  hint="Lower numbers come first in menus and lists."
                />
                <Field
                  label="Search title"
                  maxLength={120}
                  value={form.seoTitle}
                  placeholder={form.name}
                  onChange={(e) => set('seoTitle', e.target.value)}
                />
                <TextArea
                  label="Search description"
                  rows={3}
                  maxLength={300}
                  value={form.seoDescription}
                  placeholder={generatedLine}
                  onChange={(e) => set('seoDescription', e.target.value)}
                  hint="Leave blank to use the summary line."
                />
                <ImageField
                  label="Image"
                  mediaId={form.imageId}
                  onChange={(v) => set('imageId', v)}
                  hint="Shown on its page and when shared."
                />
              </div>
            </Card>
          </fieldset>

          <div className="space-y-6">
            <StatusCard
              view={view}
              cfgNoun={cfg.noun}
              isAdmin={isAdmin}
              busy={busy}
              onStatus={(s) => void setStatus(s)}
              onDelete={() => void remove()}
            />
          </div>
        </div>
      )}

      {tab === 'enrolment' && (
        <fieldset className="min-w-0 space-y-6" disabled={ro}>
          <EnrolmentCard view={view} form={form} set={set} kind={kind} />
        </fieldset>
      )}

      {tab === cfg.instancesTab.key && <InstancesTab me={me} view={view} onChanged={() => void load()} />}
    </div>
  )
}

function StatusCard({
  view,
  cfgNoun,
  isAdmin,
  busy,
  onStatus,
  onDelete,
}: {
  view: ProgrammeView
  cfgNoun: string
  isAdmin: boolean
  busy: string | null
  onStatus: (s: 'draft' | 'active' | 'retired') => void
  onDelete: () => void
}) {
  const p = view.programme
  const h = view.history
  const historyText = [
    h.seasons && `${h.seasons} season${h.seasons > 1 ? 's' : ''}`,
    h.sessions && `${h.sessions} session${h.sessions > 1 ? 's' : ''}`,
    h.terms && `${h.terms} term${h.terms > 1 ? 's' : ''}`,
    h.events && `${h.events} date${h.events > 1 ? 's' : ''}`,
  ].filter(Boolean)
  const explain: Record<string, ReactNode> = {
    draft: 'Hidden everywhere on the public site while you set it up.',
    active: 'Listed in menus, category pages and programme lists.',
    retired: 'Gone from menus and lists. Its page stays up, marked as finished, so old links and history survive.',
  }
  return (
    <Card title={statusLabel[p.status]}>
      <p className="mb-4 text-sm">{explain[p.status]}</p>
      {isAdmin && (
        <div className="space-y-2">
          {p.status === 'draft' && (
            <Button className="w-full" busy={busy === 'active'} disabled={!!busy || !p.categoryId} onClick={() => onStatus('active')}>
              Make active
            </Button>
          )}
          {p.status === 'active' && (
            <Button variant="secondary" className="w-full" busy={busy === 'retired'} disabled={!!busy} onClick={() => onStatus('retired')}>
              Retire
            </Button>
          )}
          {p.status === 'retired' && (
            <Button className="w-full" busy={busy === 'active'} disabled={!!busy} onClick={() => onStatus('active')}>
              Reactivate
            </Button>
          )}
          {p.status === 'active' && historyText.length === 0 && (
            <Button variant="link" busy={busy === 'draft'} disabled={!!busy} onClick={() => onStatus('draft')}>
              Back to draft
            </Button>
          )}
        </div>
      )}
      <div className="mt-4 border-t border-black/10 pt-4 text-xs text-black/60">
        {historyText.length > 0 ? <p>Has {historyText.join(', ')}.</p> : <p>No seasons, sessions, terms or dates yet.</p>}
        {h.menuItems.length > 0 && <p>In the menu as {h.menuItems.map((m) => `“${m.label}”`).join(', ')}.</p>}
        {h.pages.length > 0 && <p>Its ladder or fixtures are on {h.pages.map((x) => x.path).join(', ')}.</p>}
        {p.retiredAt && <p>Retired {formatWhen(p.retiredAt)}.</p>}
        <p>Last saved {formatWhen(p.updatedAt)}.</p>
      </div>
      {isAdmin && (
        <div className="mt-4">
          {view.canDelete ? (
            <Button variant="danger" className="w-full" busy={busy === 'delete'} disabled={!!busy} onClick={onDelete}>
              Delete {cfgNoun}
            </Button>
          ) : (
            <p className="text-xs text-black/60">
              It can’t be deleted once it has history, menu links or blocks on pages{p.status !== 'retired' ? '; retire it instead' : ''}.
            </p>
          )}
        </div>
      )}
    </Card>
  )
}

function EnrolmentCard({
  view,
  form,
  set,
  kind,
}: {
  view: ProgrammeView
  form: Form
  set: <K extends keyof Form>(k: K, v: Form[K]) => void
  kind: ProgrammeKind
}) {
  const cfg = KINDS[kind]
  const g = view.generated
  const noun = { league: 'season', training: 'session', development: 'term', event: 'event' }[kind]
  return (
    <>
      <Card title="Enrolment">
        <div className="space-y-4">
          <Notice kind={view.enrolmentOpenNow ? 'success' : 'info'}>
            {view.enrolmentOpenNow
              ? 'Enrolment is open now.'
              : view.programme.status !== 'active'
                ? `Enrolment only opens while the ${cfg.noun} is active.`
                : form.enrolmentOpen
                  ? 'Enrolment is switched on but outside its dates.'
                  : 'Enrolment is closed.'}
          </Notice>
          <Checkbox
            label="Enrolment open"
            hint="When on (and inside the dates below, if set), it shows on /enrol and in “enrolment open” lists."
            checked={form.enrolmentOpen}
            onChange={(v) => set('enrolmentOpen', v)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Opens (optional)"
              type="datetime-local"
              value={form.enrolmentOpensAt}
              onChange={(e) => set('enrolmentOpensAt', e.target.value)}
              hint="Sydney time. Opens on its own at this time."
            />
            <Field
              label="Closes (optional)"
              type="datetime-local"
              value={form.enrolmentClosesAt}
              onChange={(e) => set('enrolmentClosesAt', e.target.value)}
              hint="Sydney time. Closes on its own at this time."
            />
          </div>
        </div>
      </Card>

      <Card title={`Next ${noun} starts`}>
        <div className="space-y-4">
          <p className="text-sm text-black/60">
            Shown as “{g.nextStarts || 'nothing yet'}”.{' '}
            {g.nextInstanceDate ? `Found from the next ${noun} (${g.nextInstanceDate}).` : `No upcoming ${noun} yet.`} Override it with a
            date or your own words; leave both blank for automatic.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date" type="date" value={form.nextStartsOn} onChange={(e) => set('nextStartsOn', e.target.value)} />
            <Field
              label="Or your own words"
              maxLength={200}
              value={form.nextStartsText}
              placeholder="Starts after the Easter break"
              onChange={(e) => set('nextStartsText', e.target.value)}
              hint="Wins over the date."
            />
          </div>
        </div>
      </Card>

      <Card title="Caps, price and waitlist">
        <p className="mb-4 text-sm text-black/60">
          Defaults for every {noun}. Each {noun} can override its cap. Leave a cap blank for no limit.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Player cap" type="number" min={0} value={form.capPlayers} onChange={(e) => set('capPlayers', e.target.value)} />
          {cfg.fields.teams && (
            <Field label="Team cap" type="number" min={0} value={form.capTeams} onChange={(e) => set('capTeams', e.target.value)} />
          )}
          <Field
            label="Price per player (AUD)"
            inputMode="decimal"
            value={form.price}
            placeholder="No fee shown"
            onChange={(e) => set('price', e.target.value)}
          />
          <Field
            label="Waitlist offer lasts (hours)"
            type="number"
            min={1}
            max={720}
            value={form.waitlistOfferHours}
            onChange={(e) => set('waitlistOfferHours', e.target.value)}
          />
          <Select
            label="Confirm email before holding a spot"
            value={form.enrolmentEmailConfirm}
            hint="Public entries wait for the person to click a link emailed to them, so nobody can take a spot with someone else's address. Each instance can override it."
            onChange={(e) => set('enrolmentEmailConfirm', e.target.value)}
          >
            <option value="">Automatic: on when there's a cap</option>
            <option value="true">Always</option>
            <option value="false">Never: hold the spot straight away</option>
          </Select>
        </div>
        <div className="mt-4 space-y-3">
          <Checkbox
            label="Waitlist when full"
            hint="Otherwise new enrolments are refused once it's full."
            checked={form.waitlistEnabled}
            onChange={(v) => set('waitlistEnabled', v)}
          />
          {cfg.fields.teams && (
            <>
              <Checkbox label="Teams can enter" checked={form.allowTeamEntries} onChange={(v) => set('allowTeamEntries', v)} />
              <Checkbox
                label="Individuals can enter as free agents"
                hint="You place them into teams later."
                checked={form.allowFreeAgents}
                onChange={(v) => set('allowFreeAgents', v)}
              />
            </>
          )}
        </div>
      </Card>

      <Card title="Form and ages">
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Enrolment form"
            value={form.enrolmentFormId}
            onChange={(e) => set('enrolmentFormId', e.target.value)}
            hint="The extra questions asked on enrolment. Forms are built under Enrolment forms."
          >
            <option value="">Standard questions only</option>
            {view.choices.forms
              .filter((f) => !f.archived || f.id === form.enrolmentFormId)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {f.archived ? ' (archived)' : ''}
                </option>
              ))}
          </Select>
          {cfg.fields.ages && (
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Minimum age"
                type="number"
                min={0}
                max={99}
                value={form.ageMin}
                onChange={(e) => set('ageMin', e.target.value)}
              />
              <Field
                label="Maximum age"
                type="number"
                min={0}
                max={99}
                value={form.ageMax}
                onChange={(e) => set('ageMax', e.target.value)}
              />
            </div>
          )}
        </div>
      </Card>
    </>
  )
}
