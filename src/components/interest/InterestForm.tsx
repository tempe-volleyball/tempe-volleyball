import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { GENDER_OPTIONS } from '../../lib/enrolment/forms'
import { visibleFields } from '../../lib/enrolment/validate'
import { MEMBER_DETAIL_LABELS, depositFor, formatDeposit } from '../../lib/interest'
import type { MemberDetailKey } from '../../lib/content/settings'
import type { InterestFormProps, InterestProgrammeOption, InterestResult } from '../../server/interest/public'
import { Question } from '../enrolment/EnrolmentForm'
import { loadTurnstile } from '../turnstile'

// The public expression-of-interest form (docs/interest.md, docs/api/interest.md): one React island on /interest and
// /interest/<slug>. Props come from loadInterestForm() (src/server/interest/public.ts); pages render
//   <InterestForm client:visible {...form} privacyHref={…} />
//
// Like the enrolment form, the server renders it with its fieldset disabled and a "Getting the form ready…" line,
// enabled once React has hydrated, so nothing typed before hydration is lost. Answers are only ever POSTed as JSON
// to /api/interest: nothing goes in the URL, browser storage or analytics.

export type InterestFormComponentProps = InterestFormProps & {
  /** The published privacy policy (Site.privacyHref); the form links to it when set. */
  privacyHref?: string | null
}

type Kind = 'player' | 'team'
type Errors = Record<string, string>
type Member = { key: number } & Partial<Record<'firstName' | 'lastName' | MemberDetailKey, string>>

const noSubscribe = () => () => {}
const isClient = () => true
const isServer = () => false

// Styled with the public tokens (docs/public-site.md, "Forms"), as the enrolment form is.
const inputClass = (invalid: boolean) =>
  `block min-h-11 w-full rounded-lg border bg-white px-3.5 py-2.5 text-base outline-none transition-shadow focus:ring-4 focus:ring-brand/20 ${invalid ? 'border-danger bg-danger-tint/40 focus:border-danger' : 'border-ink/30 hover:border-ink/50 focus:border-brand'}`

const Required = () => (
  <>
    <span className="text-danger" aria-hidden="true">
      {' '}
      *
    </span>
    <span className="sr-only"> (required)</span>
  </>
)

function Label({ htmlFor, required, children }: { htmlFor: string; required?: boolean; children: ReactNode }) {
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

const ErrorText = ({ id, error }: { id: string; error?: string | undefined }) =>
  error ? (
    <p id={id} className="text-danger mt-1.5 flex items-start gap-1.5 text-sm font-semibold">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" className="mt-0.5 shrink-0">
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm-.75 3.5h1.5v5h-1.5v-5Zm0 6h1.5V12h-1.5v-1.5Z" />
      </svg>
      {error}
    </p>
  ) : null

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
          // The server checks it (src/server/turnstile.ts TURNSTILE_ACTIONS.interest).
          action: 'interest',
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

const PERSON_FIELDS = [
  ['firstName', 'First name', 'text', 'given-name'],
  ['lastName', 'Last name', 'text', 'family-name'],
  ['email', 'Email', 'email', 'email'],
  ['phone', 'Mobile', 'tel', 'tel'],
] as const

const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: 'player', label: 'Just me: find me a team', hint: 'We’ll place you in a team that suits your level.' },
  { value: 'team', label: 'A whole team', hint: 'Your team’s name, you as captain, and your team-mates if you like.' },
]

const without = (errs: Errors, ...keys: string[]) => Object.fromEntries(Object.entries(errs).filter(([k]) => !keys.includes(k)))

/** "$50 deposit per team" for one programme and entry type, or ''. */
const depositNote = (p: InterestProgrammeOption, kind: Kind) => {
  const cents = kind === 'team' ? p.depositTeamCents : p.depositPlayerCents
  return cents ? `${formatDeposit(cents)} deposit ${kind === 'team' ? 'per team' : 'per player'}` : ''
}

