import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { ENTRY_TYPE_LABELS } from '../../lib/enrolment/defaults'
import type { FormEntryType, FormField } from '../../lib/enrolment/forms'
import { visibleFields } from '../../lib/enrolment/validate'
import type { EnrolmentFormProps, PublicTarget } from '../../server/enrolment/public'

// The public enrolment form: one React island that renders a form definition (docs/api/enrolment.md "Public form
// component"). Pages get its props from loadEnrolmentForm() in src/server/enrolment/public.ts and render
//   <EnrolmentForm client:load {...props} />
// The admin form builder renders it with `preview` (no Turnstile, nothing is sent).
//
// Privacy: answers are only ever POSTed as JSON to the endpoint; nothing goes in the URL, local storage or analytics.

export type { EnrolmentFormProps, PublicTarget }

export type EnrolmentFormComponentProps = EnrolmentFormProps & {
  /** Admin preview: shows the form as the public sees it, with Turnstile and submit disabled. */
  preview?: boolean
  /** Preselect this target (e.g. from ?session= on the page). */
  initialTargetId?: string
}

type Answers = Record<string, unknown>
type Errors = Record<string, string>

type Result = {
  status: 'confirmed' | 'waitlist'
  reference: string
  position: number | null
  teamName: string | null
  amountCents: number | null
  message: string | null
  programme: string
  target: string
}

const aud = (cents: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100)

const inputClass = (invalid: boolean) =>
  `w-full rounded border px-3 py-2 outline-none focus:ring-2 focus:ring-brand/30 ${invalid ? 'border-red-600' : 'border-black/25 focus:border-brand'}`

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: { sitekey: string; callback: (t: string) => void; 'expired-callback'?: () => void; 'error-callback'?: () => void },
      ) => string
      reset: (id?: string) => void
      remove: (id: string) => void
    }
  }
}

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SRC}"]`)
    const s = existing ?? document.createElement('script')
    s.addEventListener('load', () => resolve())
    s.addEventListener('error', () => reject(new Error('Turnstile failed to load')))
    if (!existing) {
      s.src = TURNSTILE_SRC
      s.async = true
      document.head.appendChild(s)
    }
  })
}

function Turnstile({ siteKey, onToken, resetKey }: { siteKey: string; onToken: (t: string | null) => void; resetKey: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    loadTurnstile().then(
      () => {
        if (cancelled || !ref.current || !window.turnstile || widget.current) return
        widget.current = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          callback: (t) => onToken(t),
          'expired-callback': () => onToken(null),
          'error-callback': () => onToken(null),
        })
      },
      () => setFailed(true),
    )
    return () => {
      cancelled = true
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current)
      widget.current = null
    }
    // onToken is stable enough (a state setter wrapper); re-rendering the widget would lose the token.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey])
  useEffect(() => {
    if (resetKey > 0 && widget.current && window.turnstile) {
      window.turnstile.reset(widget.current)
      onToken(null)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])
  return (
    <div>
      <div ref={ref} />
      {failed && (
        <p className="text-sm text-red-700">
          The "are you human" check couldn't load. Check your connection, or turn off a blocker, and reload.
        </p>
      )}
    </div>
  )
}

function Label({ htmlFor, required, children }: { htmlFor?: string; required?: boolean; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block font-semibold">
      {children}
      {required && (
        <span className="text-red-700" aria-hidden="true">
          {' '}
          *
        </span>
      )}
    </label>
  )
}

const ErrorText = ({ id, error }: { id: string; error?: string }) =>
  error ? (
    <p id={id} className="mt-1 text-sm text-red-700">
      {error}
    </p>
  ) : null

