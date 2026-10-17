import type { APIRoute } from 'astro'
import { newsFeed } from '../../lib/rss'
import { SITE_NAME } from '../../lib/site'
import { cachePublic, tags } from '../../server/cache'
import { publicDb } from '../../server/public'
import { listPosts } from '../../server/site'

// RSS for news posts (the old site's /feed/ redirects here). Links are absolute on www.tempevb.com (`site` in
// astro.config.mjs) on every environment, like canonical URLs. Cached like the news index and purged with it.
export const GET: APIRoute = async (context) => {
  const posts = await listPosts(publicDb()).limit(20)
  cachePublic(context.cache, tags.news)
  const body = newsFeed(posts, {
    site: context.site?.origin ?? 'https://www.tempevb.com',
    title: `${SITE_NAME} news`,
    description: 'News from Tempe Volleyball: grand finals, tournaments and league updates.',
  })
  return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } })
}
