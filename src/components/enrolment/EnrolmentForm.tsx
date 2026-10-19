import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ENTRY_TYPE_LABELS } from '../../lib/enrolment/defaults'
import { GENDER_OPTIONS, type FormEntryType, type FormField } from '../../lib/enrolment/forms'
import { visibleFields } from '../../lib/enrolment/validate'
import type { EnrolmentFormProps, PublicTarget } from '../../server/enrolment/public'
import { loadTurnstile } from '../turnstile'

// The public enrolment form: one React island that renders a form definition (docs/api/enrolment.md "Public form
// component"). Pages get its props from loadEnrolmentForm() in src/server/enrolment/public.ts and render
//   <EnrolmentForm client:visible {...props} />
// The admin form builder renders it with `preview` (no Turnstile, nothing is sent).
//
// Hydration: the server renders the form with its fieldset disabled and a "Getting the form ready…" line, and it's
// enabled once React has hydrated. So nothing typed before hydration can be silently wiped (client:visible keeps
// the island's JavaScript off the first load; on a slow phone that gap is long enough to start typing).
//
// Privacy: answers are only ever POSTed as JSON to the endpoint; nothing goes in the URL, local storage or analytics.

export type { EnrolmentFormProps, PublicTarget }

export type EnrolmentFormComponentProps = EnrolmentFormProps & {
  /** Admin preview: shows the form as the public sees it, with Turnstile and submit disabled. */
  preview?: boolean
  /** Preselect this target (e.g. from ?session= on the page). */
  initialTargetId?: string
  /** The published privacy policy (Site.privacyHref); the form links to it when set. */
  privacyHref?: string | null
}

type Answers = Record<string, unknown>
type Errors = Record<string, string>

type Result = {
  /** pending_email: check your inbox. emailed: an entry that already exists; its details went by email. */
  status: 'confirmed' | 'waitlist' | 'pending_email' | 'emailed'
  reference: string | null
  position: number | null
  teamName: string | null
  amountCents: number | null
  message: string | null
  programme: string
  target: string
  confirmHours?: number
}

/** Hydration, as an external store: the server snapshot is false, the client's true. */
const noSubscribe = () => () => {}
const isClient = () => true
const isServer = () => false

const aud = (cents: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100)

// Styled with the public tokens (docs/public-site.md, "Forms"): 44px fields, a blue focus ring, red and tinted when invalid.
const inputClass = (invalid: boolean) =>
  `block min-h-11 w-full rounded-lg border bg-white px-3.5 py-2.5 text-base outline-none transition-shadow focus:ring-4 focus:ring-brand/20 ${invalid ? 'border-danger bg-danger-tint/40 focus:border-danger' : 'border-ink/30 hover:border-ink/50 focus:border-brand'}`

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
          // The server checks it (src/server/turnstile.ts TURNSTILE_ACTIONS.enrol).
          action: 'enrol',
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
        <p className="text-danger text-sm">
          The "are you human" check couldn't load. Check your connection, or turn off a blocker, and reload.
        </p>
      )}
    </div>
  )
}

/** The "*" after a required group's legend, with "(required)" for screen readers (the legend names the group). */
function GroupRequired() {
  return (
    <>
      <span className="text-danger" aria-hidden="true">
        {' '}
        *
      </span>
      <span className="sr-only"> (required)</span>
    </>
  )
}

function Label({ htmlFor, required, children }: { htmlFor?: string; required?: boolean; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-ink mb-1.5 block font-semibold">
      {children}
      {required && (
        <span className="text-danger" aria-hidden="true">
          {' '}
          *
        </span>
      )}
    </label>
  )
}

const ErrorText = ({ id, error }: { id: string; error?: string }) =>
  error ? (
    <p id={id} className="text-danger mt-1.5 flex items-start gap-1.5 text-sm font-semibold">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="mt-0.5 shrink-0">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-.75 3.5h1.5v5h-1.5v-5Zm0 6h1.5V12h-1.5v-1.5Z" />
      </svg>
      {error}
    </p>
  ) : null

