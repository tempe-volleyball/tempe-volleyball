// Runs the scheduler (the lib's seeded generate()) off the main thread, so the admin stays responsive while the
// annealer works. One message in ({ settings }), one out ({ weeks } or { error }).
import { generate, type Settings, type Week } from '../../lib/fixtures'

export type GenerateRequest = { settings: Settings }
export type GenerateResponse = { weeks: Week[] } | { error: string }

self.addEventListener('message', (e: MessageEvent<GenerateRequest>) => {
  let reply: GenerateResponse
  try {
    reply = { weeks: generate(e.data.settings) }
  } catch (err) {
    reply = { error: err instanceof Error ? err.message : 'The draw could not be generated.' }
  }
  // A worker's postMessage has no target origin: it only ever talks to the page that started it.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage(reply)
})
