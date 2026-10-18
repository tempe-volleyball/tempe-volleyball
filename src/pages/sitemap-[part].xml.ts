import type { APIRoute } from 'astro'
import { SITEMAP_LIMIT, sitemapEntries, sitemapPart, sitemapParts, urlsetXml } from '../lib/seo/sitemap'
import { cachePublic, tags } from '../server/cache'
import { publicDb } from '../server/public'
import { loadSitemapRows } from '../server/sitemap'

// One part of a split sitemap (/sitemap-1.xml …), listed by /sitemap.xml once there are more than SITEMAP_LIMIT
// URLs. A 404 while the sitemap fits in one file, or for a part that doesn't exist.
export const GET: APIRoute = async (context) => {
  const n = /^[1-9]\d{0,3}$/.test(context.params.part ?? '') ? Number(context.params.part) : 0
  if (!n) return new Response('Not found', { status: 404 })
  const entries = sitemapEntries(await loadSitemapRows(publicDb()))
  if (entries.length <= SITEMAP_LIMIT || n > sitemapParts(entries.length)) return new Response('Not found', { status: 404 })
  cachePublic(context.cache, tags.news, tags.programmes)
  const origin = context.site?.origin ?? 'https://www.tempevb.com'
  return new Response(urlsetXml(origin, sitemapPart(entries, n)), { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
}
