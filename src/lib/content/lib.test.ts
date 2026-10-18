import { describe, expect, it } from 'vitest'
import { checkMediaMeta, mediaKeys, mediaUrls, parseUploadFile, variantWidths } from './media'
import { checkPagePath, checkSlug, planMove, slugify, trailingSlashTarget } from './paths'
import { DEFAULT_SETTINGS, announcementActive, checkSetting, instagramHandle, readSettings, telHref } from './settings'

describe('trailingSlashTarget', () => {
  it('strips the trailing slash old WordPress URLs end in', () => {
    expect(trailingSlashTarget('/contact/')).toBe('/contact')
    expect(trailingSlashTarget('/ladders/')).toBe('/ladders')
    expect(trailingSlashTarget('/leagues/tnl/tnl-q4-2026/')).toBe('/leagues/tnl/tnl-q4-2026')
    expect(trailingSlashTarget('/feed//')).toBe('/feed')
  })
  it('leaves slashless paths, the home page, APIs, files and the admin alone', () => {
    for (const p of [
      '/',
      '/contact',
      '/api/health/',
      '/api/',
      '/media/abc/800.webp/',
      '/admin/',
      '/admin/pages/',
      '/_astro/x.css/',
      '/cdn-cgi/x/',
    ])
      expect.soft(trailingSlashTarget(p), p).toBeNull()
    expect(trailingSlashTarget('/administration/')).toBe('/administration')
    expect(trailingSlashTarget('/wp-admin/')).toBe('/wp-admin')
  })
  it('never produces a protocol-relative Location', () => {
    expect(trailingSlashTarget('//evil.example/')).toBe('/evil.example')
    expect(trailingSlashTarget('///evil.example//')).toBe('/evil.example')
    expect(trailingSlashTarget('/\\evil.example/')).toBeNull()
    expect(trailingSlashTarget('//')).toBe('/')
  })
})

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
  it('allows the intro page of /enrol and the kind index pages, but nothing under the kind prefixes', () => {
    for (const p of ['/enrol', '/training', '/programs', '/events']) expect.soft(checkPagePath(p)).toEqual({ ok: true, path: p })
    for (const p of ['/training/scrim', '/programs/adp', '/events/cup']) expect.soft(checkPagePath(p)).toMatchObject({ ok: false })
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
    expect(parseUploadFile('800.webp')).toEqual({ kind: 'variant', width: 800, ext: 'webp', mime: 'image/webp' })
    expect(parseUploadFile('800.jpg')).toEqual({ kind: 'variant', width: 800, ext: 'jpg', mime: 'image/jpeg' })
    for (const bad of ['original.svg', 'original.html', '1601.webp', '0800.webp', '../x.webp', 'original.jpg.html', '800.png', '800.jpeg'])
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
    // JPEG copies from browsers that can't encode WebP.
    const j = { ...m, variantExt: 'jpg' as const }
    expect(mediaKeys(j)).toEqual(['media/abc/800.jpg', 'media/abc/400.jpg', 'media/abc/original.png'])
    expect(mediaUrls(j)).toMatchObject({ src: '/media/abc/800.jpg', thumb: '/media/abc/400.jpg' })
  })
  it('checkMediaMeta', () => {
    const ok = checkMediaMeta({ filename: 'a.jpg', mime: 'image/jpeg', bytes: 1000, width: 1200, height: 800, variants: [800, 400, 1200] })
    expect(ok).toEqual({
      ok: true,
      value: {
        filename: 'a.jpg',
        mime: 'image/jpeg',
        bytes: 1000,
        width: 1200,
        height: 800,
        variants: [400, 800, 1200],
        variantExt: 'webp',
      },
    })
    const jpg = checkMediaMeta({
      filename: 'a.png',
      mime: 'image/png',
      bytes: 1000,
      width: 300,
      height: 200,
      variants: [300],
      variantExt: 'jpg',
    })
    expect(jpg.ok && jpg.value.variantExt).toBe('jpg')
    expect(
      checkMediaMeta({ filename: 'a.png', mime: 'image/png', bytes: 1000, width: 300, height: 200, variants: [300], variantExt: 'png' }).ok,
    ).toBe(false)
    expect(checkMediaMeta({ filename: 'a.svg', mime: 'image/svg+xml', bytes: 10 }).ok).toBe(false)
    expect(checkMediaMeta({ filename: 'a.jpg', mime: 'image/jpeg', bytes: 1000, width: 1200, height: 800, variants: [400] }).ok).toBe(false)
    expect(
      checkMediaMeta({ filename: 'a.jpg', mime: 'image/jpeg', bytes: 50 * 1024 * 1024, width: 10, height: 10, variants: [10] }).ok,
    ).toBe(false)
    expect(checkMediaMeta({ filename: 'rules.pdf', mime: 'application/pdf', bytes: 5000 })).toEqual({
      ok: true,
      value: { filename: 'rules.pdf', mime: 'application/pdf', bytes: 5000, width: null, height: null, variants: [], variantExt: 'webp' },
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
