import { describe, expect, it } from 'vitest'
import { duplicateGroups, shareASeason, teamKey } from './teams'

const t = (id: string, name: string, seasons: string[] = []) => ({ id, name, history: seasons.map((s) => ({ id: s })) })

describe('teamKey', () => {
  it('ignores case, punctuation, spaces, accents and a leading "the"', () => {
    expect(teamKey('ICE COLD!')).toBe(teamKey('Ice Cold'))
    expect(teamKey('The Aces')).toBe(teamKey('aces'))
    expect(teamKey('Kéy & Co.')).toBe('keyandco')
    expect(teamKey('Ice Cold 2')).not.toBe(teamKey('Ice Cold'))
  })
})

describe('duplicateGroups', () => {
  it('suggests teams that look alike, keeping the one with the most seasons', () => {
    const groups = duplicateGroups([t('a', 'Ice Cold', ['s1']), t('b', 'ICE COLD!', ['s2', 's3']), t('c', 'Aces'), t('d', 'Blockers')])
    expect(groups.map((g) => g.map((x) => x.id))).toEqual([['b', 'a']])
  })

  it('leaves out teams that played in the same season', () => {
    expect(duplicateGroups([t('a', 'Aces', ['s1']), t('b', 'The Aces', ['s1'])])).toEqual([])
    expect(shareASeason(t('a', 'x', ['s1', 's2']), t('b', 'y', ['s2']))).toBe(true)
  })
})
