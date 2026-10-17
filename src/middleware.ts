import { defineMiddleware } from 'astro:middleware'
import { env } from 'cloudflare:workers'

// Until the DNS cutover, nothing outside production may be indexed (staging, previews, *.workers.dev).
export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next()
  if (env.SITE_ENV !== 'production') response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  return response
})
