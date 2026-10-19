import { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'wouter'
import EnrolmentForm from '../../components/enrolment/EnrolmentForm'
import { entryTypesFor } from '../../lib/enrolment/defaults'
import { FORM_LIMITS, formEntryTypes, type FormEntryType, type FormField, type FormFieldType } from '../../lib/enrolment/forms'
import { checkFormFields, hasOptions, isDisplayOnly, suggestKey } from '../../lib/enrolment/validate'
import { api, formatWhen, isConflict, type EnrolmentForm as FormRow, type FormsList } from '../api'
import { skipLeaveGuard, useUnsavedWarning } from '../unsaved'
import {
  EmptyState,
  Breadcrumbs,
  Skeleton,
  confirmAction,
  Button,
  Card,
  Dialog,
  Field,
  Notice,
  Select,
  TextArea,
  errorMessage,
  purgeNote,
} from '../ui'

// Admin → Enrolments → Forms: the questions each programme asks when people enrol. A form is reusable; a programme
// names its default form and one season, session, term or event can use another. The builder shows a live preview
// using the public form component itself. Saved question keys are permanent: a question can be retired (hidden,
// old answers keep their label) but not deleted.

const KIND_LABELS = { league: 'League', training: 'Training', development: 'Development (juniors)', event: 'Event' } as const
type Kind = keyof typeof KIND_LABELS

export const FIELD_TYPE_LABELS: Record<FormFieldType, string> = {
  text: 'Short answer',
  textarea: 'Long answer',
  email: 'Email address',
  phone: 'Phone number',
  number: 'Number',
  date: 'Date',
  select: 'Dropdown (one choice)',
  radio: 'Multiple choice (one)',
  checkbox: 'Tick box (yes/no)',
  checkboxes: 'Tick boxes (several)',
  consent: 'Agreement (must tick)',
  guardian: 'Parent or guardian details',
  emergency_contact: 'Emergency contact',
  birth_year: 'Year of birth',
  team_name: 'Team name (team entries)',
  vnsw_membership: 'Volleyball NSW membership',
  gender: 'Gender',
  suburb: 'Suburb',
  vnsw_number: 'Volleyball NSW rego number',
  heading: 'Heading',
  paragraph: 'Paragraph of text',
}

const ENTRY_LABELS: Record<FormEntryType, string> = { player: 'Players', team: 'Team entries', free_agent: 'Free agents' }

export function FormList() {
  const [data, setData] = useState<FormsList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  useEffect(() => {
    void api<FormsList>('/api/admin/forms')
      .then(setData)
      .catch((e) => setError(errorMessage(e)))
  }, [])
  const forms = (data?.forms ?? []).filter((f) => showArchived || !f.archivedAt)
  const withoutForm = (data?.programmes ?? []).filter((p) => !p.enrolmentFormId && p.status !== 'retired')
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm">
            <Link href="/enrolments" className="text-brand underline">
              Enrolments
            </Link>{' '}
            › Forms
          </p>
          <h1 className="text-2xl font-bold">Enrolment forms</h1>
          <p className="mt-1 text-sm text-black/60">
            The questions people answer when they enrol, on top of their name, email and phone. Every form has a spam check built in.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>New form</Button>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {data && withoutForm.length > 0 && (
        <Notice>
          Using the built-in questions for their kind (no form of their own): {withoutForm.map((p) => p.name).join(', ')}. Make a form from
          a template to change them.
        </Notice>
      )}
      {data === null && !error && <Skeleton />}
      {data && (
        <Card>
          {forms.length === 0 ? (
            <EmptyState title="No forms yet">
              Programmes use the built-in form until you make one here and pick it on their Enrolment tab.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-black/10">
              {forms.map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm">
                  <Link href={`/forms/${f.id}`} className="text-brand font-semibold underline">
                    {f.name}
                  </Link>
                  {f.archivedAt && <span className="rounded bg-black/10 px-2 py-0.5 text-xs font-bold uppercase">Archived</span>}
                  <span className="text-black/60">
                    {f.questions} question{f.questions === 1 ? '' : 's'} · v{f.version}
                  </span>
                  <span className="text-black/60">
                    {f.programmes.length > 0 ? `Default for ${f.programmes.map((p) => p.name).join(', ')}` : 'Not a programme default'}
                    {f.overrides > 0 ? ` · used by ${f.overrides} session/season override(s)` : ''}
                  </span>
                  <span className="ml-auto text-xs text-black/60">
                    {f.registrations} answer{f.registrations === 1 ? '' : 's'} · saved {formatWhen(f.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived forms
          </label>
        </Card>
      )}
      {creating && <CreateFormDialog onCancel={() => setCreating(false)} />}
    </div>
  )
}

function CreateFormDialog({ onCancel }: { onCancel: () => void }) {
  const [, navigate] = useLocation()
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<Kind | ''>('league')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ form: FormRow }>('/api/admin/forms', { body: { name, ...(template ? { template } : { fields: [] }) } })
      onCancel()
      skipLeaveGuard()
      navigate(`/forms/${r.form.id}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog title="New enrolment form" onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          hint="Only admins see this, e.g. “Junior programmes (with guardian)”."
        />
        <Select label="Start from" value={template} onChange={(e) => setTemplate(e.target.value as Kind | '')}>
          {Object.entries(KIND_LABELS).map(([k, label]) => (
            <option key={k} value={k}>
              The {label.toLowerCase()} questions
            </option>
          ))}
          <option value="">A blank form</option>
        </Select>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Create
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// ── The builder ───────────────────────────────────────────────────────────────

type Draft = { name: string; description: string; confirmationText: string; fields: FormField[] }

const draftOf = (f: FormRow): Draft => ({
  name: f.name,
  description: f.description ?? '',
  confirmationText: f.confirmationText ?? '',
  fields: structuredClone(f.fields),
})

const ADDABLE: FormFieldType[] = [
  'text',
  'textarea',
  'select',
  'radio',
  'checkboxes',
  'checkbox',
  'consent',
  'email',
  'phone',
  'number',
  'date',
  'birth_year',
  'guardian',
  'emergency_contact',
  'team_name',
  'vnsw_membership',
  'vnsw_number',
  'gender',
  'suburb',
  'heading',
  'paragraph',
]

export function FormEditor({ id }: { id: string }) {
  const [form, setForm] = useState<FormRow | null>(null)
  const [list, setList] = useState<FormsList | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // 'interest': the EOI form at /interest (Settings → Interest can use this form), as a player or a team.
  const [previewKind, setPreviewKind] = useState<Kind | 'interest'>('league')
  const [previewEntry, setPreviewEntry] = useState<FormEntryType>('team')
  const [, navigate] = useLocation()

  useEffect(() => {
    void Promise.all([api<{ form: FormRow }>(`/api/admin/forms/${id}`), api<FormsList>('/api/admin/forms')])
      .then(([r, l]) => {
        setForm(r.form)
        setDraft(draftOf(r.form))
        setList(l)
        const first = l.programmes.find((p) => p.enrolmentFormId === id)
        if (first) setPreviewKind(first.kind)
      })
      .catch((e) => setError(errorMessage(e)))
  }, [id])

  const dirty = !!form && !!draft && JSON.stringify(draftOf(form)) !== JSON.stringify(draft)
  useUnsavedWarning(dirty)
  const savedKeys = useMemo(() => new Set(form?.fields.map((f) => f.key) ?? []), [form])
  const check = useMemo(() => (draft ? checkFormFields(draft.fields, form?.fields ?? []) : null), [draft, form])

  if (error && !form) return <Notice kind="error">{error}</Notice>
  if (!form || !draft || !list) return <Skeleton />

  const setField = (i: number, f: FormField) => setDraft((d) => d && { ...d, fields: d.fields.map((x, j) => (j === i ? f : x)) })
  const move = (i: number, by: number) =>
    setDraft((d) => {
      if (!d) return d
      const fields = [...d.fields]
      const j = i + by
      if (j < 0 || j >= fields.length) return d
      ;[fields[i], fields[j]] = [fields[j]!, fields[i]!]
      return { ...d, fields }
    })
  const remove = (i: number) => setDraft((d) => d && { ...d, fields: d.fields.filter((_, j) => j !== i) })
  const add = (type: FormFieldType) =>
    setDraft((d) => {
      if (!d) return d
      const label = FIELD_TYPE_LABELS[type].replace(/ \(.*\)$/, '')
      const key = suggestKey(
        type === 'team_name' || type === 'guardian' || type === 'birth_year' || type === 'emergency_contact' ? type : label,
        d.fields.map((f) => f.key),
      )
      const f: FormField = { key, type, label: type === 'paragraph' ? 'Some text for people to read.' : label }
      if (hasOptions(type)) f.options = [{ value: 'option_1', label: 'Option 1' }]
      if (type === 'consent') f.required = true
      if (type === 'team_name') f.appliesTo = ['team']
      return { ...d, fields: [...d.fields, f] }
    })

  const save = async () => {
    setBusy(true)
    setError(null)
    setFlash(null)
    try {
      const r = await api<{ form: FormRow; cache: string }>(`/api/admin/forms/${id}`, {
        method: 'PATCH',
        body: {
          baseUpdatedAt: form.updatedAt,
          name: draft.name,
          description: draft.description,
          confirmationText: draft.confirmationText,
          fields: draft.fields,
        },
      })
      setForm(r.form)
      setDraft(draftOf(r.form))
      setFlash(`Saved (version ${r.form.version}).${purgeNote(r.cache)}`)
    } catch (e) {
      setError(isConflict(e) ? `${errorMessage(e)} Your changes are still here; copy anything you need, then reload.` : errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const archive = async (archived: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ form: FormRow }>(`/api/admin/forms/${id}`, {
        method: 'PATCH',
        body: { baseUpdatedAt: form.updatedAt, archived },
      })
      setForm(r.form)
      setDraft(draftOf(r.form))
      setFlash(archived ? 'Archived. It no longer appears in pickers; old answers keep its questions.' : 'Restored.')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const del = async () => {
    if (
      !(await confirmAction({ title: `Delete “${form.name}”?`, body: 'This can’t be undone.', confirmLabel: 'Delete form', danger: true }))
    )
      return
    try {
      await api(`/api/admin/forms/${id}`, { method: 'DELETE' })
      skipLeaveGuard()
      navigate('/forms')
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const programmesUsing = list.programmes.filter((p) => p.enrolmentFormId === id)
  const previewTypes: FormEntryType[] =
    previewKind === 'interest' ? ['free_agent', 'team'] : entryTypesFor(previewKind, { allowTeamEntries: true, allowFreeAgents: true })
  const entryLabel = (t: FormEntryType) =>
    previewKind === 'interest' ? (t === 'team' ? 'A team' : 'A player on their own') : ENTRY_LABELS[t]
  const entryForPreview = previewTypes.includes(previewEntry) ? previewEntry : previewTypes[0]!
  const previewFields = draft.fields.filter((f) => !f.retired)

  return (
    <div className="space-y-6">
      <div>
        <Breadcrumbs items={[{ label: 'Forms', href: '/forms' }, { label: form.name }]} />
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{draft.name || 'Untitled form'}</h1>
          <span className="text-sm text-black/60">
            v{form.version} · saved {formatWhen(form.updatedAt)}
          </span>
          {form.archivedAt && <span className="rounded bg-black/10 px-2 py-0.5 text-xs font-bold uppercase">Archived</span>}
        </div>
      </div>
      {flash && <Notice kind="success">{flash}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="space-y-4">
          <Card title="About this form">
            <div className="space-y-3">
              <Field label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
              <Field
                label="Description (admins only)"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
              <TextArea
                label="Message after enrolling (optional)"
                rows={3}
                value={draft.confirmationText}
                onChange={(e) => setDraft({ ...draft, confirmationText: e.target.value })}
                hint="Shown on the page and in the confirmation email, e.g. what to bring on the first night."
              />
            </div>
          </Card>

          <Card title={`Questions (${draft.fields.filter((f) => !f.retired).length})`}>
            <p className="mb-3 text-sm text-black/60">First name, last name, email and mobile are always asked first.</p>
            <ol className="space-y-3">
              {draft.fields.map((f, i) => (
                <li key={f.key}>
                  <FieldEditor
                    field={f}
                    saved={savedKeys.has(f.key)}
                    others={draft.fields.filter((o) => o.key !== f.key && !o.retired && !isDisplayOnly(o.type) && !o.showIf)}
                    onChange={(nf) => setField(i, nf)}
                    onUp={i > 0 ? () => move(i, -1) : undefined}
                    onDown={i < draft.fields.length - 1 ? () => move(i, 1) : undefined}
                    onRemove={() => remove(i)}
                  />
                </li>
              ))}
            </ol>
            {draft.fields.length < FORM_LIMITS.maxFields && (
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <Select
                  label="Add a question"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) add(e.target.value as FormFieldType)
                  }}
                >
                  <option value="">Choose a type…</option>
                  {ADDABLE.map((t) => (
                    <option key={t} value={t}>
                      {FIELD_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </Card>

          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-black/10 bg-white/95 py-3">
            <Button onClick={() => void save()} busy={busy} disabled={!dirty || !check?.ok}>
              Save form
            </Button>
            {dirty && <span className="text-sm text-black/60">Unsaved changes</span>}
            {check && !check.ok && <span className="text-sm text-red-700">{check.message}</span>}
            <span className="ml-auto flex gap-2">
              <Button variant="secondary" onClick={() => void archive(!form.archivedAt)} disabled={busy || dirty}>
                {form.archivedAt ? 'Restore' : 'Archive'}
              </Button>
              <Button variant="danger" onClick={() => void del()} disabled={busy}>
                Delete
              </Button>
            </span>
          </div>

          <Programmes formId={id} list={list} archived={!!form.archivedAt} onSaved={(l, msg) => (setList(l), setFlash(msg))} />
        </div>

        <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <Card title="Preview">
            <div className="mb-4 grid grid-cols-2 gap-2">
              <Select label="As a" value={previewKind} onChange={(e) => setPreviewKind(e.target.value as Kind | 'interest')}>
                {Object.entries(KIND_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
                <option value="interest">Expression of interest</option>
              </Select>
              {previewTypes.length > 1 && (
                <Select label="Entry" value={entryForPreview} onChange={(e) => setPreviewEntry(e.target.value as FormEntryType)}>
                  {previewTypes.map((t) => (
                    <option key={t} value={t}>
                      {entryLabel(t)}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            {previewKind === 'interest' && (
              <p className="mb-3 text-xs text-black/60">
                The questions as the EOI form asks them, after name, email and phone. Team members are a section of their own on the real
                form. Choose the form in Settings → Interest.
              </p>
            )}
            {programmesUsing.length > 0 && (
              <p className="mb-3 text-xs text-black/60">Used by {programmesUsing.map((p) => p.name).join(', ')}.</p>
            )}
            <div className="rounded border border-dashed border-black/20 p-3">
              <EnrolmentForm
                key={`${previewKind}:${entryForPreview}`}
                preview
                programme={{ id: 'preview', name: 'Preview', code: 'PRE', kind: previewKind === 'interest' ? 'league' : previewKind }}
                targets={[
                  {
                    kind: 'session',
                    id: 'preview',
                    label: 'Example',
                    startsOn: null,
                    formKey: 'preview',
                    entryTypes: [entryForPreview],
                    amountCents: null,
                    spotsLeft: null,
                    teamSpotsLeft: null,
                    waitlistOnly: false,
                    full: false,
                  },
                ]}
                forms={{ preview: previewFields }}
                turnstileSiteKey={null}
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

function FieldEditor({
  field: f,
  saved,
  others,
  onChange,
  onUp,
  onDown,
  onRemove,
}: {
  field: FormField
  saved: boolean
  others: FormField[]
  onChange: (f: FormField) => void
  onUp?: () => void
  onDown?: () => void
  onRemove: () => void
}) {
  const [expanded, setExpanded] = useState(!saved)
  const set = <K extends keyof FormField>(k: K, v: FormField[K] | undefined) => {
    const next = { ...f }
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) delete next[k]
    else next[k] = v as FormField[K]
    onChange(next)
  }
  const display = isDisplayOnly(f.type)
  const showIfTarget = f.showIf ? others.find((o) => o.key === f.showIf!.key) : undefined
  return (
    <div className={`rounded border ${f.retired ? 'border-dashed border-black/20 bg-black/[0.03]' : 'border-black/15 bg-white'} p-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="text-left font-semibold" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
          {f.label.slice(0, 80) || '(no text)'}
          {f.required && <span className="text-red-700"> *</span>}
        </button>
        <span className="text-xs text-black/60">
          {FIELD_TYPE_LABELS[f.type]}
          {f.appliesTo ? ` · ${f.appliesTo.map((t) => ENTRY_LABELS[t]).join(', ')} only` : ''}
          {f.showIf ? ' · conditional' : ''}
          {f.retired ? ' · retired' : ''}
        </span>
        <span className="ml-auto flex gap-1">
          <Button variant="secondary" className="px-2 py-0.5 text-xs" onClick={onUp} disabled={!onUp} aria-label="Move up">
            ↑
          </Button>
          <Button variant="secondary" className="px-2 py-0.5 text-xs" onClick={onDown} disabled={!onDown} aria-label="Move down">
            ↓
          </Button>
          {saved ? (
            <Button variant="secondary" className="px-2 py-0.5 text-xs" onClick={() => set('retired', f.retired ? undefined : true)}>
              {f.retired ? 'Restore' : 'Retire'}
            </Button>
          ) : (
            <Button variant="danger" className="px-2 py-0.5 text-xs" onClick={onRemove}>
              Remove
            </Button>
          )}
        </span>
      </div>
      {expanded && !f.retired && (
        <div className="mt-3 space-y-3">
          {f.type === 'paragraph' ? (
            <TextArea label="Text" rows={3} value={f.label} onChange={(e) => set('label', e.target.value)} />
          ) : (
            <Field label={display ? 'Heading' : 'Question'} value={f.label} onChange={(e) => set('label', e.target.value)} />
          )}
          {!display && <Field label="Help text (optional)" value={f.help ?? ''} onChange={(e) => set('help', e.target.value)} />}
          {hasOptions(f.type) && <OptionsEditor field={f} saved={saved} onChange={(options) => set('options', options)} />}
          <div className="flex flex-wrap gap-4 text-sm">
            {!display && f.type !== 'consent' && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={!!f.required} onChange={(e) => set('required', e.target.checked || undefined)} />
                Required
              </label>
            )}
            {f.type !== 'team_name' && (
              <span className="flex flex-wrap items-center gap-3">
                <span className="text-black/60">Asked of:</span>
                {formEntryTypes.map((t) => {
                  const on = !f.appliesTo || f.appliesTo.includes(t)
                  return (
                    <label key={t} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={(e) => {
                          const cur = f.appliesTo ?? [...formEntryTypes]
                          const next = e.target.checked ? [...new Set([...cur, t])] : cur.filter((x) => x !== t)
                          if (next.length === 0) return
                          set('appliesTo', next.length === formEntryTypes.length ? undefined : next)
                        }}
                      />
                      {ENTRY_LABELS[t]}
                    </label>
                  )
                })}
              </span>
            )}
          </div>
          {(f.type === 'consent' || f.type === 'vnsw_membership') && (
            <Field
              label="Link (optional)"
              placeholder="/rules or https://…"
              value={f.href ?? ''}
              onChange={(e) => set('href', e.target.value)}
              hint="Opens in a new tab next to the tick box."
            />
          )}
          {(f.type === 'text' || f.type === 'textarea') && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Placeholder (optional)" value={f.placeholder ?? ''} onChange={(e) => set('placeholder', e.target.value)} />
              <Field
                label="Max length (optional)"
                type="number"
                min={1}
                max={FORM_LIMITS.maxAnswer}
                value={f.maxLength ?? ''}
                onChange={(e) => set('maxLength', e.target.value ? Number(e.target.value) : undefined)}
              />
            </div>
          )}
          {f.type === 'number' && (
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Minimum"
                type="number"
                value={f.min ?? ''}
                onChange={(e) => set('min', e.target.value ? Number(e.target.value) : undefined)}
              />
              <Field
                label="Maximum"
                type="number"
                value={f.max ?? ''}
                onChange={(e) => set('max', e.target.value ? Number(e.target.value) : undefined)}
              />
            </div>
          )}
          {!display && others.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Show only if"
                value={f.showIf?.key ?? ''}
                onChange={(e) => {
                  const target = others.find((o) => o.key === e.target.value)
                  if (!target) return set('showIf', undefined)
                  set('showIf', { key: target.key, equals: hasOptions(target.type) ? (target.options?.[0]?.value ?? '') : true })
                }}
              >
                <option value="">Always show</option>
                {others.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label.slice(0, 60)}
                  </option>
                ))}
              </Select>
              {showIfTarget && (
                <Select
                  label="is answered"
                  value={String(f.showIf!.equals)}
                  onChange={(e) =>
                    set('showIf', {
                      key: showIfTarget.key,
                      equals: hasOptions(showIfTarget.type) ? e.target.value : e.target.value === 'true',
                    })
                  }
                >
                  {hasOptions(showIfTarget.type) ? (
                    showIfTarget.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="true">Ticked / yes</option>
                      <option value="false">Not ticked</option>
                    </>
                  )}
                </Select>
              )}
            </div>
          )}
          <p className="text-xs text-black/60">
            Answer key: {f.key}
            {saved ? ' (fixed once saved)' : ''}
          </p>
        </div>
      )}
    </div>
  )
}

