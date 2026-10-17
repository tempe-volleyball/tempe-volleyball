import { describe, expect, it } from 'vitest'
import { escapeXml, newsFeed } from './rss'
import { rfc822Sydney } from './time'

describe('rfc822Sydney', () => {
  it('uses Sydney wall time and offset, AEDT in summer and AEST in winter', () => {
    expect(rfc822Sydney(new Date('2023-12-11T11:30:05Z'))).toBe('Mon, 11 Dec 2023 22:30:05 +1100')
    expect(rfc822Sydney(new Date('2026-07-01T10:00:00Z'))).toBe('Wed, 01 Jul 2026 20:00:00 +1000')
  })
  it('rolls the date over at Sydney midnight', () => {
    expect(rfc822Sydney(new Date('2026-10-16T14:30:00Z'))).toBe('Sat, 17 Oct 2026 01:30:00 +1100')
  })
})

describe('newsFeed', () => {
  const opts = { site: 'https://www.tempevb.com', title: 'Tempe Volleyball news', description: 'News & updates' }
  const posts = [
    { slug: 'older', title: 'Older', excerpt: null, publishedAt: '2023-11-30T12:03:00.000Z' },
    { slug: 'gf', title: 'FNL <Grand> Finals & more', excerpt: 'Winners "announced"', publishedAt: '2023-12-08T11:20:00.000Z' },
    { slug: 'draft', title: 'No date', excerpt: null, publishedAt: null },
  ]

  it('lists dated posts newest first with absolute, escaped links', () => {
    const xml = newsFeed(posts, opts)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"')).toBe(true)
    expect(xml).toContain('<link>https://www.tempevb.com/news</link>')
    expect(xml).toContain('<atom:link href="https://www.tempevb.com/news/rss.xml" rel="self" type="application/rss+xml"/>')
    expect(xml).toContain('<description>News &amp; updates</description>')
    expect(xml.indexOf('/news/gf')).toBeLessThan(xml.indexOf('/news/older'))
    expect(xml).toContain('<title>FNL &lt;Grand&gt; Finals &amp; more</title>')
    expect(xml).toContain('<guid isPermaLink="true">https://www.tempevb.com/news/gf</guid>')
    expect(xml).toContain('<pubDate>Fri, 08 Dec 2023 22:20:00 +1100</pubDate>')
    expect(xml).toContain('<description>Winners &quot;announced&quot;</description>')
    expect(xml).toContain('<lastBuildDate>Fri, 08 Dec 2023 22:20:00 +1100</lastBuildDate>')
    expect(xml).not.toContain('No date')
  })

  it('limits the items and copes with no posts', () => {
    expect(newsFeed(posts, { ...opts, limit: 1 }).match(/<item>/g)).toHaveLength(1)
    const empty = newsFeed([], opts)
    expect(empty).not.toContain('<item>')
    expect(empty).not.toContain('lastBuildDate')
  })

  it('escapeXml drops characters XML forbids', () => {
    expect(escapeXml('a\u0001b & c')).toBe('ab &amp; c')
  })
})
