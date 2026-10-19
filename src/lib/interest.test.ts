import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from './content/settings'
import { checkMembers, depositFor, formatDeposit, interestPath, joinLine, signupModeOf, takesInterest } from './interest'

describe('sign-up modes', () => {
  it('falls back to the kind default: leagues and events take EOIs, training and development enrol', () => {
    expect(signupModeOf({ kind: 'league', signupMode: null })).toBe('interest')
    expect(signupModeOf({ kind: 'event' })).toBe('interest')
    expect(signupModeOf({ kind: 'training', signupMode: null })).toBe('enrolment')
    expect(signupModeOf({ kind: 'development' })).toBe('enrolment')
    expect(signupModeOf({ kind: 'league', signupMode: 'enrolment' })).toBe('enrolment')
    expect(signupModeOf({ kind: 'training', signupMode: 'interest' })).toBe('interest')
  })

  it('offers only active interest programmes with EOIs on (missing = on)', () => {
    expect(takesInterest({ kind: 'league', status: 'active' })).toBe(true)
    expect(takesInterest({ kind: 'league', status: 'active', interestOpen: false })).toBe(false)
    expect(takesInterest({ kind: 'league', status: 'retired' })).toBe(false)
    expect(takesInterest({ kind: 'league', status: 'draft' })).toBe(false)
    expect(takesInterest({ kind: 'training', status: 'active' })).toBe(false)
  })

  it('builds the form paths', () => {
    expect(interestPath()).toBe('/interest')
    expect(interestPath('tnl')).toBe('/interest/tnl')
  })
})

describe('joinLine', () => {
  it('prefers the hand-written text, else the next start as a sentence, else nothing', () => {
    expect(joinLine('  Season 1 starts in January. ', 'Next season starts Thursday 14 January 2027')).toBe('Season 1 starts in January.')
    expect(joinLine(null, 'Next season starts Thursday 14 January 2027')).toBe('Next season starts Thursday 14 January 2027.')
    expect(joinLine('', 'Starts soon!')).toBe('Starts soon!')
    expect(joinLine(null, '')).toBe('')
  })
})

describe('depositFor', () => {
  const tnl = { depositPlayerCents: null, depositTeamCents: 20000 }
  const fnl = { depositPlayerCents: 2500, depositTeamCents: 15000 }
  it('takes the highest deposit of the programmes picked for the entry type', () => {
    expect(depositFor('team', [tnl, fnl])).toBe(20000)
    expect(depositFor('player', [tnl, fnl])).toBe(2500)
    expect(depositFor('player', [tnl])).toBeNull()
    expect(depositFor('team', [])).toBeNull()
    expect(depositFor('team', [{ depositPlayerCents: 0, depositTeamCents: 0 }])).toBeNull()
  })
  it('formats AUD', () => {
    expect(formatDeposit(20000)).toBe('$200')
    expect(formatDeposit(1250)).toBe('$12.50')
  })
})

describe('checkMembers', () => {
  const modes = DEFAULT_SETTINGS.interest.memberFields
  const opts = { max: 3, currentYear: 2026 }
  it('keeps named members, drops blank rows and switched-off details', () => {
    const r = checkMembers(
      [
        { firstName: ' Jo ', lastName: 'Park', email: 'JO@example.com', birthYear: '1990', gender: 'male' },
        { firstName: '', lastName: '  ' },
        { firstName: 'Sam', lastName: 'Ng', phone: '0400 111 222' },
      ],
      modes,
      opts,
    )
    expect(r).toEqual({
      ok: true,
      members: [
        { firstName: 'Jo', lastName: 'Park', email: 'jo@example.com', phone: null, gender: 'male', birthYear: null, vnswNumber: null },
        { firstName: 'Sam', lastName: 'Ng', email: null, phone: '0400 111 222', gender: null, birthYear: null, vnswNumber: null },
      ],
    })
    expect(checkMembers(undefined, modes, opts)).toEqual({ ok: true, members: [] })
  })

  it('needs names and the required details, checks formats, and keys errors by the row sent', () => {
    const required = { email: 'required', phone: 'required', gender: 'required', birthYear: 'required', vnswNumber: 'required' } as const
    const r = checkMembers(
      [
        {},
        { firstName: 'Jo', lastName: '', email: 'nope', phone: 'call me', gender: 'x', birthYear: 3000, vnswNumber: 'x'.repeat(31) },
        { firstName: 'Al' },
      ],
      required,
      opts,
    )
    expect(r.ok).toBe(false)
    expect(Object.keys(r.ok ? {} : r.errors).toSorted()).toEqual(
      [
        'members.1.lastName',
        'members.1.email',
        'members.1.phone',
        'members.1.gender',
        'members.1.birthYear',
        'members.1.vnswNumber',
        'members.2.lastName',
        'members.2.email',
        'members.2.phone',
        'members.2.gender',
        'members.2.birthYear',
        'members.2.vnswNumber',
      ].toSorted(),
    )
  })

  it('refuses more than the most allowed, and anything but a list', () => {
    const three = ['A', 'B', 'C', 'D'].map((n) => ({ firstName: n, lastName: 'X' }))
    expect(checkMembers(three, modes, opts)).toEqual({ ok: false, errors: { members: 'At most 3 team members besides the captain.' } })
    expect(checkMembers([{ firstName: 'A', lastName: 'B' }], modes, { ...opts, max: 0 })).toEqual({
      ok: false,
      errors: { members: 'This form takes the captain only.' },
    })
    expect(checkMembers('Jo', modes, opts).ok).toBe(false)
  })
})
