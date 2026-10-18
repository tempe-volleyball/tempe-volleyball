import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { addLeaveBlocker, leaveTo, type Blocker } from './leave-guard'
import { Button, Dialog } from './ui'

// The unsaved-changes guard every admin form uses: while `dirty`, closing or reloading the tab asks the browser's
// "Leave site?" (beforeunload), and in-app links and the back button ask in the admin's own dialog (LeaveHost,
// mounted once by the shell). The season screen has its own dialog that can save first, so it passes inApp: false.

let ask: ((to: string) => void) | null = null
let skipOnce = false

/** Lets the next navigation through without asking: call it right before navigate() after a save or a delete. */
export function skipLeaveGuard() {
  skipOnce = true
  setTimeout(() => (skipOnce = false), 0)
}

/**
 * `within`: a path prefix that counts as the same screen (tabs that keep the form, e.g. /training/<id>); by default
 * only the current path does. Changing only the query or hash never asks.
 */
export function useUnsavedWarning(dirty: boolean, opts: { inApp?: boolean; within?: string } = {}) {
  const inApp = opts.inApp ?? true
  const within = opts.within
  const dirtyRef = useRef(dirty)
  useLayoutEffect(() => {
    dirtyRef.current = dirty
  })
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    if (!inApp || !dirty) return
    const here = location.pathname
    const scope = within ? `/admin${within}` : null
    const b: Blocker = (to) => {
      const path = to.split(/[?#]/)[0]!
      const same = path === here || (!!scope && (path === scope || path.startsWith(`${scope}/`)))
      if (skipOnce || !dirtyRef.current || same || !ask) return false
      ask(to)
      return true
    }
    return addLeaveBlocker(b)
  }, [inApp, dirty, within])
}

/** "Leave without saving?" for in-app navigation. Mounted once by the shell. */
export function LeaveHost() {
  const [to, setTo] = useState<string | null>(null)
  useEffect(() => {
    ask = setTo
    return () => {
      ask = null
    }
  }, [])
  if (!to) return null
  return (
    <Dialog title="Leave without saving?" onCancel={() => setTo(null)}>
      <p className="text-sm">You have changes on this screen that aren’t saved yet. If you leave now, they’ll be lost.</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button
          variant="danger"
          className="mr-auto"
          onClick={() => {
            setTo(null)
            leaveTo(to)
          }}
        >
          Leave and lose changes
        </Button>
        <Button autoFocus onClick={() => setTo(null)}>
          Keep editing
        </Button>
      </div>
    </Dialog>
  )
}
