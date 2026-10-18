import { describe, expect, it } from 'vitest'
import { canonicalSearch, normalisesQuery, queryRedirect, trackingQuery } from './canonical-query'

describe('queryRedirect', () => {
  it('leaves URLs without a query alone', () => {
    expect(queryRedirect('/', '')).toBeNull()
    expect(queryRedirect('/leagues/tnl', '')).toBeNull()
  })

  it('drops parameters a page does not read (cache busting)', () => {
    expect(queryRedirect('/', '?x=123')).toBe('/')
    expect(queryRedirect('/leagues/tnl', '?view=upcoming')).toBe('/leagues/tnl')
    expect(queryRedirect('/leagues/tnl/calendar.ics', '?nocache=1')).toBe('/leagues/tnl/calendar.ics')
  })

  it('keeps the fixture list parameters in a fixed order, without defaults or junk', () => {
    expect(queryRedirect('/leagues/fixtures', '?view=upcoming&league=tnl')).toBeNull()
    expect(queryRedirect('/leagues/fixtures', '?league=tnl&view=upcoming')).toBe('/leagues/fixtures?view=upcoming&league=tnl')
    expect(queryRedirect('/leagues/fixtures', '?view=week&league=&team=')).toBe('/leagues/fixtures')
    expect(queryRedirect('/leagues/fixtures', '?view=upcoming&x=1&league=TNL')).toBe('/leagues/fixtures?view=upcoming&league=tnl')
    expect(queryRedirect('/leagues/fixtures', '?league=../etc')).toBe('/leagues/fixtures')
  })

  it('never answers with a protocol-relative Location (// or /\\), even if a double slash reaches it', () => {
    for (const path of ['//evil.com', '/\\evil.com', '///evil.com', '/\\/evil.com', '//evil.com/x']) {
      const to = queryRedirect(path, '?x=1')!
      expect(to).toMatch(/^\/[^/\\]/)
      expect(new URL(to, 'https://www.tempevb.com').origin).toBe('https://www.tempevb.com')
    }
    expect(queryRedirect('//evil.com', '?x=1')).toBe('/evil.com')
    expect(queryRedirect('/\\evil.com', '?utm_source=a&x=1')).toBe('/evil.com?utm_source=a')
  })

  it('keeps campaign tracking parameters after the page’s own, in a fixed order', () => {
    expect(queryRedirect('/', '?utm_source=instagram&utm_medium=social')).toBeNull()
    expect(queryRedirect('/', '?utm_medium=social&utm_source=instagram&x=1')).toBe('/?utm_source=instagram&utm_medium=social')
    expect(queryRedirect('/leagues/fixtures', '?utm_source=ig&league=tnl')).toBe('/leagues/fixtures?league=tnl&utm_source=ig')
    expect(queryRedirect('/', `?utm_source=${'a'.repeat(201)}`)).toBe('/')
  })

  it('is idempotent: a redirect target never redirects again', () => {
    for (const [path, search] of [
      ['/leagues/fixtures', '?team=ice-cold&league=tnl&view=upcoming&utm_campaign=q4%20launch&fbclid=abc'],
      ['/', '?utm_source=a+b&utm_term=%E2%9C%93'],
      ['/news', '?a=1&a=2'],
    ] as const) {
      const to = queryRedirect(path, search) ?? `${path}${search}`
      const u = new URL(to, 'https://x.test')
      expect(queryRedirect(u.pathname, u.search)).toBeNull()
    }
  })

  it('leaves the admin, APIs, media and build assets alone', () => {
    for (const p of ['/admin/pages', '/api/admin/stats', '/api/enrol', '/media/abc/x.webp', '/_astro/a.js', '/_image', '/cdn-cgi/x'])
      expect(normalisesQuery(p)).toBe(false)
    expect(queryRedirect('/api/admin/stats', '?from=2026-01-01')).toBeNull()
    expect(normalisesQuery('/administration')).toBe(true)
  })
})

describe('trackingQuery / canonicalSearch', () => {
  it('takes the first non-empty value of each tracking parameter', () => {
    expect(trackingQuery(new URLSearchParams('gclid=1&gclid=2&utm_source=&utm_medium=x'))).toBe('utm_medium=x&gclid=1')
    expect(canonicalSearch('/', new URLSearchParams('q=1'))).toBe('')
  })
})
