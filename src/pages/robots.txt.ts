import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { isIndexable } from '../lib/indexing'
import { robotsTxt } from '../lib/seo/sitemap'

// Production on www.tempevb.com allows crawling (except /admin and /api) and names the sitemap; everything else
// (staging, previews, *.workers.dev) disallows everything.
export const GET: APIRoute = ({ url, site }) =>
  new Response(robotsTxt(isIndexable(url, env.SITE_ENV), site?.origin ?? 'https://www.tempevb.com'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