export default function InterestForm(props: InterestFormComponentProps) {
  const { groups, maxProgrammes, maxMembers, memberFields, turnstileSiteKey } = props
  const idBase = useId()
  const all = useMemo(() => groups.flatMap((g) => g.programmes), [groups])
  const [kind, setKind] = useState<Kind | null>(null)
  const [picked, setPicked] = useState<string[]>(() =>
    props.preselectedId ? [props.preselectedId] : all.length === 1 && all[0] ? [all[0].id] : [],
  )
  const [person, setPerson] = useState<Record<string, string>>({ firstName: '', lastName: '', email: '', phone: '' })
  const [answers, setAnswers] = useState<Record<string, unknown>>({})
  const [teamName, setTeamName] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [website, setWebsite] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<InterestResult | null>(null)
  const ready = useSyncExternalStore(noSubscribe, isClient, isServer)
  const formRef = useRef<HTMLFormElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  const nextKey = useRef(1)

  const team = kind === 'team'
  const fields = useMemo(
    () => (kind ? visibleFields(props.fields, team ? 'team' : 'free_agent', answers) : []),
    [props.fields, kind, team, answers],
  )
  const chosen = all.filter((p) => picked.includes(p.id))
  const deposit = kind ? depositFor(kind, chosen) : null
  const maxOthers = Math.max(0, maxMembers - 1)
  const detailKeys = (Object.keys(MEMBER_DETAIL_LABELS) as MemberDetailKey[]).filter((k) => memberFields[k] !== 'off')

  useEffect(() => {
    if (result) resultRef.current?.focus()
  }, [result])

  if (!turnstileSiteKey)
    return <p className="card">The form is unavailable right now. Please email or phone us to tell us you’re interested.</p>
  if (all.length === 0)
    return (
      <div className="empty">
        <p>Nothing is taking expressions of interest right now.</p>
        <p>
          Please{' '}
          <a className="link" href="/contact">
            contact us
          </a>{' '}
          and we’ll let you know when the next season opens.
        </p>
      </div>
    )

  if (result) {
    const d = result.deposit
    return (
      <div ref={resultRef} tabIndex={-1} role="status" className="border-ok bg-ok-tint rounded-xl border-2 p-5 outline-none sm:p-6">
        <h2 className="font-display flex items-center gap-2 text-xl font-bold">
          <CheckIcon />
          {team ? 'Your team is on our list' : 'You’re on our list'}
        </h2>
        <p className="mt-2 whitespace-pre-line">{result.message}</p>
        {result.confirmationText && <p className="mt-2 whitespace-pre-line">{result.confirmationText}</p>}
        {d && (
          <p className="mt-3">
            The deposit is <strong>{d.amount}</strong>
            {team ? ' for the team' : ''}.{' '}
            {d.payid ? (
              <>
                Pay it by PayID to <strong>{d.payid.payId}</strong>
                {d.payid.name ? ` (${d.payid.name})` : ''},{' '}
                {d.emailed
                  ? 'with the reference in the email we’ve just sent you as the payment description.'
                  : `with ${team && teamName.trim() ? 'your team’s name' : 'your name'} as the payment description.`}
              </>
            ) : (
              'We’ll tell you how to pay it when we’re in touch.'
            )}
          </p>
        )}
        {d?.emailed !== false && (
          <p className="text-muted mt-3 text-sm">We’ve emailed you a copy. Nothing there? Check your spam folder.</p>
        )}
      </div>
    )
  }

  const clear = (...keys: string[]) => {
    if (keys.some((k) => errors[k])) setErrors((errs) => without(errs, ...keys))
  }

  const toggle = (id: string, on: boolean) => {
    setPicked((list) => (on ? [...list, id] : list.filter((x) => x !== id)))
    clear('programmes')
  }

  const setMember = (i: number, key: keyof Omit<Member, 'key'>, v: string) => {
    setMembers((list) => list.map((m, j) => (j === i ? { ...m, [key]: v } : m)))
    clear(`members.${i}.${key}`, 'members')
  }

  const addMember = () => {
    const key = nextKey.current++
    setMembers((list) => [...list, { key }])
    // Focus the new member's first name once it has rendered.
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>(`[data-member="${key}"] input`)?.focus())
  }

  const removeMember = (i: number) => {
    setMembers((list) => list.filter((_, j) => j !== i))
    // Errors are keyed by position, so the ones after the removed row no longer line up: clear them all.
    setErrors((errs) => Object.fromEntries(Object.entries(errs).filter(([k]) => !k.startsWith('members'))))
    requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[data-add-member]')?.focus())
  }

  const idFor = (key: string) => `${idBase}-${key.replaceAll('.', '-')}`

  const focusFirstError = (errs: Errors) => {
    const keys = Object.keys(errs)
    // The order the sections are on the page: team members come before the questions.
    const memberKeys = keys.filter((k) => k === 'members' || k.startsWith('members.')).sort()
    const order = ['kind', 'programmes', 'teamName', ...PERSON_FIELDS.map(([k]) => k), ...memberKeys, ...fields.map((f) => f.key)]
    const first = order.find((k) => keys.includes(k)) ?? keys[0]
    if (!first) return
    const id = idFor(first)
    const el = formRef.current?.querySelector<HTMLElement>(`[id="${id}"], [id^="${id}-"], [name="${id}"]`)
    el?.focus()
  }

  const submit = async (e: { preventDefault: () => void }) => {
    e.preventDefault()
    setNotice(null)
    if (!kind) {
      setErrors((errs) => ({ ...errs, kind: 'Choose one.' }))
      setNotice('Choose whether you’re entering on your own or as a team.')
      focusFirstError({ kind: 'x' })
      return
    }
    if (!token) {
      setNotice('Please complete the "are you human" check first.')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(props.endpoint ?? '/api/interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          programmeIds: picked,
          person,
          answers,
          ...(team ? { teamName, members: members.map(({ key: _key, ...m }) => m) } : {}),
          website,
          turnstileToken: token,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as Partial<InterestResult> & { message?: string; fieldErrors?: Errors }
      if (res.ok) {
        setResult(data as InterestResult)
        return
      }
      const fieldErrors = data.fieldErrors ?? {}
      setErrors(fieldErrors)
      setNotice(data.message ?? 'Something went wrong. Please try again.')
      focusFirstError(fieldErrors)
      setResetKey((k) => k + 1)
    } catch {
      setNotice("Couldn't send the form. Check your connection and try again.")
      setResetKey((k) => k + 1)
    } finally {
      setBusy(false)
    }
  }

  const errorCount = Object.keys(errors).length
  const programmesErr = errors.programmes
  const limitText = maxProgrammes > 0 && all.length > maxProgrammes ? `Tick up to ${maxProgrammes}.` : 'Tick as many as you like.'

  return (
    <form ref={formRef} onSubmit={(e) => void submit(e)} noValidate className="space-y-8" aria-busy={!ready}>
      {!ready && (
        <p role="status" className="text-muted text-sm">
          Getting the form ready…
        </p>
      )}
      <fieldset disabled={!ready} className="m-0 min-w-0 space-y-8 border-0 p-0 disabled:opacity-70">
        <fieldset aria-describedby={errors.kind ? `${idFor('kind')}-error` : undefined}>
          <legend className="font-display text-ink mb-3 text-xl font-bold">
            How are you joining?
            <Required />
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {KINDS.map((k, i) => (
              <label
                key={k.value}
                className={`has-checked:border-brand has-checked:bg-brand-tint flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border-2 bg-white px-4 py-3.5 ${errors.kind ? 'border-danger' : 'border-line'}`}
              >
                <input
                  type="radio"
                  name={idFor('kind')}
                  id={i === 0 ? idFor('kind') : undefined}
                  required
                  aria-invalid={!!errors.kind}
                  className="accent-brand mt-1 h-4 w-4 shrink-0"
                  checked={kind === k.value}
                  onChange={() => {
                    setKind(k.value)
                    clear('kind')
                    if (notice && !token) setNotice(null)
                  }}
                />
                <span>
                  <span className="block font-semibold">{k.label}</span>
                  <span className="text-muted block text-sm">{k.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <ErrorText id={`${idFor('kind')}-error`} error={errors.kind} />
        </fieldset>

        <fieldset aria-describedby={`${idFor('programmes')}-help${programmesErr ? ` ${idFor('programmes')}-error` : ''}`}>
          <legend className="font-display text-ink mb-1 text-xl font-bold">
            {all.length === 1 ? 'You’re interested in' : 'What are you interested in?'}
            <Required />
          </legend>
          <p id={`${idFor('programmes')}-help`} className="text-muted mb-3 text-sm">
            {all.length === 1 ? 'This is the one taking expressions of interest right now.' : limitText}
          </p>
          <div className="space-y-5">
            {groups.map((g, gi) => (
              <div key={g.category?.id ?? 'other'}>
                {groups.length > 1 && (
                  <p className="text-muted mb-2 text-sm font-semibold tracking-wide uppercase">{g.category?.name ?? 'More'}</p>
                )}
                <div className="grid gap-2">
                  {g.programmes.map((p, pi) => {
                    const on = picked.includes(p.id)
                    const note = [p.nextStarts, kind ? depositNote(p, kind) : ''].filter(Boolean).join(' · ')
                    return (
                      <label
                        key={p.id}
                        className={`has-checked:border-brand has-checked:bg-brand-tint flex cursor-pointer items-start gap-3 rounded-lg border-2 bg-white px-4 py-3 ${programmesErr ? 'border-danger' : 'border-line'}`}
                      >
                        <input
                          type="checkbox"
                          id={gi === 0 && pi === 0 ? idFor('programmes') : undefined}
                          className="accent-brand mt-1 h-4 w-4 shrink-0"
                          checked={on}
                          aria-invalid={!!programmesErr}
                          disabled={!on && maxProgrammes > 0 && picked.length >= maxProgrammes}
                          onChange={(e) => toggle(p.id, e.target.checked)}
                        />
                        <span className="min-w-0">
                          <span className="block font-semibold">{p.name}</span>
                          <span className="text-muted block text-sm">{p.summary}</span>
                          {note && <span className="block text-sm font-semibold">{note}</span>}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <ErrorText id={`${idFor('programmes')}-error`} error={programmesErr} />
        </fieldset>

        {kind && (
          <>
            {team && (
              <div>
                <Label htmlFor={idFor('teamName')} required>
                  Team name
                </Label>
                <input
                  id={idFor('teamName')}
                  type="text"
                  required
                  maxLength={80}
                  autoComplete="off"
                  aria-invalid={!!errors.teamName}
                  aria-describedby={errors.teamName ? `${idFor('teamName')}-error` : undefined}
                  className={inputClass(!!errors.teamName)}
                  value={teamName}
                  onChange={(e) => {
                    setTeamName(e.target.value)
                    clear('teamName')
                  }}
                />
                <ErrorText id={`${idFor('teamName')}-error`} error={errors.teamName} />
              </div>
            )}

            <fieldset className="space-y-3">
              <legend className="font-display text-ink mb-3 text-xl font-bold">{team ? 'Captain’s details (you)' : 'Your details'}</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {PERSON_FIELDS.map(([key, label, type, autoComplete]) => (
                  <div key={key}>
                    <Label htmlFor={idFor(key)} required>
                      {label}
                    </Label>
                    <input
                      id={idFor(key)}
                      type={type}
                      autoComplete={autoComplete}
                      required
                      aria-invalid={!!errors[key]}
                      aria-describedby={errors[key] ? `${idFor(key)}-error` : undefined}
                      className={inputClass(!!errors[key])}
                      value={person[key] ?? ''}
                      onChange={(e) => {
                        setPerson((p) => ({ ...p, [key]: e.target.value }))
                        clear(key)
                      }}
                    />
                    <ErrorText id={`${idFor(key)}-error`} error={errors[key]} />
                  </div>
                ))}
              </div>
            </fieldset>

            {team && maxOthers > 0 && (
              <fieldset aria-describedby={`${idFor('members')}-help${errors.members ? ` ${idFor('members')}-error` : ''}`}>
                <legend className="font-display text-ink mb-1 text-xl font-bold">Team members</legend>
                <p id={`${idFor('members')}-help`} className="text-muted mb-3 text-sm">
                  Optional: add your team-mates now (up to {maxOthers}), or tell us later.
                </p>
                {members.length > 0 && (
                  <ol className="m-0 list-none space-y-3 p-0">
                    {members.map((m, i) => {
                      const base = `members.${i}`
                      return (
                        <li key={m.key} data-member={m.key} className="border-line rounded-lg border bg-white p-4">
                          <div className="mb-3 flex items-center justify-between gap-3">
                            <p className="font-semibold">Team member {i + 2}</p>
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              onClick={() => removeMember(i)}
                              aria-label={`Remove team member ${i + 2}${m.firstName ? ` (${m.firstName})` : ''}`}
                            >
                              Remove
                            </button>
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            {(['firstName', 'lastName', ...detailKeys] as const).map((k) => {
                              const id = idFor(`${base}.${k}`)
                              const err = errors[`${base}.${k}`]
                              const required = k === 'firstName' || k === 'lastName' || memberFields[k as MemberDetailKey] === 'required'
                              const label = k === 'firstName' ? 'First name' : k === 'lastName' ? 'Last name' : MEMBER_DETAIL_LABELS[k]
                              const common = {
                                id,
                                required,
                                'aria-invalid': !!err,
                                'aria-describedby': err ? `${id}-error` : undefined,
                                className: inputClass(!!err),
                                value: m[k] ?? '',
                              }
                              return (
                                <div key={k}>
                                  <Label htmlFor={id} required={required}>
                                    <span className="sr-only">Team member {i + 2}: </span>
                                    {label}
                                    {!required && <span className="text-muted font-normal"> (optional)</span>}
                                  </Label>
                                  {k === 'gender' ? (
                                    <select {...common} onChange={(e) => setMember(i, k, e.target.value)}>
                                      <option value="">Choose…</option>
                                      {GENDER_OPTIONS.map((o) => (
                                        <option key={o.value} value={o.value}>
                                          {o.label}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      {...common}
                                      type={k === 'email' ? 'email' : k === 'phone' ? 'tel' : k === 'birthYear' ? 'number' : 'text'}
                                      inputMode={k === 'birthYear' ? 'numeric' : undefined}
                                      autoComplete="off"
                                      maxLength={k === 'vnswNumber' ? 30 : k === 'birthYear' ? undefined : 120}
                                      placeholder={k === 'birthYear' ? 'e.g. 1995' : undefined}
                                      onChange={(e) => setMember(i, k, e.target.value)}
                                    />
                                  )}
                                  <ErrorText id={`${id}-error`} error={err} />
                                </div>
                              )
                            })}
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                )}
                {members.length < maxOthers && (
                  <button type="button" data-add-member className="btn btn-outline mt-3" onClick={addMember}>
                    + Add a team member
                  </button>
                )}
                <ErrorText id={`${idFor('members')}-error`} error={errors.members} />
              </fieldset>
            )}

            {fields.length > 0 && (
              <div className="space-y-6">
                {fields.map((f) => (
                  <Question
                    key={f.key}
                    field={f}
                    value={answers[f.key]}
                    error={errors[f.key]}
                    onChange={(v) => {
                      setAnswers((a) => ({ ...a, [f.key]: v }))
                      clear(f.key)
                    }}
                    idBase={idBase}
                  />
                ))}
              </div>
            )}

            {deposit && (
              <div className="border-accent bg-accent-tint text-accent-ink rounded-lg border-l-4 px-4 py-3">
                <p>
                  <strong>Deposit: {formatDeposit(deposit)}</strong>
                  {team ? ' for the team' : ''}
                  {chosen.length > 1 ? ' (the highest of what you’ve ticked)' : ''}.{' '}
                  {props.payid
                    ? `Paid by PayID to ${props.payid.payId}${props.payid.name ? ` (${props.payid.name})` : ''}; we’ll email you the reference to use.`
                    : 'We’ll tell you how to pay it.'}
                </p>
              </div>
            )}
          </>
        )}

        {/* A honeypot: hidden from people (and screen readers), so anything typed here is a bot. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label htmlFor={idFor('website')}>Leave this empty</label>
          <input
            id={idFor('website')}
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>

        <Turnstile siteKey={turnstileSiteKey} onToken={setToken} resetKey={resetKey} />

        <p className="text-muted text-sm">
          We use these details to put teams together and contact you about the next season.
          {props.privacyHref && (
            <>
              {' '}
              See our{' '}
              <a href={props.privacyHref} className="link">
                privacy policy
              </a>
              .
            </>
          )}
        </p>

        {notice && (
          <p role="alert" className="border-danger bg-danger-tint text-danger rounded-lg border-l-4 px-4 py-3 font-semibold">
            {notice}
            {errorCount > 1 && <span className="block font-normal">{errorCount} answers need fixing: they're marked above.</span>}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="btn btn-enrol w-full px-8 text-lg disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {busy ? 'Sending…' : team ? 'Register our team' : 'Register my interest'}
        </button>
      </fieldset>
    </form>
  )
}
