import { describe, expect, it } from 'vitest'
import {
  leagueDataPageTarget,
  normalisePath,
  pagePath,
  parseSeasonName,
  postRoute,
  seasonRoute,
  seasonSlug,
  wordpressRedirects,
} from './routes'
import { decodeEntities, isAutoExcerpt, nameKey, slugify, titleCase } from './text'

describe('normalisePath', () => {
  it('strips host, query, fragment and trailing slash', () => {
    expect(normalisePath('https://www.tempevb.com/team/ice-cold/')).toBe('/team/ice-cold')
    expect(normalisePath('https://www.tempevb.com/sunday-super-league-week-1-of-6/?nochache=1')).toBe('/sunday-super-league-week-1-of-6')
    expect(normalisePath('/event/match-15/#x')).toBe('/event/match-15')
    expect(normalisePath('https://www.tempevb.com/')).toBe('/')
    expect(normalisePath('about')).toBe('/about')
  })
})

describe('wordpressRedirects', () => {
  it('sends the feeds to the news feed and date archives with posts to the news index', () => {
    const r = new Map(wordpressRedirects(['2023-12-11T22:30:00', '2023-12-08T22:20:00', '2022-01-05T10:00:00']))
    expect(r.get('/feed')).toBe('/news/rss.xml')
    expect(r.get('/comments/feed')).toBe('/news')
    expect(r.get('/2023')).toBe('/news')
    expect(r.get('/2023/12')).toBe('/news')
    expect(r.get('/2022/01')).toBe('/news')
    expect(r.has('/2023/11')).toBe(false)
    expect([...r.keys()].every((k) => k === normalisePath(k))).toBe(true)
  })
})

describe('season names', () => {
  it('parses league, quarter and year, mapping SSL to TVSL', () => {
    expect(parseSeasonName('TNL Q4 2026')).toEqual({ code: 'TNL', quarter: 4, year: 2026 })
    expect(parseSeasonName('SSL Q3 2026')).toEqual({ code: 'TVSL', quarter: 3, year: 2026 })
    expect(parseSeasonName('MNL Q1 2023')).toBeNull()
    expect(parseSeasonName('2021')).toBeNull()
  })

  it('builds slugs and routes', () => {
    expect(seasonSlug('TVSL', 3, 2026)).toBe('tvsl-q3-2026')
    expect(seasonRoute('tnl', 'tnl-q4-2026')).toBe('/leagues/tnl/tnl-q4-2026')
    expect(postRoute('some-news')).toBe('/news/some-news')
  })
})

describe('old pages', () => {
  it('sends league-data pages to league routes', () => {
    expect(leagueDataPageTarget('ladders')).toBe('/leagues/tnl#ladder')
    expect(leagueDataPageTarget('sal')).toBe('/leagues/sal#fixtures')
    expect(leagueDataPageTarget('sunday-super-league-week-1-of-6')).toBe('/leagues/tvsl#ladder')
    expect(leagueDataPageTarget('monday-results')).toBe('/leagues')
    expect(leagueDataPageTarget('about-tempe-vb')).toBeNull()
  })

  it('keeps page slugs as paths', () => {
    expect(pagePath('home-page', true)).toBe('/')
    expect(pagePath('where-we-play', false)).toBe('/where-we-play')
  })
})

describe('text', () => {
  it('decodes WordPress entities', () => {
    expect(decodeEntities('KY &#038; CO &#8211; A&amp;B &#x27;x&#x27; &nbsp;')).toBe("KY & CO – A&B 'x'  ")
  })
  it('slugifies and keys names', () => {
    expect(slugify('KY &#038; CO')).toBe('ky-and-co')
    expect(nameKey('Ky & Co')).toBe(nameKey('KY &#038; CO'))
    expect(titleCase('PRELIMINARY SEMI FINAL 1')).toBe('Preliminary Semi Final 1')
  })
})

describe('isAutoExcerpt', () => {
  const content =
    '<p><strong>Contact</strong><br><a href="mailto:m@x.com">m@x.com</a> or phone.</p>\n<iframe src="x">Loading…</iframe>\n<p>Getting there&nbsp;by car</p>'
  it('recognises the excerpts WordPress generates, words run together', () => {
    expect(isAutoExcerpt('<p>Contactm@x.com or phone. Loading… Getting there by [&hellip;]</p>\n', content)).toBe(true)
    expect(isAutoExcerpt('', content)).toBe(true)
  })
  it('treats anything else as typed', () => {
    expect(isAutoExcerpt('<p>Hi All, If keen please submit an entry</p>', '<p>If keen please submit an entry</p>')).toBe(false)
  })
})