/** Choices, one per line. A saved choice keeps its value (old answers point at it) when its label is edited. */
function OptionsEditor({ field, saved, onChange }: { field: FormField; saved: boolean; onChange: (o: FormField['options']) => void }) {
  const options = field.options ?? []
  const update = (i: number, label: string) =>
    onChange(
      options.map((o, j) =>
        j === i
          ? {
              ...o,
              label,
              ...(saved
                ? {}
                : {
                    value: suggestKey(
                      label,
                      options.filter((_, k) => k !== i).map((x) => x.value),
                    ),
                  }),
            }
          : o,
      ),
    )
  return (
    <div>
      <span className="mb-1 block text-sm font-semibold">Choices</span>
      <ul className="space-y-1">
        {options.map((o, i) => (
          <li key={i} className="flex gap-2">
            <input
              className="flex-1 rounded border border-black/20 px-2 py-1 text-sm"
              value={o.label}
              onChange={(e) => update(i, e.target.value)}
              aria-label={`Choice ${i + 1}`}
            />
            <Button
              variant="secondary"
              className="px-2 py-0.5 text-xs"
              onClick={() => onChange(options.filter((_, j) => j !== i))}
              disabled={options.length <= 1}
              aria-label={`Remove choice ${i + 1}`}
            >
              ×
            </Button>
          </li>
        ))}
      </ul>
      {options.length < FORM_LIMITS.maxOptions && (
        <Button
          variant="link"
          className="mt-1 text-xs"
          onClick={() =>
            onChange([
              ...options,
              {
                value: suggestKey(
                  `option ${options.length + 1}`,
                  options.map((o) => o.value),
                ),
                label: `Option ${options.length + 1}`,
              },
            ])
          }
        >
          Add a choice
        </Button>
      )}
    </div>
  )
}

