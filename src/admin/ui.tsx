import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { Link } from 'wouter'

// Small building blocks for the admin, styled with the site tokens (src/styles/global.css). docs/admin.md §4 lists
// which to use for what: one primary button per screen area, toasts for saves, confirmAction() before anything
// destructive, Skeleton while loading, LoadError (with Try again) when a load fails, EmptyState for empty lists.

export function Card({ title, children, actions, id }: { title?: string; children: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <section id={id} className="scroll-mt-4 rounded border border-black/10 bg-white p-4 shadow-sm sm:p-5">
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-brand text-lg font-bold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** primary: the one main action; secondary: the others; danger: destructive (outlined); dangerSolid: the confirm of a destructive dialog. */
  variant?: 'primary' | 'secondary' | 'danger' | 'dangerSolid' | 'link'
  busy?: boolean
}

/**
 * The default padding and text size, left out where the caller sets its own: Tailwind orders utilities of one
 * property by value, not by where they appear, so `px-4` would otherwise always beat a caller's `px-2`.
 */
const defaults = (variant: string, className: string) =>
  [
    variant === 'link' ? 'text-left' : 'justify-center',
    variant !== 'link' && !/(^|\s)(p|px)-/.test(className) ? 'px-4' : '',
    variant !== 'link' && !/(^|\s)(p|py)-/.test(className) ? 'py-2' : '',
    /(^|\s)text-(xs|sm|base|lg|xl)\b/.test(className) ? '' : 'text-sm',
  ].join(' ')

export function Button({ variant = 'primary', busy, className = '', children, disabled, ...rest }: ButtonProps) {
  const styles = {
    primary: 'bg-brand text-white hover:bg-brand-dark',
    secondary: 'border border-brand text-brand bg-white hover:bg-brand/5',
    danger: 'border border-red-700 text-red-700 bg-white hover:bg-red-50',
    dangerSolid: 'bg-red-700 text-white hover:bg-red-800',
    link: 'text-brand underline underline-offset-2',
  }[variant]
  return (
    <button
      type="button"
      data-btn={variant}
      aria-busy={busy || undefined}
      className={`inline-flex items-center gap-2 rounded font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${defaults(variant, className)} ${styles} ${className}`}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? 'Working…' : children}
    </button>
  )
}

export function Field({ label, hint, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      <input
        className="focus:border-brand focus:ring-brand/30 w-full rounded border border-black/20 px-3 py-2 outline-none focus:ring-2"
        {...input}
      />
      {hint && <span className="mt-1 block text-xs text-black/60">{hint}</span>}
    </label>
  )
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode }) {
  const styles = {
    info: 'border-brand/30 bg-brand/5',
    error: 'border-red-300 bg-red-50 text-red-800',
    success: 'border-green-300 bg-green-50 text-green-800',
    warning: 'border-accent bg-accent/10',
  }[kind]
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded border px-4 py-3 text-sm ${styles}`}>
      {children}
    </div>
  )
}

/**
 * An email address that wraps sensibly on a phone: before the @ and at the domain's dots first, and mid-word only
 * when one part is still too long for the line (overflow-wrap: anywhere), never "owner@examp le.com".
 */
export function EmailText({ email, className = '' }: { email: string; className?: string }) {
  const at = email.lastIndexOf('@')
  const local = at > 0 ? email.slice(0, at) : email
  const domain = at > 0 ? email.slice(at + 1).split('.') : []
  return (
    <span className={`[overflow-wrap:anywhere] ${className}`} title={email}>
      {local}
      {domain.length > 0 && (
        <>
          <wbr />@
          {domain.map((part, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <>
                  <wbr />.
                </>
              )}
              {part}
            </Fragment>
          ))}
        </>
      )}
    </span>
  )
}

export function RoleBadge({ role }: { role: string }) {
  const styles: Record<string, string> = { owner: 'bg-accent text-ink', admin: 'bg-brand text-white', editor: 'bg-black/10 text-ink' }
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold uppercase ${styles[role] ?? ''}`}>{role}</span>
}

