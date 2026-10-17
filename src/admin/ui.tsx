import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

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
