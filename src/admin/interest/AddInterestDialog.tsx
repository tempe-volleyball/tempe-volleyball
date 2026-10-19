import { useEffect, useState } from 'react'
import { api } from '../api'
import type { InterestOptions } from '../../server/interest/admin'
import type { FormField } from '../../lib/enrolment/forms'
import { GENDER_OPTIONS } from '../../lib/enrolment/forms'
import { formatAud } from '../../lib/time'
import { Button, Checkbox, Dialog, Field, LoadError, MoveButtons, Notice, Select, Skeleton, TextArea, errorMessage, toast } from '../ui'

// "Add EOI" (docs/admin.md §3.16): an expression of interest typed in by hand, for a phone call or a chat at the
// venue. Saved through the same path as the public form (source admin, audited), so existing players are matched
// and never overwritten. Nothing is emailed.

type Person = {
  firstName: string
  lastName: string
  email: string
  phone: string
  gender: string
  birthYear: string
  suburb: string
  vnswNumber: string
}
const blank = (): Person => ({ firstName: '', lastName: '', email: '', phone: '', gender: '', birthYear: '', suburb: '', vnswNumber: '' })

/** Only what was typed, so the server sees blanks as missing. */
const personBody = (p: Person) =>
  Object.fromEntries(
    Object.entries(p)
      .map(([k, v]) => [k, v.trim() || null])
      .filter(([, v]) => v !== null),
  )

/** The form question types the dialog asks (the rest are left for the person to answer later, if at all). */
const ASKED = new Set(['text', 'textarea', 'number', 'select', 'radio', 'checkbox', 'checkboxes', 'consent'])