export const errorMessage = (e: unknown) => (e instanceof Error ? friendlyError(e.message) : 'Something went wrong.')

export function TextArea({ label, hint, ...input }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      <textarea
        className="focus:border-brand focus:ring-brand/30 w-full rounded border border-black/20 px-3 py-2 outline-none focus:ring-2"
        {...input}
      />
      {hint && <span className="mt-1 block text-xs text-black/60">{hint}</span>}
    </label>
  )
}

export function Select({ label, hint, children, ...input }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      <select className="w-full rounded border border-black/20 bg-white px-3 py-2" {...input}>
        {children}
      </select>
      {hint && <span className="mt-1 block text-xs text-black/60">{hint}</span>}
    </label>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    published: 'bg-green-100 text-green-900',
    draft: 'bg-accent/30 text-ink',
    archived: 'bg-black/10 text-black/70',
    active: 'bg-green-100 text-green-900',
    retired: 'bg-black/10 text-black/70',
    scheduled: 'bg-green-100 text-green-900',
    postponed: 'bg-accent/30 text-ink',
    cancelled: 'bg-red-100 text-red-900',
  }
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold uppercase ${styles[status] ?? ''}`}>{status}</span>
}

/**
 * A native <dialog>, shown modally while mounted. The parent unmounts it to close; `onCancel` runs on Escape or
 * the close button. (A dialog's `close` event can fire after React has unmounted it, so parents clear their state
 * in their own handlers, never in a close listener.) Focus goes into the dialog when it opens (the browser's
 * showModal, or the element with autoFocus) and back to whatever had it before when it closes.
 */
export function Dialog({
  title,
  onCancel,
  children,
  wide,
  dirty,
}: {
  title: string
  onCancel: () => void
  children: ReactNode
  wide?: boolean
  /**
   * Has unsaved edits: Escape and × ask before throwing them away. Left out, the dialog counts as edited once
   * anything inside one of its forms is typed in or changed (so every form dialog is guarded without wiring).
   */
  dirty?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const touched = useRef(false)
  const cancel = () => {
    if (!(dirty ?? touched.current)) return onCancel()
    void confirmAction({
      title: 'Discard your changes?',
      body: 'What you’ve changed here hasn’t been saved.',
      confirmLabel: 'Discard changes',
      danger: true,
    }).then((yes) => yes && onCancel())
  }
  useEffect(() => {
    const d = ref.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (d && !d.open) d.showModal()
    return () => {
      // After React removes the dialog; the opener may have gone too (then focus stays on the body).
      if (opener?.isConnected) requestAnimationFrame(() => opener.focus())
    }
  }, [])
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className={`m-auto w-[calc(100%-1.5rem)] rounded bg-white p-0 shadow-xl backdrop:bg-black/50 ${wide ? 'max-w-4xl' : 'max-w-lg'}`}
      onCancel={(e) => {
        e.preventDefault()
        cancel()
      }}
      onInput={(e) => {
        if (e.target instanceof Element && e.target.closest('form')) touched.current = true
      }}
      onChange={(e) => {
        if (e.target instanceof Element && e.target.closest('form')) touched.current = true
      }}
    >
      <div className="flex items-center justify-between border-b border-black/10 px-4 py-3 sm:px-5">
        <h2 id={titleId} className="text-brand text-lg font-bold">
          {title}
        </h2>
        <button
          type="button"
          className="-mr-2 flex h-10 w-10 items-center justify-center text-2xl leading-none text-black/60 hover:text-black"
          aria-label="Close"
          onClick={cancel}
        >
          ×
        </button>
      </div>
      <div className="max-h-[75vh] overflow-y-auto p-4 sm:p-5">{children}</div>
    </dialog>
  )
}

/** Extra words for a save message when the live site's cache couldn't be cleared. */
export const purgeNote = (cache: string | undefined) =>
  cache === 'failed' ? ' The live site may show the old version for a few minutes.' : ''

/** A labelled tick box. */
export function Checkbox({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="flex items-start gap-2">
      <input
        type="checkbox"
        className="accent-brand mt-1 h-4 w-4"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="block text-sm font-semibold">{label}</span>
        {hint && <span className="block text-xs text-black/60">{hint}</span>}
      </span>
    </label>
  )
}

/** Tabs as links (the tab is part of the URL, so it survives a reload), styled like the season tabs. */
export function TabLinks({
  tabs,
  active,
  href,
  label,
}: {
  tabs: { key: string; label: string }[]
  active: string
  href: (key: string) => string
  label: string
}) {
  return (
    <nav className="mt-4 mb-5 flex overflow-x-auto border-b border-black/10 sm:gap-1" aria-label={label}>
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={href(t.key)}
          aria-current={t.key === active ? 'page' : undefined}
          className={`border-b-4 px-3 py-2.5 text-sm font-semibold whitespace-nowrap uppercase ${
            t.key === active ? 'border-accent text-ink' : 'border-transparent text-black/60 hover:text-black'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

// ── Shared screen states ─────────────────────────────────────────────────────

/** Grey placeholder bars while a screen loads (announced as "Loading…"). */
export function Skeleton({ lines = 4, label = 'Loading…' }: { lines?: number; label?: string }) {
  return (
    <div role="status" className="space-y-3" data-skeleton>
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="h-4 animate-pulse rounded bg-black/10 motion-reduce:animate-none"
          style={{ width: `${[92, 76, 84, 60, 70][i % 5]}%` }}
        />
      ))}
    </div>
  )
}

