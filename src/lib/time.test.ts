import { describe, expect, it } from 'vitest'
import { daysBetween, formatAud, relativeDays, sydneyDate, sydneyDateTime } from './time'

describe('sydneyDateTime', () => {
  it('uses AEDT (+11) in summer', () => {
    expect(sydneyDateTime(new Date('2026-12-03T10:00:00Z'))).toBe('2026-12-03 21:00')
  })

  it('uses AEST (+10) in winter', () => {
    expect(sydneyDateTime(new Date('2026-07-01T10:00:00Z'))).toBe('2026-07-01 20:00')
  })

  it('rolls the date over at Sydney midnight, not UTC midnight', () => {
    expect(sydneyDateTime(new Date('2026-10-16T14:30:00Z'))).toBe('2026-10-17 01:30')
  })
})

describe('sydneyDate', () => {
  it('is the Sydney calendar day', () => {
    expect(sydneyDate(new Date('2026-10-16T13:59:00Z'))).toBe('2026-10-17')
    expect(sydneyDate(new Date('2026-10-16T12:59:00Z'))).toBe('2026-10-16')
  })
})

describe('daysBetween and relativeDays', () => {
  it('counts calendar days, across a DST change too', () => {
    expect(daysBetween('2026-10-18', '2026-10-22')).toBe(4)
    expect(daysBetween('2026-10-03', '2026-10-05')).toBe(2)
    expect(daysBetween('2026-10-22', '2026-10-18')).toBe(-4)
    expect([0, 1, 4, -1, -3].map(relativeDays)).toEqual(['today', 'tomorrow', 'in 4 days', 'yesterday', '3 days ago'])
  })
})

describe('formatAud', () => {
  it('formats cents as Australian dollars', () => {
    expect(formatAud(12500)).toBe('$125.00')
    expect(formatAud(0)).toBe('$0.00')
  })
})
