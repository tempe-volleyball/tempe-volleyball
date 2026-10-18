import { describe, expect, it } from 'vitest'
import { robotsTxt, sitemapEntries, sitemapIndexXml, sitemapPart, sitemapParts, urlsetXml, type SitemapRows } from './sitemap'

const ORIGIN = 'https://www.tempevb.com'
const T = '2026-10-01T00:00:00.000Z'

const rows = (over: Partial<SitemapRows> = {}): SitemapRows => ({
  pages: [
    { path: '/', template: 'home', updatedAt: '2026-10-05T00:00:00.000Z', noindex: false },
    { path: '/contact', template: 'contact', updatedAt: T, noindex: false },
    { path: '/secret', template: 'content', updatedAt: T, noindex: true },
    { path: '/home', template: 'home', updatedAt: T, noindex: false },
    { path: '/enrol', template: 'content', updatedAt: '2026-10-09T00:00:00.000Z', noindex: false },
  ],
  categories: [
    { slug: 'mixed-leagues', status: 'active', updatedAt: T },
    { slug: 'old-stuff', status: 'retired', updatedAt: T },
  ],
  programmes: [
    { id: 'tnl', kind: 'league', slug: 'tnl', status: 'active', updatedAt: T, hasHistory: true },
    { id: 'mnl', kind: 'league', slug: 'mnl', status: 'retired', updatedAt: T, hasHistory: true },
    { id: 'bl', kind: 'league', slug: 'b-league', status: 'retired', updatedAt: T, hasHistory: false },
    { id: 'scrim', kind: 'training', slug: 'scrim', status: 'active', updatedAt: T, hasHistory: false },
  ],
  seasons: [
    {
      id: 's4',
      leagueId: 'tnl',
      slug: 'tnl-q4-2026',
      status: 'published',
      year: 2026,
      quarter: 4,
      updatedAt: T,
      resultsPublishedAt: '2026-10-17T10:00:00.000Z',
    },
    { id: 's3', leagueId: 'tnl', slug: 'tnl-q3-2026', status: 'archived', year: 2026, quarter: 3, updatedAt: T, resultsPublishedAt: null },
    { id: 's5', leagueId: 'tnl', slug: 'tnl-q1-2027', status: 'draft', year: 2027, quarter: 1, updatedAt: T, resultsPublishedAt: null },
    { id: 'm1', leagueId: 'mnl', slug: 'mnl-q1-2021', status: 'archived', year: 2021, quarter: 1, updatedAt: T, resultsPublishedAt: null },
    { id: 'm0', leagueId: 'mnl', slug: 'mnl-q4-2020', status: 'archived', year: 2020, quarter: 4, updatedAt: T, resultsPublishedAt: null },
  ],
  posts: [
    { slug: 'grand-final', updatedAt: '2023-12-09T00:00:00.000Z', publishedAt: '2023-12-08T00:00:00.000Z', noindex: false },
    { slug: 'hidden', updatedAt: '2024-01-01T00:00:00.000Z', publishedAt: '2024-01-01T00:00:00.000Z', noindex: true },
  ],
  ...over,
})

describe('sitemapEntries', () => {
  const entries = sitemapEntries(rows())
  const paths = entries.map((e) => e.path)

  it('lists the real, indexable pages once each', () => {
    expect(paths).toEqual([
      '/',
      '/contact',
      '/mixed-leagues',
      '/old-stuff',
      '/leagues/tnl',
      '/leagues/mnl',
      '/training/scrim',
      '/leagues',
      '/leagues/fixtures',
      '/training',
      '/enrol',
      '/leagues/tnl/tnl-q3-2026',
      '/leagues/mnl/mnl-q4-2020',
      '/news',
      '/news/grand-final',
    ])
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('leaves out hidden pages and posts, drafts, retired programmes without history and each league’s current season', () => {
    for (const p of [
      '/secret',
      '/home',
      '/leagues/b-league',
      '/leagues/tnl/tnl-q4-2026',
      '/leagues/tnl/tnl-q1-2027',
      '/leagues/mnl/mnl-q1-2021',
      '/news/hidden',
    ])
      expect(paths).not.toContain(p)
  })

  it('dates each entry by its newest change: a league by its seasons’ results, the news index by its newest post', () => {
    const at = (p: string) => entries.find((e) => e.path === p)?.lastmod
    expect(at('/')).toBe('2026-10-05T00:00:00.000Z')
    expect(at('/leagues/tnl')).toBe('2026-10-17T10:00:00.000Z')
    expect(at('/leagues')).toBe('2026-10-17T10:00:00.000Z')
    expect(at('/enrol')).toBe('2026-10-09T00:00:00.000Z')
    expect(at('/news')).toBe('2023-12-09T00:00:00.000Z')
    expect(at('/news/grand-final')).toBe('2023-12-09T00:00:00.000Z')
  })

  it('drops /enrol when its intro page is hidden, and kind indexes with nothing to list', () => {
    const r = rows({
      pages: [{ path: '/enrol', template: 'content', updatedAt: T, noindex: true }],
      programmes: [{ id: 'tnl', kind: 'league', slug: 'tnl', status: 'active', updatedAt: T, hasHistory: false }],
    })
    const p = sitemapEntries(r).map((e) => e.path)
    expect(p).not.toContain('/enrol')
    expect(p).not.toContain('/training')
    expect(p).toContain('/leagues/fixtures')
  })
})

describe('urlsetXml', () => {
  it('writes absolute, escaped URLs and W3C lastmod', () => {
    const xml = urlsetXml(ORIGIN, [
      { path: '/a&b', lastmod: '2026-10-01T00:00:00.000Z' },
      { path: '/x y' },
      { path: '/bad', lastmod: 'nope' },
    ])
    expect(xml).toContain('<loc>https://www.tempevb.com/a&amp;b</loc><lastmod>2026-10-01T00:00:00Z</lastmod>')
    expect(xml).toContain('<url><loc>https://www.tempevb.com/x%20y</loc></url>')
    expect(xml).toContain('<url><loc>https://www.tempevb.com/bad</loc></url>')
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(
      true,
    )
  })
})

describe('split sitemaps', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ path: `/p${i}`, lastmod: `2026-10-0${i + 1}T00:00:00.000Z` }))
  it('splits into parts of `limit` and indexes them with each part’s newest lastmod', () => {
    expect(sitemapParts(5, 2)).toBe(3)
    expect(sitemapParts(0)).toBe(1)
    expect(sitemapPart(entries, 3, 2).map((e) => e.path)).toEqual(['/p4'])
    const xml = sitemapIndexXml(ORIGIN, entries, 2)
    expect(xml).toContain('<sitemap><loc>https://www.tempevb.com/sitemap-1.xml</loc><lastmod>2026-10-02T00:00:00Z</lastmod></sitemap>')
    expect(xml).toContain('<loc>https://www.tempevb.com/sitemap-3.xml</loc>')
    expect(xml).not.toContain('sitemap-4.xml')
  })
})

describe('robotsTxt', () => {
  it('allows crawling and names the sitemap only when indexable', () => {
    expect(robotsTxt(true, ORIGIN)).toBe(
      'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: https://www.tempevb.com/sitemap.xml\n',
    )
    expect(robotsTxt(false, ORIGIN)).toBe('User-agent: *\nDisallow: /\n')
  })
})