/** "Failed to fetch" and friends (a dropped connection) as something a person can act on. */
export function friendlyError(message: string) {
  return NETWORK_MESSAGE.test(message) ? 'Couldn’t reach the server. Check your connection and try again.' : message
}
const NETWORK_MESSAGE = /failed to fetch|networkerror|load failed|network request failed|network connection was lost/i

/** True when the browser couldn't reach the server at all (offline, dropped Wi-Fi), rather than getting an answer. */
export const isNetworkError = (e: unknown) => e instanceof TypeError && NETWORK_MESSAGE.test(e.message)

/** A failed load, in plain words, with a way to try again. */
export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Notice kind="error">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span>{friendlyError(message)}</span>
        {onRetry && (
          <Button variant="secondary" className="px-3 py-1 text-xs" onClick={onRetry}>
            Try again
          </Button>
        )}
      </span>
    </Notice>
  )
}

/** An empty list: what it is and what to do next. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded border border-dashed border-black/20 px-4 py-6 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mx-auto mt-1 max-w-prose text-sm text-black/70">{children}</div>}
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  )
}

/** Where this screen sits: Leagues › Thursday Night League › TNL Q4 2026. The last item is the current page. */
export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm">
      <ol className="flex flex-wrap items-center gap-x-1.5 text-black/70">
        {items.map((it, i) => (
          <li key={i} className="flex min-w-0 items-center gap-x-1.5">
            {i > 0 && <span aria-hidden="true">›</span>}
            {it.href && i < items.length - 1 ? (
              <Link href={it.href} className="text-brand -my-2 truncate py-2 underline underline-offset-2">
                {it.label}
              </Link>
            ) : (
              <span className="truncate" aria-current={i === items.length - 1 ? 'page' : undefined}>
                {it.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

// ── Toasts ───────────────────────────────────────────────────────────────────

export type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string }
let toasts: Toast[] = []
let toastSeq = 0
const toastListeners = new Set<(t: Toast[]) => void>()
const emitToasts = () => {
  for (const l of toastListeners) l(toasts)
}

/** A short message above the bottom bar ("Saved."), read out by screen readers. Errors stay until closed. */
export function toast(text: string, kind: Toast['kind'] = 'success') {
  const t = { id: ++toastSeq, kind, text }
  toasts = [...toasts.slice(-2), t]
  emitToasts()
  if (kind !== 'error') setTimeout(() => dismissToast(t.id), 5000)
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id)
  emitToasts()
}

/** Mounted once by the admin shell. */
export function Toaster() {
  const [list, setList] = useState<Toast[]>(toasts)
  useEffect(() => {
    toastListeners.add(setList)
    return () => {
      toastListeners.delete(setList)
    }
  }, [])
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-50 flex flex-col items-center gap-2 px-3 lg:bottom-6 lg:left-auto lg:items-end lg:px-6"
    >
      {list.map((t) => (
        <div
          key={t.id}
          role={t.kind === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex w-full max-w-md items-start gap-3 rounded px-4 py-3 text-sm shadow-lg ${
            t.kind === 'error' ? 'bg-red-800 text-white' : t.kind === 'info' ? 'bg-ink text-white' : 'bg-green-800 text-white'
          }`}
        >
          <span className="flex-1">{t.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="-my-2 -mr-2 flex h-9 w-9 items-center justify-center text-lg leading-none opacity-80 hover:opacity-100"
            onClick={() => dismissToast(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Confirmations ────────────────────────────────────────────────────────────

type Ask = { title: string; body?: ReactNode; confirmLabel: string; danger?: boolean; resolve: (yes: boolean) => void }
let asking: Ask | null = null
const askListeners = new Set<(a: Ask | null) => void>()

/**
 * Asks before doing something (usually destructive) in the admin's own dialog: the button names the action
 * ("Delete page", not "OK") and Cancel has the focus. Resolves true when confirmed. Falls back to the browser's
 * confirm() if no ConfirmHost is mounted (the sign-in screens).
 */
export function confirmAction(opts: { title: string; body?: ReactNode; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  if (askListeners.size === 0) return Promise.resolve(window.confirm(opts.title))
  asking?.resolve(false)
  return new Promise((resolve) => {
    asking = { ...opts, resolve }
    for (const l of askListeners) l(asking)
  })
}

/** Mounted once by the admin shell. */
export function ConfirmHost() {
  const [a, setA] = useState<Ask | null>(asking)
  useEffect(() => {
    askListeners.add(setA)
    return () => {
      askListeners.delete(setA)
    }
  }, [])
  if (!a) return null
  const done = (yes: boolean) => {
    asking = null
    setA(null)
    a.resolve(yes)
  }
  return (
    <Dialog title={a.title} onCancel={() => done(false)}>
      {a.body && <div className="space-y-3 text-sm">{a.body}</div>}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" autoFocus onClick={() => done(false)}>
          Cancel
        </Button>
        <Button variant={a.danger ? 'dangerSolid' : 'primary'} onClick={() => done(true)}>
          {a.confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}

// ── Reordering ───────────────────────────────────────────────────────────────

/** ▲/▼ for moving one row of a list, big enough to tap (32 px, 44 px on touch screens). `name` goes in the labels. */
export function MoveButtons({
  name,
  first,
  last,
  disabled,
  onMove,
  vertical,
}: {
  name: string
  first: boolean
  last: boolean
  disabled?: boolean
  onMove: (by: -1 | 1) => void
  vertical?: boolean
}) {
  const cls =
    'flex h-8 w-8 items-center justify-center rounded text-black/60 hover:bg-black/5 hover:text-black disabled:opacity-20 pointer-coarse:h-11 pointer-coarse:w-11'
  return (
    <span className={`flex shrink-0 ${vertical ? 'flex-col' : ''}`}>
      <button type="button" className={cls} aria-label={`Move ${name} up`} disabled={disabled || first} onClick={() => onMove(-1)}>
        ▲
      </button>
      <button type="button" className={cls} aria-label={`Move ${name} down`} disabled={disabled || last} onClick={() => onMove(1)}>
        ▼
      </button>
    </span>
  )
}
