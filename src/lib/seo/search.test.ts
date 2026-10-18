import { describe, expect, it } from 'vitest'
import { queryRedirect } from '../canonical-query'
import { menuCandidates, normaliseQuery, pathWords, rankHits, searchTerms, suggestPages, MAX_QUERY } from './search'

describe('search queries', () => {
  it('normalises the query and picks distinct words of two letters or more', () => {
    expect(normaliseQuery('  thursday   ladder ')).toBe('thursday ladder')
    expect(normaliseQuery('x'.repeat(200))).toHaveLength(MAX_QUERY)
    expect(searchTerms('Thursday thursday a ladder, 2026!')).toEqual(['thursday', 'ladder', '2026'])
    expect(searchTerms('one two three four five six seven')).toHaveLength(5)
    expect(searchTerms("%_ ''")).toEqual([])
  })

  it('has one canonical URL per query (the middleware 301s the rest)', () => {
    expect(queryRedirect('/search', '?q=ladder')).toBeNull()
    expect(queryRedirect('/search', '?q=++ladder++&page=2')).toBe('/search?q=ladder')
    expect(queryRedirect('/search', '?x=1')).toBe('/search')
    expect(queryRedirect('/search', '?utm_source=ig&q=a+b')).toBe('/search?q=a+b&utm_source=ig')
  })
})

describe('rankHits', () => {
  it('puts titles with every word first, then partial title matches, and drops duplicate paths', () => {
    const hits = [
      { kind: 'page' as const, path: '/rules', title: 'Rules', text: 'Thursday ladder rules' },
      { kind: 'page' as const, path: '/tnl', title: 'Thursday ladder', text: '' },
      { kind: 'post' as const, path: '/news/x', title: 'Thursday news', text: 'ladder' },
      { kind: 'page' as const, path: '/tnl', title: 'Thursday ladder', text: 'again' },
    ]
    expect(rankHits(hits, ['thursday', 'ladder']).map((h) => h.path)).toEqual(['/tnl', '/news/x', '/rules'])
  })
})

describe('404 suggestions', () => {
  const candidates = [
    { path: '/leagues/tnl', title: 'Thursday Night League' },
    { path: '/leagues/fixtures', title: 'This week’s games' },
    { path: '/where-we-play', title: 'Where we play' },
    { path: '/contact', title: 'Contact' },
  ]
  it('takes words from the address', () => {
    expect(pathWords('/thursday-night-fixtures/')).toEqual(['thursday', 'night', 'fixtures'])
    expect(pathWords('/index.php?p=123456')).toEqual([])
    expect(pathWords('/%E0%A4%A')).toEqual(['e0', 'a4'])
  })
  it('suggests pages sharing words (or near misses) with it, best first', () => {
    expect(suggestPages('/thursday-night-ladder/', candidates).map((c) => c.path)).toEqual(['/leagues/tnl'])
    expect(suggestPages('/fixturs', candidates).map((c) => c.path)).toEqual(['/leagues/fixtures'])
    expect(suggestPages('/where-we-play-2021', candidates).map((c) => c.path)).toEqual(['/where-we-play'])
    expect(suggestPages('/zzz', candidates)).toEqual([])
    expect(suggestPages('/contact', candidates)).toEqual([])
  })
  it('reads candidates from both menu levels, internal links only', () => {
    expect(
      menuCandidates([
        {
          id: '1',
          label: 'About',
          href: null,
          external: false,
          children: [
            { id: '2', label: 'Rules', href: '/rules', external: false, children: [] },
            { id: '3', label: 'Ladder', href: '/leagues/tnl#ladder', external: false, children: [] },
          ],
        },
        { id: '4', label: 'Instagram', href: 'https://instagram.com/x', external: true, children: [] },
      ]),
    ).toEqual([
      { path: '/rules', title: 'Rules' },
      { path: '/leagues/tnl', title: 'Ladder' },
    ])
  })
})
