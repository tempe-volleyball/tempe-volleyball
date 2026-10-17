import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { Link } from 'wouter'

// Small building blocks for the admin, styled with the site tokens (src/styles/global.css).

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded border border-black/10 bg-white p-5 shadow-sm">
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

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'link'; busy?: boolean }

export function Button({ variant = 'primary', busy, className = '', children, disabled, ...rest }: ButtonProps) {
  const styles = {
    primary: 'bg-brand text-white hover:bg-brand/90',
    secondary: 'border border-brand text-brand bg-white hover:bg-brand/5',
    danger: 'border border-red-700 text-red-700 bg-white hover:bg-red-50',
    link: 'text-brand underline underline-offset-2 px-0 py-0',
  }[variant]
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
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

export function RoleBadge({ role }: { role: string }) {
  const styles: Record<string, string> = { owner: 'bg-accent text-ink', admin: 'bg-brand text-white', editor: 'bg-black/10 text-ink' }
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-bold uppercase ${styles[role] ?? ''}`}>{role}</span>
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')

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
 * in their own handlers, never in a close listener.)
 */
export function Dialog({ title, onCancel, children, wide }: { title: string; onCancel: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className={`m-auto w-[calc(100%-2rem)] rounded bg-white p-0 shadow-xl backdrop:bg-black/50 ${wide ? 'max-w-4xl' : 'max-w-lg'}`}
      onCancel={(e) => {
        e.preventDefault()
        onCancel()
      }}
    >
      <div className="flex items-center justify-between border-b border-black/10 px-5 py-3">
        <h2 className="text-brand text-lg font-bold">{title}</h2>
        <button type="button" className="px-2 text-2xl leading-none text-black/60 hover:text-black" aria-label="Close" onClick={onCancel}>
          ×
        </button>
      </div>
      <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
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
          className={`border-b-4 px-3 py-2 text-sm font-semibold whitespace-nowrap uppercase ${
            t.key === active ? 'border-accent text-ink' : 'border-transparent text-black/60 hover:text-black'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
