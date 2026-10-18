import { useSyncExternalStore } from 'react'

// The token in the URL fragment (/enrol/confirm#<token>, /enrol/offer#<token>), kept current: opening a second
// email link in a tab that already shows the page only changes the hash, so the islands re-read it on hashchange
// and start again for the new token (they're keyed by it), instead of still showing the first person's entry.

const subscribe = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

const read = () => window.location.hash.slice(1)

/** The current fragment without its "#". The islands are client:only, so this only runs in the browser. */
export const useHashToken = () => useSyncExternalStore(subscribe, read, () => '')
