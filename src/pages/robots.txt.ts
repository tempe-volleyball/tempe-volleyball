import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { isIndexable } from '../lib/indexing'

// Disallow everything except production on www.tempevb.com.
export const GET: APIRoute = ({ url }) => {
  const body = isIndexable(url, env.SITE_ENV) ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n'
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
