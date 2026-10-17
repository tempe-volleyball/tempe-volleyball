import { uid } from './rng'
import type { Competition, Settings } from './types'

/** Settings for a new, empty competition. The seed is random; keep it to reproduce a draw. */
export function blankSettings(): Settings {
  return {
    name: 'New competition',
    startDate: '',
    skipDates: [],
    courts: ['Court 1', 'Court 2'],
    sessions: ['20:00', '21:00'],
    sessionMinutes: 60,
    teams: [],
    meetings: 1,
    includeFinals: true,
    seed: Math.floor(Math.random() * 1e9),
  }
}

export function newCompetition(settings: Settings = blankSettings()): Competition {
  return { id: uid(), settings, weeks: null, edited: false, updatedAt: Date.now() }
}

/** A Thursday league shaped like the current one on tempevb.com, for tests and local dev. */
export function demoCompetition(): Competition {
  const teams = [
    'Hit For Brains',
    'Ice Cold',
    'Backcourt Liberos',
    'Benchwarmers',
    'Penguins',
    'KBU',
    'Teletobies',
    'Just The Tip',
    'Aim Bot',
  ].map((name) => ({ id: uid(), name }))
  return newCompetition({
    ...blankSettings(),
    name: 'Thursday Night League',
    startDate: '2027-02-04',
    courts: ['Court 1', 'Court 3'],
    sessions: ['20:00', '21:00'],
    teams,
  })
}
