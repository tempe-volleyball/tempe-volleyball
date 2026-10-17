import type { Settings, Week } from '../../lib/fixtures'
import type { GenerateResponse } from './generate.worker'

// Browser-only helpers for the season screens.

/** Generates a draw in a Web Worker. Same settings (and seed), same draw, as generate() itself. */
export function generateInWorker(settings: Settings): Promise<Week[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./generate.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (e: MessageEvent<GenerateResponse>) => {
      worker.terminate()
      if ('weeks' in e.data) resolve(e.data.weeks)
      else reject(new Error(e.data.error))
    })
    worker.addEventListener('error', (e) => {
      worker.terminate()
      reject(new Error(e.message || 'The draw could not be generated.'))
    })
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a Worker's postMessage has no target origin
    worker.postMessage({ settings })
  })
}

/** Saves text as a file (the fixtures CSV). */
export function download(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** A random seed for "shuffle again": the lib's generate() is seeded (mulberry32), so a seed reproduces a draw. */
export const newSeed = () => Math.floor(Math.random() * 1e9)
