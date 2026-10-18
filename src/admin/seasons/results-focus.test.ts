import { describe, expect, it } from 'vitest'
import type { Week } from '../../lib/fixtures'
import { focusDay } from './ResultsTab'

const game = (id: string, published: boolean) =>
  ({
    id,
    session: 0,
    court: 0,
    home: { team: 'a' },
    away: { team: 'b' },
    duty: null,
    ...(published
      ? {
          publishedResult: {
            home: 2,
            away: 0,
            sets: [
              [25, 10],
              [25, 12],
            ],
          },
        }
      : {}),
  }) as unknown as Week['games'][number]

const week = (id: string, date: string, published: boolean, kind: Week['kind'] = 'regular') =>
  ({ id, date, kind, matchDay: 1, games: kind === 'skip' ? [] : [game(`${id}-g`, published)] }) as unknown as Week

describe('focusDay (where the Results tab opens)', () => {
  const weeks = [
    week('w1', '2026-10-01', true),
    week('w2', '2026-10-08', false),
    week('off', '2026-10-15', false, 'skip'),
    week('w3', '2026-10-22', false),
  ]

  it('opens at tonight', () => {
    expect(focusDay(weeks, '2026-10-22', () => false)).toBe('w3')
  })
  it('else at the latest played night still to publish', () => {
    expect(focusDay(weeks, '2026-10-18', () => false)).toBe('w2')
  })
  it('else at the next night', () => {
    const done = [week('w1', '2026-10-01', true), week('w2', '2026-10-08', true), week('w3', '2026-10-22', false)]
    expect(focusDay(done, '2026-10-18', () => false)).toBe('w3')
  })
  it('ignores games that are off (cancelled, postponed, TBD)', () => {
    expect(focusDay(weeks, '2026-10-18', (id) => id === 'w2-g')).toBe('w3')
  })
  it('falls back to the last night once the season is over', () => {
    const done = [week('w1', '2026-10-01', true), week('w2', '2026-10-08', true)]
    expect(focusDay(done, '2026-12-01', () => false)).toBe('w2')
  })
})
