import { describe, expect, it } from 'vitest'
import { programmeKinds } from '../../server/db/schema/enums'
import { csvCell, enrolmentsCsv } from './csv'
import { DEFAULT_FORM_FIELDS, entryTypesFor } from './defaults'
import type { FormField } from './forms'
import { newReference, parseReference, REFERENCE_PATTERN } from './reference'
import { formatDate, formatTime, sessionLabel } from './targets'
import { checkFormFields, suggestKey, validateEnrolment, visibleFields } from './validate'

const opts = { currentYear: 2026 }
const person = { firstName: ' Pat ', lastName: 'Lee', email: 'Pat@Example.COM ', phone: '0400 000 000' }

describe('form definitions', () => {
  it('accepts every default form', () => {
    for (const kind of programmeKinds) expect(checkFormFields(DEFAULT_FORM_FIELDS[kind])).toMatchObject({ ok: true })
  })

  it('rejects bad keys, duplicates, empty choices and unsafe links', () => {
    expect(checkFormFields([{ key: 'Bad Key', type: 'text', label: 'X' }])).toMatchObject({ ok: false })
    expect(
      checkFormFields([
        { key: 'a', type: 'text', label: 'A' },
        { key: 'a', type: 'text', label: 'B' },
      ]),
    ).toMatchObject({ ok: false })
    expect(checkFormFields([{ key: 'a', type: 'select', label: 'A', options: [] }])).toMatchObject({ ok: false })
    expect(checkFormFields([{ key: 'a', type: 'consent', label: 'A', href: 'javascript:alert(1)' }])).toMatchObject({ ok: false })
    expect(checkFormFields([{ key: 'a', type: 'nope', label: 'A' }])).toMatchObject({ ok: false })
    expect(
      checkFormFields([
        { key: 'g1', type: 'guardian', label: 'G' },
        { key: 'g2', type: 'guardian', label: 'G2' },
      ]),
    ).toMatchObject({ ok: false })
  })

  it('keeps keys permanent: no deleting, only compatible type changes', () => {
    const prev: FormField[] = [{ key: 'notes', type: 'text', label: 'Notes' }]
    expect(checkFormFields([], prev)).toMatchObject({ ok: false })
    expect(checkFormFields([{ key: 'notes', type: 'textarea', label: 'Notes' }], prev)).toMatchObject({ ok: true })
    expect(checkFormFields([{ key: 'notes', type: 'number', label: 'Notes' }], prev)).toMatchObject({ ok: false })
    expect(checkFormFields([{ key: 'notes', type: 'text', label: 'Notes', retired: true }], prev)).toMatchObject({ ok: true })
  })

  it('checks showIf targets and normalises consent and team names', () => {
    expect(checkFormFields([{ key: 'b', type: 'text', label: 'B', showIf: { key: 'missing', equals: 'x' } }])).toMatchObject({ ok: false })
    const ok = checkFormFields([
      { key: 'c', type: 'consent', label: 'Agree' },
      { key: 't', type: 'team_name', label: 'Team' },
    ])
    expect(ok.ok && ok.fields).toEqual([
      { key: 'c', type: 'consent', label: 'Agree', required: true },
      { key: 't', type: 'team_name', label: 'Team', appliesTo: ['team'] },
    ])
  })

  it('suggests unused keys', () => {
    expect(suggestKey('Skill level', [])).toBe('skill_level')
    expect(suggestKey('Skill level', ['skill_level'])).toBe('skill_level_2')
    expect(suggestKey('2nd choice', [])).toBe('q_2nd_choice')
  })
})

