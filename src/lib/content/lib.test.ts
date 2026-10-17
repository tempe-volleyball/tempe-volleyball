import { describe, expect, it } from 'vitest'
import { buildMenuTree, checkMenu, menuToInput } from './menu'
import { checkMediaMeta, mediaKeys, mediaUrls, parseUploadFile, variantWidths } from './media'
import { checkPagePath, checkSlug, planMove, slugify } from './paths'
import { DEFAULT_SETTINGS, announcementActive, checkSetting, instagramHandle, readSettings, telHref } from './settings'

describe('page paths', () => {
  it('normalises what people type', () => {
    expect(checkPagePath('about')).toEqual({ ok: true, path: '/about' })
    expect(checkPagePath(' /About/Rules/ ')).toEqual({ ok: true, path: '/about/rules' })
    expect(checkPagePath('/')).toEqual({ ok: true, path: '/' })
    expect(checkPagePath('//where-we-play')).toEqual({ ok: true, path: '/where-we-play' })
  })
  it('rejects bad paths', () => {
    for (const bad of ['', '/about us', '/über', '/a--b', '/-a', '/a?b', '/a#b', '/a/b/c/d', `/${'a'.repeat(201)}`])
      expect.soft(checkPagePath(bad)).toMatchObject({ ok: false })
  })
  it('keeps routes and files reserved', () => {
    for (const r of ['/admin', '/admin/pages', '/api/x', '/media/x', '/news', '/news/post', '/leagues/tnl', '/robots.txt'])
      expect.soft(checkPagePath(r)).toMatchObject({ ok: false })
    expect(checkPagePath('/newsletter').ok).toBe(true)
    expect(checkPagePath('/administration').ok).toBe(true)
  })
  it('slugify', () => {
    expect(slugify('Junior Dev Program (JDP)!')).toBe('junior-dev-program-jdp')
    expect(slugify('Scrim & Coached Training')).toBe('scrim-and-coached-training')
    expect(slugify("Michael's Café")).toBe('michaels-cafe')
    expect(slugify('---')).toBe('')
  })
  it('checkSlug', () => {
    expect(checkSlug('Season-Starts')).toEqual({ ok: true, slug: 'season-starts' })
    expect(checkSlug('season starts').ok).toBe(false)
    expect(checkSlug('a/b').ok).toBe(false)
  })
  it('planMove', () => {
    expect(planMove('/about', '/about/')).toBeNull()
    expect(planMove('/about-tempe-vb', '/about')).toEqual({ from: '/about-tempe-vb', to: '/about' })
  })
})

