import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { checkHealth } from '../../server/health'

export const GET: APIRoute = async () => {
  const health = await checkHealth(env.DB, env.SITE_ENV)
  return Response.json(health, { status: health.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } })
}