function Programmes({
  formId,
  list,
  archived,
  onSaved,
}: {
  formId: string
  list: FormsList
  archived: boolean
  onSaved: (l: FormsList, msg: string) => void
}) {
  const initial = list.programmes.filter((p) => p.enrolmentFormId === formId).map((p) => p.id)
  const [chosen, setChosen] = useState<string[]>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changed = JSON.stringify(chosen.toSorted()) !== JSON.stringify(initial.toSorted())
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ cache: string }>(`/api/admin/forms/${formId}/programmes`, { method: 'PUT', body: { programmeIds: chosen } })
      onSaved(await api<FormsList>('/api/admin/forms'), `Programmes updated.${purgeNote(r.cache)}`)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const others = (p: FormsList['programmes'][number]) =>
    p.enrolmentFormId && p.enrolmentFormId !== formId ? list.forms.find((f) => f.id === p.enrolmentFormId)?.name : null
  return (
    <Card title="Default form for">
      <p className="mb-3 text-sm text-black/60">
        The programmes that ask these questions. A single season, session, term or event can use a different form (in its enrolment
        settings).
      </p>
      {error && <Notice kind="error">{error}</Notice>}
      <ul className="grid gap-1 sm:grid-cols-2">
        {list.programmes
          .filter((p) => p.status !== 'retired' || initial.includes(p.id))
          .map((p) => (
            <li key={p.id}>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={archived}
                  checked={chosen.includes(p.id)}
                  onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p.id] : c.filter((x) => x !== p.id)))}
                />
                <span>
                  {p.name} <span className="text-black/60">({KIND_LABELS[p.kind]})</span>
                  {others(p) && !chosen.includes(p.id) && <span className="block text-xs text-black/60">now: {others(p)}</span>}
                </span>
              </label>
            </li>
          ))}
      </ul>
      <div className="mt-3">
        <Button variant="secondary" onClick={() => void save()} busy={busy} disabled={!changed}>
          Save programmes
        </Button>
      </div>
    </Card>
  )
}