describe('menu', () => {
  const PAGE = '11111111-1111-4111-8111-111111111111'
  const LEAGUE = '22222222-2222-4222-8222-222222222222'
  const known = { pageIds: new Set([PAGE]), leagueIds: new Set([LEAGUE]) }
  let n = 0
  const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

  it('flattens a two-level tree into rows with parents and sort order', () => {
    const res = checkMenu(
      [
        { label: 'Home', kind: 'page', pageId: PAGE },
        {
          label: ' Mixed   Leagues ',
          kind: 'url',
          children: [
            { label: 'TNL Ladder', kind: 'league_ladder', leagueId: LEAGUE },
            { label: 'Instagram', kind: 'url', url: 'https://www.instagram.com/tempe.volleyball/' },
          ],
        },
      ],
      known,
      newId,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.rows.map((r) => [r.label, r.parentId === null, r.sort, r.kind])).toEqual([
      ['Home', true, 0, 'page'],
      ['Mixed Leagues', true, 1, 'url'],
      ['TNL Ladder', false, 0, 'league_ladder'],
      ['Instagram', false, 1, 'url'],
    ])
    expect(res.rows[2]!.parentId).toBe(res.rows[1]!.id)
    expect(res.rows[1]!.url).toBeNull()
  })

  it('keeps valid ids and replaces bad or duplicate ones', () => {
    const id = '33333333-3333-4333-8333-333333333333'
    const res = checkMenu(
      [
        { id, label: 'A', kind: 'url', url: '/a' },
        { id, label: 'B', kind: 'url', url: '/b' },
        { id: 'nope', label: 'C', kind: 'url', url: '/c' },
      ],
      known,
      newId,
    )
    expect(res.ok && res.rows.map((r) => r.id === id)).toEqual([true, false, false])
  })

  it('rejects bad items', () => {
    const bad = [
      [{ label: '', kind: 'url' }],
      [{ label: 'x', kind: 'weird' }],
      [{ label: 'x', kind: 'page', pageId: 'missing' }],
      [{ label: 'x', kind: 'league_fixtures' }],
      [{ label: 'x', kind: 'url', url: 'javascript:alert(1)' }],
      [{ label: 'x', kind: 'url', children: [{ label: 'y', kind: 'url', children: [{ label: 'z', kind: 'url' }] }] }],
      'not a list',
      Array.from({ length: 21 }, () => ({ label: 'x', kind: 'url' })),
    ]
    for (const b of bad) expect.soft(checkMenu(b, known, newId)).toMatchObject({ ok: false })
  })

  it('builds the tree with links, hiding unpublished pages on the public site', () => {
    const rows = [
      { id: 'b', parentId: null, label: 'About', kind: 'url' as const, pageId: null, leagueId: null, url: null, sort: 1 },
      { id: 'a', parentId: null, label: 'Home', kind: 'page' as const, pageId: 'p1', leagueId: null, url: null, sort: 0 },
      { id: 'c', parentId: 'b', label: 'Draft page', kind: 'page' as const, pageId: 'p2', leagueId: null, url: null, sort: 0 },
      { id: 'd', parentId: 'b', label: 'Ladder', kind: 'league_ladder' as const, pageId: null, leagueId: 'l1', url: null, sort: 1 },
      { id: 'e', parentId: null, label: 'Empty heading', kind: 'url' as const, pageId: null, leagueId: null, url: null, sort: 2 },
    ]
    const lookups = { pagePath: (id: string) => ({ p1: '/' })[id] ?? null, leagueSlug: (id: string) => (id === 'l1' ? 'tnl' : null) }
    const admin = buildMenuTree(rows, lookups)
    expect(admin.map((x) => x.label)).toEqual(['Home', 'About', 'Empty heading'])
    expect(admin[1]!.children.map((c) => [c.label, c.href])).toEqual([
      ['Draft page', null],
      ['Ladder', '/leagues/tnl#ladder'],
    ])
    const pub = buildMenuTree(rows, lookups, { publicOnly: true })
    expect(pub.map((x) => x.label)).toEqual(['Home', 'About'])
    expect(pub[1]!.children.map((c) => c.label)).toEqual(['Ladder'])
    expect(menuToInput(admin)[1]!.children!.length).toBe(2)
  })
})

