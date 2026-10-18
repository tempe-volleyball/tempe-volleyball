import type { APIRoute } from 'astro'
import { SITEMAP_LIMIT, sitemapEntries, sitemapIndexXml, urlsetXml } from '../lib/seo/sitemap'
import { cachePublic, tags } from '../server/cache'
import { publicDb } from '../server/public'
import { loadSitemapRows } from '../server/sitemap'

// The sitemap (docs/public-site.md "Sitemap"): real, indexable pages only, with lastmod. URLs are absolute on
// www.tempevb.com on every environment (`site` in astro.config.mjs), like canonical URLs. Past SITEMAP_LIMIT URLs
// it becomes an index of /sitemap-<n>.xml. Edge-cached and purged with SITE (pages, menu, seasons), `news` and
// `programmes`, so publishing anything refreshes it.
export const GET: APIRoute = async (context) => {
  const entries = sitemapEntries(await loadSitemapRows(publicDb()))
  cachePublic(context.cache, tags.news, tags.programmes)
  const origin = context.site?.origin ?? 'https://www.tempevb.com'
  const body = entries.length > SITEMAP_LIMIT ? sitemapIndexXml(origin, entries) : urlsetXml(origin, entries)
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
}
