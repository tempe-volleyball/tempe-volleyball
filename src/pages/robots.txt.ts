import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'

// Only production may be crawled. Staging and preview URLs on *.workers.dev are blocked.
export const GET: APIRoute = () => {
  const body = env.SITE_ENV === 'production' ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n'
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
