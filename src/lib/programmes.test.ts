import { describe, expect, it } from 'vitest'
import { changedSourceFields, type ProgrammeLineSource } from './content/blocks'
import { categoryPath, effectiveCap, enrolmentOpen, inherit, programmePath } from './programmes'

describe('programme paths', () => {
  it('are flat by kind', () => {
    expect(programmePath('league', 'tnl')).toBe('/leagues/tnl')
    expect(programmePath('training', 'scrim')).toBe('/training/scrim')
    expect(programmePath('development', 'jdp')).toBe('/programs/jdp')
    expect(programmePath('event', 'tempe-cup')).toBe('/events/tempe-cup')
    expect(categoryPath('mixed-leagues')).toBe('/mixed-leagues')
  })
})

describe('caps and inherited settings', () => {
  it('prefer the instance, then the programme, else unlimited', () => {
    expect(effectiveCap(32, 40)).toBe(32)
    expect(effectiveCap(null, 40)).toBe(40)
    expect(effectiveCap(0, 40)).toBe(0)
    expect(effectiveCap(null, null)).toBeNull()
    expect(inherit(null, true)).toBe(true)
    expect(inherit(false, true)).toBe(false)
  })
})

describe('enrolmentOpen', () => {
  const programme = { open: true, status: 'active' as const, opensAt: '2026-10-01T00:00:00.000Z', closesAt: '2026-11-01T00:00:00.000Z' }
  const now = '2026-10-18T00:00:00.000Z'

  it('needs the switch, an active programme and the window', () => {
    expect(enrolmentOpen(programme, null, now)).toBe(true)
    expect(enrolmentOpen({ ...programme, open: false }, null, now)).toBe(false)
    expect(enrolmentOpen({ ...programme, status: 'retired' }, null, now)).toBe(false)
    expect(enrolmentOpen(programme, null, '2026-09-30T23:59:59.999Z')).toBe(false)
    expect(enrolmentOpen(programme, null, '2026-11-01T00:00:00.000Z')).toBe(false)
    expect(enrolmentOpen({ ...programme, opensAt: null, closesAt: null }, null, now)).toBe(true)
  })

  it('lets a product narrow but not widen the window', () => {
    expect(enrolmentOpen(programme, { active: true, opensAt: null, closesAt: null }, now)).toBe(true)
    expect(enrolmentOpen(programme, { active: false, opensAt: null, closesAt: null }, now)).toBe(false)
    expect(enrolmentOpen(programme, { active: true, opensAt: null, closesAt: '2026-10-10T00:00:00.000Z' }, now)).toBe(false)
    expect(enrolmentOpen({ ...programme, open: false }, { active: true, opensAt: null, closesAt: null }, now)).toBe(false)
  })
})

describe('changedSourceFields', () => {
  it('lists what changed since an override was written', () => {
    const then: ProgrammeLineSource = {
      name: 'Thursday Night League',
      code: 'TNL',
      venue: 'Tempe',
      times: '8–10pm',
      nextStarts: '',
      summaryLine: '',
    }
    expect(changedSourceFields(then, { ...then })).toEqual([])
    expect(changedSourceFields(then, { ...then, venue: 'Burwood', times: '7–9pm' })).toEqual(['venue', 'times'])
  })
})