describe('media', () => {
  it('variantWidths matches the importer', () => {
    expect(variantWidths(3000)).toEqual([400, 800, 1600])
    expect(variantWidths(1500)).toEqual([400, 800, 1500])
    expect(variantWidths(800)).toEqual([400, 800])
    expect(variantWidths(300)).toEqual([300])
    expect(variantWidths(0)).toEqual([])
  })
  it('parseUploadFile', () => {
    expect(parseUploadFile('original.jpg')).toEqual({ kind: 'original', ext: 'jpg', mime: 'image/jpeg' })
    expect(parseUploadFile('original.pdf')).toEqual({ kind: 'original', ext: 'pdf', mime: 'application/pdf' })
    expect(parseUploadFile('800.webp')).toEqual({ kind: 'variant', width: 800, mime: 'image/webp' })
    for (const bad of ['original.svg', 'original.html', '1601.webp', '0800.webp', '../x.webp', 'original.jpg.html'])
      expect.soft(parseUploadFile(bad)).toBeNull()
  })
  it('keys and urls', () => {
    const m = { id: 'abc', keyBase: 'media/abc', mime: 'image/png', variants: [800, 400] }
    expect(mediaKeys(m)).toEqual(['media/abc/800.webp', 'media/abc/400.webp', 'media/abc/original.png'])
    expect(mediaUrls(m)).toEqual({
      src: '/media/abc/800.webp',
      srcset: '/media/abc/400.webp 400w, /media/abc/800.webp 800w',
      thumb: '/media/abc/400.webp',
      original: '/media/abc/original.png',
    })
    expect(mediaUrls({ id: 'p', mime: 'application/pdf', variants: [] }).src).toBe('/media/p/original.pdf')
  })
  it('checkMediaMeta', () => {
    const ok = checkMediaMeta({ filename: 'a.jpg', mime: 'image/jpeg', bytes: 1000, width: 1200, height: 800, variants: [800, 400, 1200] })
    expect(ok).toEqual({
      ok: true,
      value: { filename: 'a.jpg', mime: 'image/jpeg', bytes: 1000, width: 1200, height: 800, variants: [400, 800, 1200] },
    })
    expect(checkMediaMeta({ filename: 'a.svg', mime: 'image/svg+xml', bytes: 10 }).ok).toBe(false)
    expect(checkMediaMeta({ filename: 'a.jpg', mime: 'image/jpeg', bytes: 1000, width: 1200, height: 800, variants: [400] }).ok).toBe(false)
    expect(
      checkMediaMeta({ filename: 'a.jpg', mime: 'image/jpeg', bytes: 50 * 1024 * 1024, width: 10, height: 10, variants: [10] }).ok,
    ).toBe(false)
    expect(checkMediaMeta({ filename: 'rules.pdf', mime: 'application/pdf', bytes: 5000 })).toEqual({
      ok: true,
      value: { filename: 'rules.pdf', mime: 'application/pdf', bytes: 5000, width: null, height: null, variants: [] },
    })
  })
})

describe('settings', () => {
  it('validates and normalises values', () => {
    expect(checkSetting('contact', { name: ' Michael ', phone: '0414 911 544', email: 'TempeVB@Gmail.com' })).toEqual({
      ok: true,
      value: { name: 'Michael', phone: '0414 911 544', email: 'tempevb@gmail.com' },
    })
    expect(checkSetting('contact', { email: 'nope' }).ok).toBe(false)
    expect(checkSetting('contact', { phone: 'call me' }).ok).toBe(false)
    expect(checkSetting('social', { instagram: 'http://instagram.com/x' }).ok).toBe(false)
    expect(checkSetting('revolutioniseUrl', 'https://revolutionise.com.au/sydneyuni').ok).toBe(true)
    expect(checkSetting('payid', { payId: 'tempevb@gmail.com', name: 'M' }).ok).toBe(true)
    expect(checkSetting('payid', { payId: '0414 911 544' }).ok).toBe(true)
    expect(checkSetting('payid', { payId: 'my bank' }).ok).toBe(false)
  })
  it('announcement', () => {
    expect(checkSetting('announcement', { enabled: true, text: '' }).ok).toBe(false)
    expect(checkSetting('announcement', { enabled: true, text: 'No games this week', linkUrl: 'javascript:x' }).ok).toBe(false)
    const res = checkSetting('announcement', { enabled: true, text: 'Rain!', tone: 'warning', endsAt: '2026-10-20T00:00:00+11:00' })
    expect(res.ok && res.value).toMatchObject({ enabled: true, tone: 'warning', endsAt: '2026-10-19T13:00:00.000Z' })
    if (!res.ok) return
    expect(announcementActive(res.value, new Date('2026-10-19T12:00:00Z'))).toBe(true)
    expect(announcementActive(res.value, new Date('2026-10-19T14:00:00Z'))).toBe(false)
  })
  it('readSettings falls back to defaults for missing or bad rows', () => {
    const s = readSettings([
      { key: 'contact', value: { name: 'M', phone: '', email: 'm@x.com' } },
      { key: 'social', value: 'garbage' },
      { key: 'other', value: 1 },
    ])
    expect(s.contact.name).toBe('M')
    expect(s.social).toEqual(DEFAULT_SETTINGS.social)
  })
  it('telHref and instagramHandle', () => {
    expect(telHref('0414 911 544')).toBe('tel:+61414911544')
    expect(telHref('+61 2 9999 0000')).toBe('tel:+61299990000')
    expect(instagramHandle('https://www.instagram.com/tempe.volleyball/')).toBe('tempe.volleyball')
  })
})
