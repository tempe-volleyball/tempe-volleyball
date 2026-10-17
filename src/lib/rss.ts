// The news RSS 2.0 feed (served at /news/rss.xml). Pure: the route loads the posts and passes them in.

import { NEWS_FEED_ROUTE, NEWS_ROUTE, postRoute } from './wp-import/routes'
import { rfc822Sydney } from './time'

export type FeedPost = { slug: string; title: string; excerpt: string | null; publishedAt: string | null }

export type FeedOptions = {
  /** Absolute origin links point at, "https://www.tempevb.com" (astro.config.mjs `site`), on every environment. */
  site: string
  title: string
  description: string
  /** At most this many items, newest first. */
  limit?: number
}

const XML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
// Characters XML 1.0 doesn't allow at all.
// oxlint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g
export const escapeXml = (s: string) => s.replace(XML_INVALID, '').replace(/[&<>"']/g, (c) => XML_ESC[c]!)

const validDate = (iso: string | null) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso) : null)

/** RSS 2.0 for published posts (already filtered), newest first, with absolute links and Sydney-time dates. */
export function newsFeed(posts: readonly FeedPost[], opts: FeedOptions): string {
  const origin = opts.site.replace(/\/+$/, '')
  const items = posts
    .filter((p) => validDate(p.publishedAt))
    .toSorted((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!))
    .slice(0, opts.limit ?? 20)
  const latest = items[0] ? validDate(items[0].publishedAt) : null
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    `<title>${escapeXml(opts.title)}</title>`,
    `<link>${escapeXml(origin + NEWS_ROUTE)}</link>`,
    `<description>${escapeXml(opts.description)}</description>`,
    '<language>en-au</language>',
    `<atom:link href="${escapeXml(origin + NEWS_FEED_ROUTE)}" rel="self" type="application/rss+xml"/>`,
    ...(latest ? [`<lastBuildDate>${rfc822Sydney(latest)}</lastBuildDate>`] : []),
  ]
  for (const p of items) {
    const link = escapeXml(origin + postRoute(p.slug))
    lines.push(
      '<item>',
      `<title>${escapeXml(p.title)}</title>`,
      `<link>${link}</link>`,
      `<guid isPermaLink="true">${link}</guid>`,
      `<pubDate>${rfc822Sydney(new Date(p.publishedAt!))}</pubDate>`,
      ...(p.excerpt ? [`<description>${escapeXml(p.excerpt)}</description>`] : []),
      '</item>',
    )
  }
  lines.push('</channel>', '</rss>', '')
  return lines.join('\n')
}
