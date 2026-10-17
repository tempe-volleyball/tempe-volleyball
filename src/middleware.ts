import { defineMiddleware } from 'astro:middleware'
import { env } from 'cloudflare:workers'
import { isIndexable } from './lib/indexing'

// Only production on www.tempevb.com may be indexed (not staging, previews, or *.workers.dev).
export const onRequest = defineMiddleware(async (context, next) => {
  const response = await next()
  if (!isIndexable(context.url, env.SITE_ENV)) response.headers.set('X-Robots-Tag', 'noindex, nofollow')
  return response
})
