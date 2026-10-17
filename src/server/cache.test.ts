import { describe, expect, it, vi } from 'vitest'
import { cachePublic, purgePage, purgePost, purgeSeason, purgeSite, purgeTags, PUBLIC_CACHE, tags, type RouteCache } from './cache'

const fakeCache = (enabled = true, invalidate: RouteCache['invalidate'] = async () => undefined) => {
  return { enabled, set: vi.fn<RouteCache['set']>(), invalidate: vi.fn<RouteCache['invalidate']>(invalidate) }
}

describe('cachePublic', () => {
  it('sets the public cache rule with the site tag first', () => {
    const c = fakeCache()
    cachePublic(c, tags.league('tnl'), tags.season('tnl-q4-2026'))
    expect(c.set).toHaveBeenCalledWith({ ...PUBLIC_CACHE, tags: ['site', 'league:tnl', 'season:tnl-q4-2026'] })
  })
})

describe('purge helpers', () => {
  it('purge the right tags, de-duplicated', async () => {
    const c = fakeCache()
    await purgeSeason(c, 'tnl', 'tnl-q4-2026')
    await purgePage(c, '/about-tempe-vb')
    await purgePage(c, '/contact', { inMenu: true })
    await purgePost(c, 'grand-finals')
    await purgeSite(c)
    await purgeTags(c, ['a', 'a', 'b'])
    expect(c.invalidate.mock.calls.map(([o]) => o.tags)).toEqual([
      ['season:tnl-q4-2026', 'league:tnl', 'site'],
      ['page:/about-tempe-vb'],
      ['page:/contact', 'site'],
      ['post:grand-finals', 'news', 'page:/'],
      ['site'],
      ['a', 'b'],
    ])
  })

  it('do nothing when caching is off (dev)', async () => {
    const c = fakeCache(false)
    expect(await purgeSite(c)).toEqual({ ok: true, tags: ['site'] })
    expect(c.invalidate).not.toHaveBeenCalled()
  })

  it('report a failed purge instead of throwing', async () => {
    const c = fakeCache(true, async () => {
      throw new Error('purge not available')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await purgeSite(c)).toEqual({ ok: false, tags: ['site'], error: 'purge not available' })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
