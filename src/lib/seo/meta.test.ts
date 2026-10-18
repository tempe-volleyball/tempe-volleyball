import { describe, expect, it } from 'vitest'
import { DEFAULT_DESCRIPTION, tidyInternalLinks } from '../content'
import { socialFile } from '../content/media'
import { checkSetting, DEFAULT_SETTINGS } from '../content/settings'
import { sydneyIso } from '../time'
import { DEFAULT_SOCIAL_IMAGE, pickSocialImage, robotsMeta, siteDescription, socialImageUrl } from './meta'

const ID = '0f0e0d0c-0b0a-4908-8706-050403020100'
const OTHER = '11111111-2222-4333-8444-555555555555'

describe('pickSocialImage', () => {
  it('prefers the most specific image, then an explicit path, then the settings image, then the built-in one', () => {
    expect(pickSocialImage([null, ID, OTHER], { imageId: OTHER })).toEqual({ path: `/media/${ID}/social` })
    expect(pickSocialImage([null], { imageId: OTHER }, { path: '/x.jpg' })).toEqual({ path: '/x.jpg' })
    expect(pickSocialImage([], { imageId: OTHER })).toEqual({ path: `/media/${OTHER}/social` })
    expect(pickSocialImage([undefined], { imageId: '' })).toEqual({ ...DEFAULT_SOCIAL_IMAGE })
    expect(socialImageUrl('https://www.tempevb.com', [], { imageId: '' })).toBe('https://www.tempevb.com/images/og-default.jpg')
  })
})

describe('siteDescription', () => {
  it('swaps the built-in fallback for the settings default, and leaves real descriptions alone', () => {
    expect(siteDescription(DEFAULT_DESCRIPTION, { description: 'Ours.' })).toBe('Ours.')
    expect(siteDescription(DEFAULT_DESCRIPTION, { description: '' })).toBe(DEFAULT_DESCRIPTION)
    expect(siteDescription('A page.', { description: 'Ours.' })).toBe('A page.')
  })
})

describe('robotsMeta', () => {
  it('only says something for pages that opt out', () => {
    expect(robotsMeta(true)).toBe('noindex, follow')
    expect(robotsMeta(false)).toBeNull()
    expect(robotsMeta(undefined)).toBeNull()
  })
})

describe('socialFile', () => {
  it('picks the smallest variant at least 1200 px wide, else the largest, else a web image original', () => {
    expect(socialFile({ mime: 'image/jpeg', variants: [400, 800, 1600], variantExt: 'webp' })).toBe('1600.webp')
    expect(socialFile({ mime: 'image/jpeg', variants: [800, 400], variantExt: 'jpg' })).toBe('800.jpg')
    expect(socialFile({ mime: 'image/png', variants: [] })).toBe('original.png')
    expect(socialFile({ mime: 'application/pdf', variants: [] })).toBeNull()
  })
})

describe('the seo setting', () => {
  it('checks and normalises the defaults behind every page', () => {
    const ok = checkSetting('seo', {
      description: '  Social volleyball.  ',
      imageId: ID.toUpperCase(),
      alternateName: 'Tempe VB',
      foundingYear: '2005',
      sameAs: ['https://www.youtube.com/@tempe', '', 'https://www.youtube.com/@tempe'],
    })
    expect(ok).toEqual({
      ok: true,
      value: {
        description: 'Social volleyball.',
        imageId: ID,
        alternateName: 'Tempe VB',
        foundingYear: '2005',
        sameAs: ['https://www.youtube.com/@tempe'],
      },
    })
    expect(checkSetting('seo', { ...DEFAULT_SETTINGS.seo, imageId: 'nope' }).ok).toBe(false)
    expect(checkSetting('seo', { ...DEFAULT_SETTINGS.seo, foundingYear: '05' }).ok).toBe(false)
    expect(checkSetting('seo', { ...DEFAULT_SETTINGS.seo, sameAs: ['http://insecure.example'] }).ok).toBe(false)
    expect(checkSetting('seo', { ...DEFAULT_SETTINGS.seo, sameAs: 'https://a.example https://b.example' })).toMatchObject({
      ok: true,
      value: { sameAs: ['https://a.example', 'https://b.example'] },
    })
  })
})

describe('sydneyIso', () => {
  it('adds Sydney’s offset on that date (AEDT +11, AEST +10)', () => {
    expect(sydneyIso('2026-10-22', '18:30')).toBe('2026-10-22T18:30:00+11:00')
    expect(sydneyIso('2026-06-10', '09:05')).toBe('2026-06-10T09:05:00+10:00')
    expect(sydneyIso('2026-10-22')).toBe('2026-10-22')
    expect(sydneyIso('2026-10-22', 'late')).toBe('2026-10-22')
  })
})

describe('tidyInternalLinks', () => {
  it('drops the trailing slash of internal links, keeping the query and fragment', () => {
    const html =
      '<p><a href="/contact/">C</a> <a class="x" href="/where-we-play/?a=1&amp;b=2#map">W</a> <a href="/">H</a> <a href="https://ex.com/a/">E</a> <a href="/media/x/">M</a> <a href="//evil.com/">P</a> <a href="/rules">R</a></p>'
    expect(tidyInternalLinks(html)).toBe(
      '<p><a href="/contact">C</a> <a class="x" href="/where-we-play?a=1&amp;b=2#map">W</a> <a href="/">H</a> <a href="https://ex.com/a/">E</a> <a href="/media/x/">M</a> <a href="//evil.com/">P</a> <a href="/rules">R</a></p>',
    )
  })
  it('points links at old URLs straight at their redirect target', () => {
    const targets = new Map([
      ['/ladders', '/leagues/tnl#ladder'],
      ['/new-player-2023', '/enrol'],
    ])
    const out = tidyInternalLinks('<a href="/ladders/">L</a><a href="/ladders/#top">T</a><a href="/new-player-2023/?x=1">N</a>', (p) =>
      targets.get(p),
    )
    expect(out).toBe('<a href="/leagues/tnl#ladder">L</a><a href="/leagues/tnl#top">T</a><a href="/enrol?x=1">N</a>')
  })
})
