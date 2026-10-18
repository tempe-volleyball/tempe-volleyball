// Loading Cloudflare Turnstile in the browser, shared by the enrolment form island and the contact form script.
// The widget is rendered explicitly with the form's action, which the server checks (src/server/turnstile.ts).

export type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string
      action?: string
      callback: (t: string) => void
      'expired-callback'?: () => void
      'error-callback'?: () => void
    },
  ) => string
  reset: (id?: string) => void
  remove: (id: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

export const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/** Adds Turnstile's script once (or reuses the one already added) and resolves when it has loaded. */
export function loadTurnstile(): Promise<void> {
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