/** One question. Exported for the EOI form (src/components/interest/), which asks the same field types. */
export function Question({
  field: rawField,
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
  // A gender question is a fixed set of choices (players.gender values).
  const field: FormField = rawField.type === 'gender' ? { ...rawField, type: 'radio', options: [...GENDER_OPTIONS] } : rawField
  const id = `${idBase}-${field.key}`
  const errId = `${id}-error`
  const helpId = `${id}-help`
  const described = [field.help ? helpId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined
  const help = field.help ? (
    <p id={helpId} className="text-muted mb-1.5 text-sm">
      {field.help}
    </p>
  ) : null
  const common = { id, 'aria-invalid': !!error, 'aria-describedby': described, required: field.required }
  const str = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  const obj = (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, string>

  switch (field.type) {
    case 'heading':
      return <h3 className="font-display text-ink border-line border-t pt-5 text-xl font-bold">{field.label}</h3>
    case 'paragraph':
      return <p className="text-muted whitespace-pre-line">{field.label}</p>
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
          <legend className="text-ink mb-1.5 font-semibold">
            {field.label}
            {field.required && <GroupRequired />}
          </legend>
          {help}
          <div className="grid gap-2 sm:grid-cols-2">
            {field.options?.map((o) => (
              <label
                key={o.value}
                className="border-ink/20 has-checked:border-brand has-checked:bg-brand-tint flex min-h-11 cursor-pointer items-start gap-2.5 rounded-lg border bg-white px-3 py-2.5"
              >
                <input
                  type={many ? 'checkbox' : 'radio'}
                  name={id}
                  // A required radio group: each radio says so. (Checkboxes: the legend says it, since any one will do.)
                  required={!many && field.required}
                  className="accent-brand mt-1 h-4 w-4 shrink-0"
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
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              {...common}
              type="checkbox"
              className="accent-brand mt-1 h-4 w-4 shrink-0"
              checked={value === true}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span>
              {field.label}
              {field.href && (
                <>
                  {' '}
                  (
                  <a href={field.href} target="_blank" rel="noopener" className="link">
                    {field.type === 'vnsw_membership' ? 'get a membership' : 'read them'}
                  </a>
                  )
                </>
              )}
              {field.required && (
                <span className="text-danger" aria-hidden="true">
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
          <legend className="text-ink mb-1.5 font-semibold">
            {field.label}
            {field.required && <GroupRequired />}
          </legend>
          {help}
          <div className="grid gap-3 sm:grid-cols-2">
            {parts.map(([k, label, type]) => (
              <div key={k}>
                <label htmlFor={`${id}-${k}`} className="text-muted mb-1 block text-sm font-semibold">
                  {label}
                </label>
                <input
                  id={`${id}-${k}`}
                  type={type}
                  autoComplete="off"
                  required={field.required}
                  aria-required={field.required}
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

const CheckIcon = () => (
  <svg
    aria-hidden="true"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    className="text-ok shrink-0"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="m7.5 12.5 3 3 6-6.5" />
  </svg>
)

const MailIcon = () => (
  <svg
    aria-hidden="true"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="text-ok shrink-0"
  >
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 6-10 7L2 6" />
  </svg>
)

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
  // False in the server-rendered HTML and while hydrating (the server snapshot), true once hydrated.
  const ready = useSyncExternalStore(noSubscribe, isClient, isServer)
  const formRef = useRef<HTMLFormElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)

  const fields = useMemo(
    () => (target ? visibleFields(forms[target.formKey] ?? [], entryType, answers) : []),
    [target, forms, entryType, answers],
  )

  useEffect(() => {
    if (result) resultRef.current?.focus()
  }, [result])

  if (!preview && !turnstileSiteKey) return <p className="card">Online enrolment is unavailable right now. Please contact us to enrol.</p>
  if (choosable.length === 0)
    return (
      <p className="card">
        {targets.length > 0
          ? `${programme.name} is full.`
          : (props.closedText ?? `Enrolment for ${programme.name} isn't open at the moment.`)}
      </p>
    )

  const whatOf = (r: Result) => (r.target === r.programme ? r.programme : `${r.programme}: ${r.target}`)

  if (result && (result.status === 'pending_email' || result.status === 'emailed'))
    return (
      <div ref={resultRef} tabIndex={-1} role="status" className="border-ok bg-ok-tint rounded-xl border-2 p-5 outline-none sm:p-6">
        <h3 className="font-display flex items-center gap-2 text-xl font-bold">
          <MailIcon />
          Check your email
        </h3>
        {result.status === 'pending_email' ? (
          <>
            <p className="mt-2">
              We've emailed a link to <strong>{person.email}</strong> to finish your enrolment in {whatOf(result)}
              {result.teamName ? ` (team ${result.teamName})` : ''}. <strong>No spot is held until you click it</strong>
              {result.confirmHours ? `, and the link works for ${result.confirmHours} hours` : ''}.
            </p>
            <p className="text-muted mt-2 text-sm">
              If you've entered before, the email has your reference instead. Nothing there? Check your spam folder, or contact us.
            </p>
          </>
        ) : (
          // The same answer whether this is a new entry or a repeat (docs/admin.md §3.7): what stands is in the email.
          <>
            <p className="mt-2">
              Thanks! We've emailed <strong>{person.email}</strong> about your entry in {whatOf(result)}: your reference, and whether you
              have a spot or are on the waitlist.
              {result.amountCents ? ` The fee is ${aud(result.amountCents)}; use the reference as the payment description.` : ''}
            </p>
            {result.message && <p className="mt-2 whitespace-pre-line">{result.message}</p>}
            <p className="text-muted mt-2 text-sm">Nothing there? Check your spam folder, or contact us.</p>
          </>
        )}
      </div>
    )

  if (result)
    return (
      <div ref={resultRef} tabIndex={-1} role="status" className="border-ok bg-ok-tint rounded-xl border-2 p-5 outline-none sm:p-6">
        <h3 className="font-display flex items-center gap-2 text-xl font-bold">
          <CheckIcon />
          {result.status === 'confirmed' ? "You're enrolled!" : "You're on the waitlist"}
        </h3>
        <p className="mt-2">
          {result.status === 'confirmed'
            ? `You're in ${whatOf(result)}${result.teamName ? ` with ${result.teamName}` : ''}.`
            : `${result.target} is full, so you're on the waitlist${result.position ? ` (number ${result.position})` : ''}. If a spot opens up we'll email you an offer.`}
        </p>
        <p className="mt-2">
          Your reference is <strong className="bg-white px-2 py-0.5 text-lg tracking-wider">{result.reference}</strong>
          {result.status === 'confirmed' && result.amountCents
            ? `. The fee is ${aud(result.amountCents)}; use the reference as the payment description.`
            : '.'}
        </p>
        {result.message && <p className="mt-2 whitespace-pre-line">{result.message}</p>}
        <p className="text-muted mt-2 text-sm">We've emailed you a copy.</p>
      </div>
    )

  const setAnswer = (key: string, v: unknown) => {
    setAnswers((a) => ({ ...a, [key]: v }))
    if (errors[key]) setErrors((errs) => without(errs, key))
  }

  const focusFirstError = (errs: Errors) => {
    const first = Object.keys(errs)[0]
    if (!first) return
    // The first control of that question (its help and error texts share the id prefix but can't take focus).
    const id = `${idBase}-${first}`
    const el = formRef.current?.querySelector<HTMLElement>(
      [`[id="${id}"]`, `[id^="${id}-"]`, `[name="${id}"]`].map((s) => `:is(input, select, textarea, button)${s}`).join(', '),
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
    <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="space-y-5" aria-busy={!ready}>
      {!ready && (
        <p role="status" className="text-muted text-sm">
          Getting the form ready…
        </p>
      )}
      {/* Disabled until hydrated, so nothing can be typed that hydration would clear. */}
      <fieldset disabled={!ready} className="m-0 min-w-0 space-y-6 border-0 p-0 disabled:opacity-70">
        {targets.length > 1 && (
          <fieldset>
            <legend className="text-ink mb-1.5 font-semibold">Choose</legend>
            <div className="grid gap-2">
              {targets.map((t) => (
                <label
                  key={t.id}
                  className={`flex items-start gap-3 rounded-lg border-2 bg-white px-3.5 py-3 ${t.id === targetId ? 'border-brand bg-brand-tint' : 'border-line'} ${t.full ? 'opacity-60' : 'cursor-pointer'}`}
                >
                  <input
                    type="radio"
                    name={`${idBase}-target`}
                    className="accent-brand mt-1 h-4 w-4 shrink-0"
                    checked={t.id === targetId}
                    disabled={t.full}
                    onChange={() => setTargetId(t.id)}
                  />
                  <span>
                    <span className="font-semibold">{t.label}</span>
                    {targetNote(t) && <span className="text-muted block text-sm">{targetNote(t)}</span>}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {targets.length === 1 && target && (
          <p className="font-display text-lg font-bold">
            {target.label}
            {targetNote(target) && <span className="text-muted block font-sans text-sm font-normal">{targetNote(target)}</span>}
          </p>
        )}

        {target && target.entryTypes.length > 1 && (
          <fieldset>
            <legend className="text-ink mb-1.5 font-semibold">How are you entering?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {target.entryTypes.map((t) => (
                <label
                  key={t}
                  className="border-line has-checked:border-brand has-checked:bg-brand-tint flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border-2 bg-white px-3.5 py-2.5 font-semibold"
                >
                  <input
                    type="radio"
                    name={`${idBase}-entry`}
                    className="accent-brand h-4 w-4"
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
          <legend className="font-display text-ink mb-3 text-xl font-bold">
            {team ? "Captain's details" : programme.kind === 'development' ? "Player's details" : 'Your details'}
          </legend>
          <div className="grid gap-4 sm:grid-cols-2">
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

        <p className="text-sm text-black/70">
          We use these details to run your enrolment and contact you about it.
          {props.privacyHref && (
            <>
              {' '}
              See our{' '}
              <a href={props.privacyHref} className="text-brand underline">
                privacy policy
              </a>
              .
            </>
          )}
        </p>

        {notice && (
          <p role="alert" className="border-danger bg-danger-tint text-danger rounded-lg border-l-4 px-4 py-3 font-semibold">
            {notice}
            {Object.keys(errors).length > 1 && (
              <span className="block font-normal">{Object.keys(errors).length} answers need fixing: they're marked below.</span>
            )}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || preview}
          className="btn btn-enrol w-full px-8 text-lg disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {busy ? 'Sending…' : target?.waitlistOnly ? 'Join the waitlist' : team ? 'Enter the team' : 'Enrol'}
        </button>
        {preview && <p className="text-muted text-sm">Preview: nothing is sent.</p>}
      </fieldset>
    </form>
  )
}