function Question({
  field,
  value,
  error,
  onChange,
  idBase,
}: {
  field: FormField
  value: unknown
  error?: string
  onChange: (v: unknown) => void
  idBase: string
}) {
  const id = `${idBase}-${field.key}`
  const errId = `${id}-error`
  const helpId = `${id}-help`
  const described = [field.help ? helpId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined
  const help = field.help ? (
    <p id={helpId} className="mb-1 text-sm text-black/70">
      {field.help}
    </p>
  ) : null
  const common = { id, 'aria-invalid': !!error, 'aria-describedby': described, required: field.required }
  const str = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  const obj = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, string>

  switch (field.type) {
    case 'heading':
      return <h3 className="font-display text-brand pt-2 text-lg font-bold">{field.label}</h3>
    case 'paragraph':
      return <p className="whitespace-pre-line text-black/80">{field.label}</p>
    case 'textarea':
      return (
        <div>
          <Label htmlFor={id} required={field.required}>
            {field.label}
          </Label>
          {help}
          <textarea
            {...common}
            rows={4}
            maxLength={field.maxLength}
            placeholder={field.placeholder}
            className={inputClass(!!error)}
            value={str}
            onChange={(e) => onChange(e.target.value)}
          />
          <ErrorText id={errId} error={error} />
        </div>
      )
    case 'select':
      return (
        <div>
          <Label htmlFor={id} required={field.required}>
            {field.label}
          </Label>
          {help}
          <select {...common} className={`${inputClass(!!error)} bg-white`} value={str} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose…</option>
            {field.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <ErrorText id={errId} error={error} />
        </div>
      )
    case 'radio':
    case 'checkboxes': {
      const many = field.type === 'checkboxes'
      const list = Array.isArray(value) ? (value as string[]) : []
      return (
        <fieldset aria-describedby={described} aria-invalid={!!error}>
          <legend className="mb-1 font-semibold">
            {field.label}
            {field.required && (
              <span className="text-red-700" aria-hidden="true">
                {' '}
                *
              </span>
            )}
          </legend>
          {help}
          <div className="space-y-1">
            {field.options?.map((o) => (
              <label key={o.value} className="flex items-start gap-2">
                <input
                  type={many ? 'checkbox' : 'radio'}
                  name={id}
                  className="accent-brand mt-1"
                  checked={many ? list.includes(o.value) : str === o.value}
                  onChange={(e) => onChange(many ? (e.target.checked ? [...list, o.value] : list.filter((v) => v !== o.value)) : o.value)}
                />
                <span>{o.label}</span>
              </label>
            ))}
          </div>
          <ErrorText id={errId} error={error} />
        </fieldset>
      )
    }
    case 'checkbox':
    case 'consent':
    case 'vnsw_membership':
      return (
        <div>
          {help}
          <label className="flex items-start gap-2">
            <input
              {...common}
              type="checkbox"
              className="accent-brand mt-1"
              checked={value === true}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span>
              {field.label}
              {field.href && (
                <>
                  {' '}
                  (
                  <a href={field.href} target="_blank" rel="noopener" className="text-brand underline">
                    {field.type === 'vnsw_membership' ? 'get a membership' : 'read them'}
                  </a>
                  )
                </>
              )}
              {field.required && (
                <span className="text-red-700" aria-hidden="true">
                  {' '}
                  *
                </span>
              )}
            </span>
          </label>
          <ErrorText id={errId} error={error} />
        </div>
      )
    case 'guardian':
    case 'emergency_contact': {
      const parts: [string, string, string][] =
        field.type === 'guardian'
          ? // The contact email and phone above are the guardian's, so only the name is asked here.
            [['name', "Parent or guardian's name", 'text']]
          : [
              ['name', 'Name', 'text'],
              ['phone', 'Phone', 'tel'],
            ]
      return (
        <fieldset aria-describedby={described}>
          <legend className="mb-1 font-semibold">
            {field.label}
            {field.required && (
              <span className="text-red-700" aria-hidden="true">
                {' '}
                *
              </span>
            )}
          </legend>
          {help}
          <div className="grid gap-2 sm:grid-cols-3">
            {parts.map(([k, label, type]) => (
              <div key={k}>
                <label htmlFor={`${id}-${k}`} className="block text-sm">
                  {label}
                </label>
                <input
                  id={`${id}-${k}`}
                  type={type}
                  autoComplete="off"
                  aria-invalid={!!error}
                  className={inputClass(!!error)}
                  value={obj[k] ?? ''}
                  onChange={(e) => onChange({ ...obj, [k]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <ErrorText id={errId} error={error} />
        </fieldset>
      )
    }
    default: {
      const type =
        field.type === 'email'
          ? 'email'
          : field.type === 'phone'
            ? 'tel'
            : field.type === 'number' || field.type === 'birth_year'
              ? 'number'
              : field.type === 'date'
                ? 'date'
                : 'text'
      return (
        <div>
          <Label htmlFor={id} required={field.required || field.type === 'team_name'}>
            {field.label}
          </Label>
          {help}
          <input
            {...common}
            type={type}
            inputMode={type === 'number' ? 'numeric' : undefined}
            min={field.type === 'birth_year' ? 1900 : field.min}
            max={field.max}
            maxLength={field.maxLength}
            placeholder={field.placeholder ?? (field.type === 'birth_year' ? 'e.g. 2014' : undefined)}
            className={inputClass(!!error)}
            value={str}
            onChange={(e) => onChange(e.target.value)}
          />
          <ErrorText id={errId} error={error} />
        </div>
      )
    }
  }
}

function targetNote(t: PublicTarget) {
  const parts: string[] = []
  if (t.amountCents) parts.push(aud(t.amountCents))
  if (t.full) parts.push('Full')
  else if (t.waitlistOnly) parts.push('Full: join the waitlist')
  else if (t.spotsLeft !== null && t.spotsLeft <= 10) parts.push(`${t.spotsLeft} ${t.spotsLeft === 1 ? 'spot' : 'spots'} left`)
  else if (t.teamSpotsLeft !== null && t.teamSpotsLeft <= 5)
    parts.push(`${t.teamSpotsLeft} team ${t.teamSpotsLeft === 1 ? 'spot' : 'spots'} left`)
  return parts.join(' · ')
}

const without = (errs: Errors, key: string) => Object.fromEntries(Object.entries(errs).filter(([k]) => k !== key))

const PERSON_FIELDS = [
  ['firstName', 'First name', 'text', 'given-name'],
  ['lastName', 'Last name', 'text', 'family-name'],
  ['email', 'Email', 'email', 'email'],
  ['phone', 'Mobile', 'tel', 'tel'],
] as const

export default function EnrolmentForm(props: EnrolmentFormComponentProps) {
  const { programme, targets, forms, turnstileSiteKey, preview } = props
  const idBase = useId()
  const choosable = targets.filter((t) => !t.full)
  const [targetId, setTargetId] = useState(
    () => (props.initialTargetId && choosable.some((t) => t.id === props.initialTargetId) ? props.initialTargetId : choosable[0]?.id) ?? '',
  )
  const target = targets.find((t) => t.id === targetId)
  const [chosenEntry, setEntryType] = useState<FormEntryType>(target?.entryTypes[0] ?? 'player')
  // The chosen entry type, if the selected target takes it; otherwise its first.
  const entryType: FormEntryType = target?.entryTypes.includes(chosenEntry) ? chosenEntry : (target?.entryTypes[0] ?? 'player')
  const [person, setPerson] = useState<Record<string, string>>({ firstName: '', lastName: '', email: '', phone: '' })
  const [answers, setAnswers] = useState<Answers>({})
  const [errors, setErrors] = useState<Errors>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)

  const fields = useMemo(
    () => (target ? visibleFields(forms[target.formKey] ?? [], entryType, answers) : []),
    [target, forms, entryType, answers],
  )

  useEffect(() => {
    if (result) resultRef.current?.focus()
  }, [result])

  if (!preview && !turnstileSiteKey)
    return (
      <p className="rounded border border-black/15 bg-white p-4">Online enrolment is unavailable right now. Please contact us to enrol.</p>
    )
  if (choosable.length === 0)
    return (
      <p className="rounded border border-black/15 bg-white p-4">
        {targets.length > 0
          ? `${programme.name} is full.`
          : (props.closedText ?? `Enrolment for ${programme.name} isn't open at the moment.`)}
      </p>
    )

  if (result)
    return (
      <div ref={resultRef} tabIndex={-1} role="status" className="rounded border border-green-300 bg-green-50 p-5 outline-none">
        <h3 className="font-display text-lg font-bold">{result.status === 'confirmed' ? "You're enrolled!" : "You're on the waitlist"}</h3>
        <p className="mt-2">
          {result.status === 'confirmed'
            ? `You're in ${result.target === result.programme ? result.programme : `${result.programme}: ${result.target}`}${result.teamName ? ` with ${result.teamName}` : ''}.`
            : `${result.target} is full, so you're on the waitlist${result.position ? ` (number ${result.position})` : ''}. If a spot opens up we'll email you an offer.`}
        </p>
        <p className="mt-2">
          Your reference is <strong className="tracking-wider">{result.reference}</strong>
          {result.status === 'confirmed' && result.amountCents
            ? `. The fee is ${aud(result.amountCents)}; use the reference as the payment description.`
            : '.'}
        </p>
        {result.message && <p className="mt-2 whitespace-pre-line">{result.message}</p>}
        <p className="mt-2 text-sm text-black/70">We've emailed you a copy.</p>
      </div>
    )

  const setAnswer = (key: string, v: unknown) => {
    setAnswers((a) => ({ ...a, [key]: v }))
    if (errors[key]) setErrors((errs) => without(errs, key))
  }

  const focusFirstError = (errs: Errors) => {
    const first = Object.keys(errs)[0]
    if (!first) return
    const el = formRef.current?.querySelector<HTMLElement>(
      `[id="${idBase}-${first}"], [id^="${idBase}-${first}-"], [name="${idBase}-${first}"]`,
    )
    el?.focus()
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (preview || !target) return
    setNotice(null)
    if (!token) {
      setNotice('Please complete the "are you human" check first.')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(props.endpoint ?? '/api/enrol', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: { kind: target.kind, id: target.id }, entryType, person, answers, turnstileToken: token }),
      })
      const data = (await res.json().catch(() => ({}))) as Partial<Result> & { message?: string; fieldErrors?: Errors; error?: string }
      if (res.ok) {
        setResult(data as Result)
        return
      }
      const fieldErrors = data.fieldErrors ?? {}
      setErrors(fieldErrors)
      setNotice(data.message ?? 'Something went wrong. Please try again.')
      focusFirstError(fieldErrors)
      // A Turnstile token works once.
      setResetKey((k) => k + 1)
    } catch {
      setNotice("Couldn't send the form. Check your connection and try again.")
      setResetKey((k) => k + 1)
    } finally {
      setBusy(false)
    }
  }

  const team = entryType === 'team'
  return (
    <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="space-y-5">
      {targets.length > 1 && (
        <fieldset>
          <legend className="mb-1 font-semibold">Choose</legend>
          <div className="space-y-1">
            {targets.map((t) => (
              <label
                key={t.id}
                className={`flex items-start gap-2 rounded border px-3 py-2 ${t.id === targetId ? 'border-brand bg-brand/5' : 'border-black/15'} ${t.full ? 'opacity-60' : ''}`}
              >
                <input
                  type="radio"
                  name={`${idBase}-target`}
                  className="accent-brand mt-1"
                  checked={t.id === targetId}
                  disabled={t.full}
                  onChange={() => setTargetId(t.id)}
                />
                <span>
                  <span className="font-semibold">{t.label}</span>
                  {targetNote(t) && <span className="block text-sm text-black/70">{targetNote(t)}</span>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {targets.length === 1 && target && (
        <p className="font-semibold">
          {target.label}
          {targetNote(target) && <span className="block text-sm font-normal text-black/70">{targetNote(target)}</span>}
        </p>
      )}

      {target && target.entryTypes.length > 1 && (
        <fieldset>
          <legend className="mb-1 font-semibold">How are you entering?</legend>
          <div className="flex flex-wrap gap-4">
            {target.entryTypes.map((t) => (
              <label key={t} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${idBase}-entry`}
                  className="accent-brand"
                  checked={entryType === t}
                  onChange={() => setEntryType(t)}
                />
                {t === 'team' ? 'Enter a team' : ENTRY_TYPE_LABELS[t]}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="space-y-3">
        <legend className="font-display text-brand mb-2 text-lg font-bold">
          {team ? "Captain's details" : programme.kind === 'development' ? "Player's details" : 'Your details'}
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {PERSON_FIELDS.map(([key, label, type, autoComplete]) => (
            <div key={key}>
              <Label htmlFor={`${idBase}-${key}`} required>
                {programme.kind === 'development' && (key === 'email' || key === 'phone')
                  ? `Parent or guardian's ${label.toLowerCase()}`
                  : label}
              </Label>
              <input
                id={`${idBase}-${key}`}
                type={type}
                autoComplete={autoComplete}
                required
                aria-invalid={!!errors[key]}
                aria-describedby={errors[key] ? `${idBase}-${key}-error` : undefined}
                className={inputClass(!!errors[key])}
                value={person[key] ?? ''}
                onChange={(e) => {
                  setPerson((p) => ({ ...p, [key]: e.target.value }))
                  if (errors[key]) setErrors((errs) => without(errs, key))
                }}
              />
              <ErrorText id={`${idBase}-${key}-error`} error={errors[key]} />
            </div>
          ))}
        </div>
      </fieldset>

      {fields.map((f) => (
        <Question
          key={f.key}
          field={f}
          value={answers[f.key]}
          error={errors[f.key]}
          onChange={(v) => setAnswer(f.key, v)}
          idBase={idBase}
        />
      ))}

      {!preview && turnstileSiteKey && <Turnstile siteKey={turnstileSiteKey} onToken={setToken} resetKey={resetKey} />}

      {notice && (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-4 py-3 text-red-800">
          {notice}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || preview}
        className="bg-brand hover:bg-brand-dark rounded px-6 py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? 'Sending…' : target?.waitlistOnly ? 'Join the waitlist' : team ? 'Enter the team' : 'Enrol'}
      </button>
      {preview && <p className="text-sm text-black/60">Preview: nothing is sent.</p>}
    </form>
  )
}
