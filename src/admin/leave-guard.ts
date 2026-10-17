import type { AroundNavHandler } from 'wouter'

// The unsaved-changes guard for in-app navigation. A screen with unsaved work registers a blocker; every wouter
// navigation (links, navigate()) goes through `aroundNav` on the Router, and the back/forward buttons through the
// popstate listener below. A blocker returns true to stop the navigation (it then asks the user, and calls
// `leaveTo()` if they choose to go). Closing or reloading the tab is covered by useUnsavedWarning (beforeunload).

/** Gets the absolute path being navigated to, e.g. "/admin/pages". */
export type Blocker = (to: string) => boolean

let blocker: Blocker | null = null
let current = typeof location === 'undefined' ? '' : location.pathname + location.search

export function setLeaveBlocker(b: Blocker | null) {
  blocker = b
}

/** For <Router aroundNav>: `to` is already absolute (base included). */
export const aroundNav: AroundNavHandler = (navigate, to, opts) => {
  if (blocker?.(to)) return
  navigate(to, opts)
}

/** Navigates to an absolute path without asking (the user already chose to leave). */
export function leaveTo(to: string) {
  blocker = null
  history.pushState(null, '', to)
}

if (typeof window !== 'undefined') {
  // wouter dispatches pushState/replaceState events (it patches history), so this always knows where we are.
  for (const type of ['pushState', 'replaceState'])
    window.addEventListener(type, () => {
      current = location.pathname + location.search
    })
  // Registered when the admin bundle loads, before wouter subscribes, so the address is put back before wouter
  // reads it and the screen never changes underneath the dialog.
  window.addEventListener('popstate', () => {
    const to = location.pathname + location.search
    if (to !== current && blocker?.(to)) history.pushState(null, '', current)
    else current = to
  })
}
