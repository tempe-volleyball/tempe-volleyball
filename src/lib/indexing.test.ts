import { describe, expect, it } from 'vitest'
import { isIndexable } from './indexing'

describe('isIndexable', () => {
  it('allows only production on www.tempevb.com', () => {
    expect(isIndexable(new URL('https://www.tempevb.com/ladders'), 'production')).toBe(true)
  })

  it('blocks production on workers.dev before the cutover', () => {
    expect(isIndexable(new URL('https://tempe-volleyball-production.tempevb.workers.dev/'), 'production')).toBe(false)
  })

  it('blocks staging even on the real host', () => {
    expect(isIndexable(new URL('https://www.tempevb.com/'), 'staging')).toBe(false)
  })
})