export function AddInterestDialog({
  onCancel,
  onSaved,
  programmeId,
}: {
  onCancel: () => void
  onSaved: (id: string) => void
  programmeId?: string
}) {
  const [options, setOptions] = useState<InterestOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [kind, setKind] = useState<'player' | 'team'>('player')
  const [teamName, setTeamName] = useState('')
  const [programmeIds, setProgrammeIds] = useState<string[]>(programmeId ? [programmeId] : [])
  const [contact, setContact] = useState<Person>(blank)
  const [members, setMembers] = useState<Person[]>([])
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [deposit, setDeposit] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const fetchOptions = () =>
    api<InterestOptions>('/api/admin/interest/options').then(setOptions, (e: unknown) => setLoadError(errorMessage(e)))
  const load = () => {
    setLoadError(null)
    void fetchOptions()
  }
  // Once, when the dialog opens.
  useEffect(() => {
    api<InterestOptions>('/api/admin/interest/options').then(setOptions, (e: unknown) => setLoadError(errorMessage(e)))
  }, [])

  const progs = options
    ? options.programmes.toSorted((a, b) => Number(b.signupMode === 'interest') - Number(a.signupMode === 'interest'))
    : []
  const chosen = progs.filter((p) => programmeIds.includes(p.id))
  const deposits = chosen.map((p) => (kind === 'team' ? p.depositTeamCents : p.depositPlayerCents)).filter((c): c is number => c !== null)
  const autoDeposit = deposits.length ? Math.max(...deposits) : null
  const entryType = kind === 'team' ? 'team' : 'free_agent'
  const questions = (options?.form.fields ?? []).filter(
    (f) =>
      ASKED.has(f.type) && (!f.appliesTo || f.appliesTo.includes(entryType)) && (!f.showIf || answers[f.showIf.key] === f.showIf.equals),
  )
  const maxMembers = options?.maxMembers ?? 30

  const save = async () => {
    setError(null)
    let depositCents: number | null | undefined
    if (deposit.trim() !== '') {
      const n = Number(deposit.replace(/[$,\s]/g, ''))
      if (!Number.isFinite(n) || n < 0) return setError('The deposit should be an amount in dollars, like 50.')
      depositCents = Math.round(n * 100)
    }
    setBusy(true)
    try {
      const body: Record<string, unknown> = {
        action: 'create',
        kind,
        teamName: kind === 'team' ? teamName : null,
        programmeIds,
        members: [contact, ...(kind === 'team' ? members : [])].map(personBody),
        answers,
        note,
      }
      if (depositCents !== undefined) body.depositCents = depositCents
      const r = await api<{ id: string; reference: string }>('/api/admin/interest', { body })
      toast(`Added ${r.reference}.`)
      onSaved(r.id)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Dialog title="Add an expression of interest" onCancel={onCancel} wide>
      {loadError && <LoadError message={loadError} onRetry={load} />}
      {!options && !loadError && <Skeleton lines={6} label="Loading…" />}
      {options && (
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <p className="text-sm text-black/70">
            For a phone call or a chat at the venue. It’s saved like one from the website (nobody is emailed), and someone already on file
            keeps their details: what you type here is kept on the EOI to compare.
          </p>

          <fieldset>
            <legend className="mb-1 text-sm font-semibold">Who is it?</legend>
            <div className="flex flex-wrap gap-4">
              {(['player', 'team'] as const).map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="eoi-kind" className="accent-brand h-4 w-4" checked={kind === k} onChange={() => setKind(k)} />
                  {k === 'player' ? 'A player (on their own, to be placed in a team)' : 'A team'}
                </label>
              ))}
            </div>
          </fieldset>

          {kind === 'team' && (
            <Field label="Team name" value={teamName} maxLength={80} required onChange={(e) => setTeamName(e.target.value)} />
          )}

          <fieldset>
            <legend className="mb-1 text-sm font-semibold">Interested in</legend>
            {progs.length === 0 ? (
              <Notice kind="warning">No programme takes expressions of interest yet. Set one’s sign-ups in its Enrolment tab.</Notice>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {progs.map((p) => {
                  const dep = kind === 'team' ? p.depositTeamCents : p.depositPlayerCents
                  return (
                    <Checkbox
                      key={p.id}
                      label={`${p.code} · ${p.name}`}
                      hint={[
                        p.signupMode !== 'interest' ? 'Takes enrolments' : !p.interestOpen ? 'Not taking EOIs on the website' : '',
                        dep ? `Deposit ${formatAud(dep)}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      checked={programmeIds.includes(p.id)}
                      onChange={(on) => setProgrammeIds((ids) => (on ? [...ids, p.id] : ids.filter((i) => i !== p.id)))}
                    />
                  )
                })}
              </div>
            )}
          </fieldset>

          <PersonFields title={kind === 'team' ? 'Captain (the contact)' : 'The player'} p={contact} onChange={setContact} full />
          <p className="-mt-3 text-xs text-black/60">Names are required, and an email or phone so you can reach them.</p>

          {kind === 'team' && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">
                Team members ({members.length + 1} of at most {maxMembers}, counting the captain)
              </h3>
              {members.length === 0 && <p className="text-sm text-black/70">Optional: a team can be just its name and captain.</p>}
              {members.map((m, i) => (
                <div key={i} className="flex items-start gap-2 rounded border border-black/10 p-3">
                  <MoveButtons
                    vertical
                    name={m.firstName || `member ${i + 2}`}
                    first={i === 0}
                    last={i === members.length - 1}
                    onMove={(by) =>
                      setMembers((list) => {
                        const n = [...list]
                        const [it] = n.splice(i, 1)
                        n.splice(i + by, 0, it!)
                        return n
                      })
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <PersonFields
                      title={`Member ${i + 2}`}
                      p={m}
                      onChange={(v) => setMembers((list) => list.map((x, j) => (j === i ? v : x)))}
                    />
                  </div>
                  <Button
                    variant="link"
                    className="text-red-700"
                    aria-label={`Remove member ${i + 2}`}
                    onClick={() => setMembers((list) => list.filter((_x, j) => j !== i))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              {members.length + 1 < maxMembers && (
                <Button variant="secondary" onClick={() => setMembers((list) => [...list, blank()])}>
                  Add a team member
                </Button>
              )}
            </div>
          )}

          {questions.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">
                The form’s questions <span className="font-normal text-black/60">({options.form.name}; all optional here)</span>
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {questions.map((f) => (
                  <Question key={f.key} f={f} value={answers[f.key]} onChange={(v) => setAnswers((a) => ({ ...a, [f.key]: v }))} />
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Deposit (AUD)"
              inputMode="decimal"
              value={deposit}
              placeholder={autoDeposit !== null ? (autoDeposit / 100).toFixed(2) : 'None'}
              onChange={(e) => setDeposit(e.target.value)}
              hint={
                autoDeposit !== null
                  ? `Leave blank for ${formatAud(autoDeposit)}, the highest deposit of the programmes ticked. 0 = none.`
                  : 'Leave blank for none (the programmes ticked ask no deposit).'
              }
            />
            <TextArea
              label="Note (for the admins)"
              rows={3}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              hint="E.g. “Rang 20/10, keen on Thursdays.”"
            />
          </div>

          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" busy={busy} disabled={programmeIds.length === 0}>
              Add EOI
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

function PersonFields({ title, p, onChange, full }: { title: string; p: Person; onChange: (p: Person) => void; full?: boolean }) {
  const up = (k: keyof Person) => (e: { target: { value: string } }) => onChange({ ...p, [k]: e.target.value })
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-sm font-semibold">{title}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="First name" value={p.firstName} maxLength={80} required onChange={up('firstName')} autoComplete="off" />
        <Field label="Last name" value={p.lastName} maxLength={80} required onChange={up('lastName')} autoComplete="off" />
        <Field label="Email" type="email" value={p.email} maxLength={254} onChange={up('email')} autoComplete="off" />
        <Field label="Phone" type="tel" value={p.phone} maxLength={30} onChange={up('phone')} autoComplete="off" />
        <Select label="Gender" value={p.gender} onChange={up('gender')}>
          <option value="">Not given</option>
          {GENDER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Field
          label="Year of birth"
          inputMode="numeric"
          value={p.birthYear}
          maxLength={4}
          onChange={up('birthYear')}
          placeholder="e.g. 1995"
        />
        {full && (
          <>
            <Field label="Suburb" value={p.suburb} maxLength={80} onChange={up('suburb')} />
            <Field label="VNSW number" value={p.vnswNumber} maxLength={30} onChange={up('vnswNumber')} />
          </>
        )}
        {!full && <Field label="VNSW number" value={p.vnswNumber} maxLength={30} onChange={up('vnswNumber')} />}
      </div>
    </fieldset>
  )
}

function Question({ f, value, onChange }: { f: FormField; value: unknown; onChange: (v: unknown) => void }) {
  if (f.type === 'select' || f.type === 'radio')
    return (
      <Select
        label={f.label}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        hint={f.help}
      >
        <option value="">Not given</option>
        {(f.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    )
  if (f.type === 'checkboxes') {
    const list = Array.isArray(value) ? (value as string[]) : []
    return (
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 text-sm font-semibold">{f.label}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {(f.options ?? []).map((o) => (
            <Checkbox
              key={o.value}
              label={o.label}
              checked={list.includes(o.value)}
              onChange={(on) => onChange(on ? [...list, o.value] : list.filter((v) => v !== o.value))}
            />
          ))}
        </div>
      </fieldset>
    )
  }
  if (f.type === 'checkbox' || f.type === 'consent')
    return (
      <div className="sm:col-span-2">
        <Checkbox
          label={f.type === 'consent' ? `${f.label} (they agreed)` : f.label}
          hint={f.type === 'consent' ? 'Tick only if they said yes to this.' : f.help}
          checked={value === true}
          onChange={(on) => onChange(on)}
        />
      </div>
    )
  if (f.type === 'textarea')
    return (
      <div className="sm:col-span-2">
        <TextArea
          label={f.label}
          rows={3}
          maxLength={f.maxLength ?? 2000}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    )
  return (
    <Field
      label={f.label}
      type={f.type === 'number' ? 'number' : 'text'}
      min={f.min}
      max={f.max}
      maxLength={f.maxLength}
      value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
      onChange={(e) => onChange(f.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
      hint={f.help}
    />
  )
}
