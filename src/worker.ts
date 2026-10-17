import { handle } from '@astrojs/cloudflare/handler'
import { runScheduled } from './server/cron'

// Custom Worker entry so we can add a `scheduled` handler next to Astro's `fetch`.
export default {
  fetch: handle,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(controller.cron, env))
  },
} satisfies ExportedHandler<Env>
