import { describe, expect, it } from 'vitest'
import { checkHtml, followOnce, oldUrls, pageReport, sitemapPaths } from './crawl'

// Against a running local build with imported data (docs/public-site.md "Checking a build"):
//
//   SEO_BASE_URL=http://127.0.0.1:8787 npx vitest run scripts/seo
//
// Skipped without SEO_BASE_URL, so `npm test` (and CI) only run the pure checks below.

const BASE = process.env.SEO_BASE_URL

describe('checkHtml', () => {
  const page = (head: string, body: string) => `<html><head>${head}</head><body>${body}</body></html>`
  const good = `<title>T</title><meta name="description" content="${'d'.repeat(60)}"><link rel="canonical" href="https://www.tempevb.com/x"><meta property="og:title" content="T"><meta property="og:description" content="d"><meta property="og:image" content="i"><meta property="og:url" content="u"><meta name="twitter:card" content="summary_large_image"><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"SportsOrganization"}]}</script>`
  it('passes a page with one H1, ordered headings and the meta tags', () => {
    expect(checkHtml('/x', page(good, '<h1>T</h1><h2>a</h2><h3>b</h3><h2>c</h2>')).problems).toEqual([])
  })
  it('flags missing tags, a wrong canonical, extra H1s and skipped levels', () => {
    expect(checkHtml('/y', page(good, '<h1>T</h1><h3>b</h3><h1>again</h1>')).problems).toEqual([
      'canonical is https://www.tempevb.com/x',
      '2 <h1>',
      'heading jumps h1 -> h3',
    ])
    expect(checkHtml('/x', page('', '<h2>x</h2>')).problems).toEqual(
      expect.arrayContaining([
        'no <title>',
        'no meta description',
        'no canonical',
        '0 <h1>',
        'first heading is h2',
        'no SportsOrganization JSON-LD',
      ]),
    )
  })
})

describe.skipIf(!BASE)('a local build with imported data', () => {
  const base = BASE ?? ''

  it('every page in the sitemap answers 200 with one H1, ordered headings and complete meta', { timeout: 120_000 }, async () => {
    const xml = await (await fetch(new URL('/sitemap.xml', base))).text()
    const paths = sitemapPaths(xml)
    expect(paths.length).toBeGreaterThan(20)
    const reports = []
    for (const p of paths) reports.push(await pageReport(base, p))
    const bad = reports.filter((r) => r.problems.length).map((r) => `${r.url}: ${r.problems.join('; ')}`)
    expect(bad).toEqual([])
  })

  it(
    'every old URL pattern in PLAN.md (and every old page and post) is one 301 to a page that answers 200',
    { timeout: 300_000 },
    async () => {
      const { urls } = await oldUrls()
      expect(urls.length).toBeGreaterThan(100)
      const hops = []
      for (const u of urls) hops.push(await followOnce(base, u))
      // The old front page is the new one: same URL, no redirect.
      const bad = hops
        .filter((h) => (h.from === '/' ? h.status !== 200 : h.status !== 301 || h.finalStatus !== 200))
        .map((h) => `${h.from}: ${h.status} -> ${h.location} (${h.finalStatus})`)
      expect(bad).toEqual([])
    },
  )
})