describe('validateEnrolment', () => {
  const fields: FormField[] = [
    {
      key: 'level',
      type: 'radio',
      label: 'Level',
      required: true,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    },
    { key: 'why', type: 'text', label: 'Why B?', required: true, showIf: { key: 'level', equals: 'b' } },
    { key: 'team_name', type: 'team_name', label: 'Team', appliesTo: ['team'] },
    { key: 'birth_year', type: 'birth_year', label: 'Born', required: true },
    { key: 'guardian', type: 'guardian', label: 'Guardian', required: true },
    { key: 'old', type: 'text', label: 'Old', retired: true },
    { key: 'agree', type: 'consent', label: 'Agree' },
  ]

  it('normalises the person and maps fixed-column answers out of `answers`', () => {
    const r = validateEnrolment(
      fields,
      'player',
      person,
      {
        level: 'a',
        why: 'ignored (hidden)',
        team_name: 'ignored (not a team)',
        birth_year: '2014',
        guardian: { name: 'Sam Lee', email: 'SAM@example.com', phone: '0411 111 111' },
        old: 'ignored (retired)',
        agree: true,
        unknown: 'dropped',
      },
      opts,
    )
    expect(r).toEqual({
      ok: true,
      person: { firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com', phone: '0400 000 000' },
      answers: { level: 'a', agree: true },
      mapped: { birthYear: 2014, guardian: { name: 'Sam Lee', email: 'sam@example.com', phone: '0411 111 111' } },
    })
  })

  it("asks a guardian's email and phone once: the contact details are theirs", () => {
    const r = validateEnrolment(
      fields,
      'player',
      person,
      { level: 'a', birth_year: 2014, guardian: { name: 'Sam Lee' }, agree: true },
      opts,
    )
    expect(r.ok ? null : r.errors).toBeNull()
    expect(r.ok && r.mapped.guardian).toEqual({ name: 'Sam Lee', email: 'pat@example.com', phone: '0400 000 000' })
  })

  it('reports one error per field, including conditional ones and age limits', () => {
    const r = validateEnrolment(fields, 'team', { ...person, email: 'x' }, { level: 'b', birth_year: 2000 }, { ...opts, ageMax: 17 })
    expect(r.ok).toBe(false)
    expect(!r.ok && Object.keys(r.errors).toSorted()).toEqual(['agree', 'birth_year', 'email', 'guardian', 'team_name', 'why'])
    expect(!r.ok && r.errors.birth_year).toMatch(/17 and under/)
  })

  it('lets the admin skip required questions but still checks what is given', () => {
    const r = validateEnrolment(
      fields,
      'player',
      { firstName: 'Jo', lastName: 'B', email: 'jo@example.com' },
      {},
      { ...opts, relaxRequired: true },
    )
    expect(r.ok).toBe(true)
    const bad = validateEnrolment(
      fields,
      'player',
      { firstName: 'Jo', lastName: 'B', email: 'jo@example.com' },
      { level: 'zzz' },
      { ...opts, relaxRequired: true },
    )
    expect(!bad.ok && bad.errors.level).toBeTruthy()
  })

  it('shows questions by entry type and showIf', () => {
    expect(visibleFields(fields, 'team', { level: 'b' }).map((f) => f.key)).toEqual([
      'level',
      'why',
      'team_name',
      'birth_year',
      'guardian',
      'agree',
    ])
    expect(visibleFields(fields, 'free_agent').map((f) => f.key)).toEqual(['level', 'birth_year', 'guardian', 'agree'])
  })
})

describe('entry types, references and labels', () => {
  it('derives entry types from the kind and switches', () => {
    expect(entryTypesFor('training', { allowTeamEntries: true, allowFreeAgents: true })).toEqual(['player'])
    expect(entryTypesFor('league', { allowTeamEntries: true, allowFreeAgents: false })).toEqual(['team'])
    expect(entryTypesFor('event', { allowTeamEntries: false, allowFreeAgents: true })).toEqual(['free_agent'])
  })

  it('makes readable references', () => {
    for (let i = 0; i < 200; i++) expect(newReference()).toMatch(REFERENCE_PATTERN)
    expect(newReference((b) => b.fill(0))).toBe('TVB-2222')
    expect(parseReference('tvb 7k3q')).toBe('TVB-7K3Q')
    expect(parseReference('7K3Q')).toBe('TVB-7K3Q')
    expect(parseReference('TVB-0000')).toBeNull()
  })

  it('formats dates and times without the Worker clock zone', () => {
    expect(formatDate('2026-10-21')).toBe('Wed 21 Oct 2026')
    expect(formatTime('18:30')).toBe('6:30pm')
    expect(formatTime('12:00')).toBe('12pm')
    expect(sessionLabel({ date: '2026-10-21', startTime: '18:30', endTime: '20:00', title: 'Serving' })).toBe(
      'Wed 21 Oct 2026, 6:30pm–8pm: Serving',
    )
  })
})

describe('CSV export', () => {
  it('escapes formulas and quotes, with a column per question (retired too)', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell(null)).toBe('""')
    const csv = enrolmentsCsv(
      [
        { key: 'level', type: 'select', label: 'Level', options: [{ value: 'a', label: 'Alpha' }] },
        { key: 'gone', type: 'text', label: 'Gone', retired: true },
        { key: 'guardian', type: 'guardian', label: 'Guardian' },
      ],
      [
        {
          reference: 'TVB-2222',
          status: 'confirmed',
          entryType: 'player',
          teamName: null,
          waitlistPosition: null,
          amountCents: 2000,
          paidAt: '2026-10-18T03:00:00.000Z',
          paymentNote: 'PayID',
          source: 'public',
          createdAt: '2026-10-17T03:00:00.000Z',
          cancelReason: null,
          vnswConfirmed: false,
          answers: { level: 'a', gone: '-1' },
          player: {
            firstName: 'Pat',
            lastName: 'Lee',
            email: 'pat@example.com',
            phone: null,
            birthYear: 2014,
            guardianName: 'Sam',
            guardianEmail: 'sam@example.com',
            guardianPhone: '0411',
            emergencyContact: null,
          },
        },
      ],
    )
    const [header, row] = csv.trim().split('\r\n')
    expect(header).toContain('"Guardian name"')
    expect(header).toContain('"Gone (retired)"')
    expect(row).toContain('"Alpha"')
    expect(row).toContain(`"'-1"`)
    expect(row).toContain('"20.00"')
  })
})
