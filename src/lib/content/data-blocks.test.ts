import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FIXTURES_ATTRS,
  DEFAULT_LADDER_ATTRS,
  DEFAULT_PROGRAMME_LIST_ATTRS,
  DEFAULT_VENUES_ATTRS,
  type ProgrammeListAttrs,
} from './blocks'
import {
  dataBlockRefs,
  fillTemplate,
  normaliseDataBlocks,
  parseFixturesAttrs,
  parseLadderAttrs,
  parseProgrammeListAttrs,
  parseVenuesAttrs,
  programmeLines,
  renderFixtures,
  renderLadder,
  renderProgrammeList,
  renderVenues,
  selectFixtureRows,
  type BlockProgramme,
  type FixtureRowLike,
  type LeagueBlockData,
  type ProgrammeListData,
} from './data-blocks'
import { checkBlocks, hasDataBlocks, renderBlocks } from './render'

const prog = (p: Partial<BlockProgramme> & Pick<BlockProgramme, 'id' | 'code'>): BlockProgramme => ({
  kind: 'league',
  name: `${p.code} League`,
  slug: p.code.toLowerCase(),
  status: 'active',
  categoryId: 'mixed',
  sort: 0,
  weekday: 4,
  startTime: '20:00',
  endTime: '22:00',
  scheduleLabel: null,
  summaryLine: null,
  nextStartsOn: null,
  nextStartsText: null,
  defaultVenueId: 'rw',
  priceCents: null,
  enrolmentOpen: false,
  enrolmentOpensAt: null,
  enrolmentClosesAt: null,
  ...p,
})

const NOW = '2026-10-18T00:00:00.000Z'

const data = (programmes: BlockProgramme[]): ProgrammeListData => ({
  programmes,
  categories: [
    { id: 'mixed', name: 'Mixed Leagues', sort: 1 },
    { id: 'adult', name: 'Adult Training', sort: 4 },
  ],
  venues: [{ id: 'rw', name: 'Robyn Webster Sports Centre', address: 'Holbeach Ave, Tempe NSW 2044' }],
  nextInstance: new Map([['tnl', '2027-01-14']]),
  nowIso: NOW,
})

const attrs = (a: Partial<ProgrammeListAttrs> = {}): ProgrammeListAttrs => ({ ...DEFAULT_PROGRAMME_LIST_ATTRS, ...a })

describe('fillTemplate', () => {
  it('fills placeholders and tidies what empty values leave behind', () => {
    expect(fillTemplate('Next {name} ({code}) @ {venue} ({times})', { name: 'TNL', code: '', venue: '', times: 'Thursdays' })).toBe(
      'Next TNL (Thursdays)',
    )
    expect(fillTemplate('{name}, {nextStart}', { name: 'ADP', nextStarts: '' })).toBe('ADP')
    expect(fillTemplate('{name} {oops}', { name: 'ADP' })).toBe('ADP {oops}')
  })
})

describe('programmeLines', () => {
  const programmes = [
    prog({ id: 'fnl', code: 'FNL', weekday: 5, sort: 2 }),
    prog({ id: 'tnl', code: 'TNL', sort: 1 }),
    prog({ id: 'old', code: 'MNL', status: 'retired' }),
    prog({ id: 'draft', code: 'XNL', status: 'draft' }),
    prog({ id: 'scrim', code: 'SCT', kind: 'training', name: 'Scrim Training', slug: 'scrim', categoryId: 'adult', enrolmentOpen: true }),
  ]

  it('lists active programmes in category then programme order, with the generated summary line', () => {
    const lines = programmeLines(attrs(), data(programmes))
    expect(lines.map((l) => l.id)).toEqual(['tnl', 'fnl', 'scrim'])
    // The same text as category pages, /enrol and the admin (generatedSummaryLine), not a block-only wording.
    expect(lines[0]).toMatchObject({
      source: 'generated',
      text: 'TNL League @ Robyn Webster Sports Centre, Tempe, Thursdays 8–10pm',
      href: '/leagues/tnl',
    })
    // A template, when the block has one, replaces the generated line.
    expect(programmeLines(attrs({ template: 'Next {name} ({code}) @ {venue} ({times})' }), data(programmes))[0]).toMatchObject({
      source: 'template',
      text: 'Next TNL League (TNL) @ Robyn Webster Sports Centre, Tempe (Thursdays 8–10pm)',
    })
    expect(lines[2]!.href).toBe('/training/scrim')
  })

  it('filters by category, kind and enrolment state', () => {
    const d = data(programmes)
    expect(programmeLines(attrs({ filter: { categoryIds: ['adult'] } }), d).map((l) => l.id)).toEqual(['scrim'])
    expect(programmeLines(attrs({ filter: { kinds: ['league'] } }), d).map((l) => l.id)).toEqual(['tnl', 'fnl'])
    expect(programmeLines(attrs({ filter: { enrolmentOpenOnly: true } }), d).map((l) => l.id)).toEqual(['scrim'])
    expect(programmeLines(attrs({ filter: { enrolment: 'closed' } }), d).map((l) => l.id)).toEqual(['tnl', 'fnl'])
  })

  it('applies the dragged order first, appends new programmes, and hides per page', () => {
    const d = data(programmes)
    expect(programmeLines(attrs({ order: ['scrim', 'gone'], hidden: ['fnl'] }), d).map((l) => l.id)).toEqual(['scrim', 'tnl'])
    const all = programmeLines(attrs({ hidden: ['fnl'] }), d, { includeHidden: true })
    expect(all.map((l) => [l.id, l.hidden])).toEqual([
      ['tnl', false],
      ['fnl', true],
      ['scrim', false],
    ])
  })

  it('picks the text: page override, then the programme summary line, then the template, then the generated line', () => {
    const withSummary = programmes.map((p) => (p.id === 'fnl' ? { ...p, summaryLine: 'Friday nights at Tempe' } : p))
    const tnl = programmeLines(attrs(), data(withSummary))[0]!
    const source = tnl.current
    const lines = programmeLines(
      attrs({ overrides: { tnl: { text: 'Thursday: {nextStarts}', source, editedAt: NOW } }, template: '{name} only' }),
      data(withSummary),
    )
    expect(lines.map((l) => [l.id, l.source, l.text])).toEqual([
      ['tnl', 'override', 'Thursday: Next season starts Thursday 14 January 2027'],
      ['fnl', 'summary', 'Friday nights at Tempe'],
      ['scrim', 'template', 'Scrim Training only'],
    ])
    expect(lines[0]!.automatic).toBe('TNL League only')
    // A block can ignore summary lines and always use its own template.
    expect(programmeLines(attrs({ template: '{code}', useSummaryLines: false }), data(withSummary)).map((l) => l.text)).toEqual([
      'TNL',
      'FNL',
      'SCT',
    ])
    // …or, without a template, the generated line even where a summary line exists.
    expect(programmeLines(attrs({ useSummaryLines: false }), data(withSummary)).map((l) => [l.source, l.text])[1]).toEqual([
      'generated',
      'FNL League @ Robyn Webster Sports Centre, Tempe, Fridays 8–10pm',
    ])
  })

  it('flags an override whose programme changed since it was written', () => {
    const before = programmeLines(attrs(), data(programmes))[0]!.current
    const override = { tnl: { text: 'Hand-written', source: before, editedAt: NOW } }
    expect(programmeLines(attrs({ overrides: override }), data(programmes))[0]!.changed).toEqual([])
    const moved = programmes.map((p) => (p.id === 'tnl' ? { ...p, weekday: 3, defaultVenueId: null } : p))
    const line = programmeLines(attrs({ overrides: override }), data(moved))[0]!
    expect(line.text).toBe('Hand-written')
    expect(line.changed).toEqual(['venue', 'times'])
  })

  it('drops retired programmes even when they have an override', () => {
    const lines = programmeLines(
      attrs({ overrides: { old: { text: 'Mondays', source: programmeLines(attrs(), data(programmes))[0]!.current, editedAt: NOW } } }),
      data(programmes),
    )
    expect(lines.some((l) => l.id === 'old')).toBe(false)
  })

  it('renders escaped HTML with whole-line links, a {link}, or plain lines', () => {
    const evil = [prog({ id: 'x', code: 'X', name: '<script>alert(1)</script>' })]
    const html = renderProgrammeList(attrs({ title: 'Our <leagues>' }), data(evil))
    expect(html).not.toContain('<script>')
    expect(html).toContain('<h2>Our &lt;leagues&gt;</h2>')
    expect(html).toContain('<li><a href="/leagues/x">&lt;script&gt;alert(1)&lt;/script&gt; (X) @')
    const withLink = renderProgrammeList(attrs({ template: '{name} {link}' }), data([programmes[1]!]))
    expect(withLink).toBe(
      '<div class="data-block programme-list"><ul><li>TNL League <a href="/leagues/tnl">More info<span class="sr-only"> about TNL League</span></a></li></ul></div>',
    )
    expect(renderProgrammeList(attrs({ linkLines: false, template: '{code}' }), data([programmes[1]!]))).toContain('<li>TNL</li>')
    expect(renderProgrammeList(attrs({ filter: { categoryIds: ['none'] } }), data(programmes))).toBe('')
    expect(renderProgrammeList(attrs({ filter: { categoryIds: ['none'] }, emptyText: 'Soon' }), data(programmes))).toContain('<p>Soon</p>')
  })
})

describe('attrs', () => {
  it('normalises junk to defaults and bounds sizes', () => {
    const a = parseProgrammeListAttrs({
      filter: { kinds: ['league', 'nope'], categoryIds: ['ok', 7, 'bad id!'], enrolmentOpenOnly: true },
      template: 'x'.repeat(1000),
      order: 'nope',
      overrides: { tnl: { text: '  hi  ', source: { name: 5 } }, 'bad id': { text: 'x' }, empty: { text: ' ' } },
      linkLines: 'yes',
    })
    expect(a.filter).toEqual({ kinds: ['league'], categoryIds: ['ok'], enrolmentOpenOnly: true, enrolment: 'open' })
    expect(a.template).toHaveLength(300)
    expect(a.order).toEqual([])
    expect(Object.keys(a.overrides)).toEqual(['tnl'])
    expect(a.overrides.tnl!.text).toBe('hi')
    expect(a.overrides.tnl!.source.name).toBe('')
    expect(a.linkLines).toBe(true)
    expect(parseLadderAttrs({ leagueId: 'l1', rows: 0, display: 'huge' })).toEqual({ ...DEFAULT_LADDER_ATTRS, leagueId: 'l1' })
    expect(parseFixturesAttrs({ leagueId: 'l1', range: 'upcoming', matchDays: null })).toEqual({
      ...DEFAULT_FIXTURES_ATTRS,
      leagueId: 'l1',
      range: 'upcoming',
      matchDays: null,
    })
  })

  it('normalises blocks for storage and lists their page_data_refs', () => {
    const body = normaliseDataBlocks([
      { type: 'paragraph', content: [{ type: 'text', text: 'hi' }] },
      { type: 'programmeList', attrs: { junk: true } },
      { type: 'ladder', attrs: { leagueId: 'l1' } },
      { type: 'fixtures', attrs: { leagueId: 'l1' } },
      { type: 'ladder', attrs: { leagueId: 'l1' } },
      { type: 'ladder', attrs: {} },
    ])
    expect(body[1]!.attrs).toEqual({
      ...DEFAULT_PROGRAMME_LIST_ATTRS,
      filter: { categoryIds: [], kinds: [], enrolmentOpenOnly: false, enrolment: 'any' },
    })
    expect(dataBlockRefs(body)).toEqual([
      { kind: 'programme_list', refId: '' },
      { kind: 'ladder', refId: 'l1' },
      { kind: 'fixtures', refId: 'l1' },
    ])
    expect(hasDataBlocks(body)).toBe(true)
    expect(hasDataBlocks([{ type: 'paragraph' }])).toBe(false)
  })

  it('leaves data blocks out of the stored HTML and leaves existing pages unchanged', () => {
    const blocks = [
      { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
      { type: 'ladder', attrs: { leagueId: 'l1' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
    ]
    expect(checkBlocks(blocks).ok).toBe(true)
    expect(renderBlocks(blocks)).toBe('<p>Before</p><p>After</p>')
    expect(renderBlocks(blocks, { dataBlock: (n) => `[${n.type}]` })).toBe('<p>Before</p>[ladder]<p>After</p>')
  })
})

const fixture = (r: Partial<FixtureRowLike> & Pick<FixtureRowLike, 'key' | 'date'>): FixtureRowLike => ({
  matchDay: 1,
  time: '19:00',
  match: 'A vs B',
  result: '',
  sets: '',
  court: 'Court 1',
  duty: 'C',
  kind: 'game',
  forfeit: false,
  ...r,
})

const league: LeagueBlockData = {
  league: { id: 'l1', name: 'Thursday Night League', code: 'TNL', slug: 'tnl' },
  seasonName: 'TNL Q4 2026',
  heading: 'Ladder – Week 2 of 9',
  updated: 'Updated 16/10/2026',
  ladder: [1, 2, 3, 4, 5].map((pos) => ({
    pos,
    name: `Team ${pos}`,
    points: 10 - pos,
    played: 2,
    won: 1,
    drawn: 0,
    lost: 1,
    setsFor: 3,
    setsAgainst: 2,
    pointsFor: 100,
    pointsAgainst: 90,
    ratio: '0.526',
  })),
  fixtures: [
    fixture({ key: 'g1', date: '2026-10-08', result: '2 - 0', matchDay: 1 }),
    fixture({ key: 'g2', date: '2026-10-08', result: '1 - 1', matchDay: 1, match: 'C vs D' }),
    fixture({ key: 'g3', date: '2026-10-15', result: '2 - 0', matchDay: 2 }),
    fixture({ key: 'skip', date: '2026-10-22', kind: 'skip', match: 'School holidays' }),
    fixture({ key: 'g4', date: '2026-10-29', matchDay: 3, match: 'C vs A' }),
    fixture({ key: 'w:bye:b', date: '2026-10-29', matchDay: 3, kind: 'bye', match: 'BYE - B', time: 'Bye' }),
    fixture({ key: 'g5', date: '2026-11-05', matchDay: 4 }),
  ],
  rowTeams: new Map([
    ['g1', ['a', 'b', 'c']],
    ['g2', ['c', 'd', 'a']],
    ['g3', ['a', 'b', 'c']],
    ['g4', ['c', 'a', 'd']],
    ['w:bye:b', ['b']],
    ['g5', ['a', 'b', 'c']],
  ]),
  dutyEnabled: true,
}

describe('ladder and fixtures blocks', () => {
  it('renders the ladder compact or full, with rows, title, heading and link options', () => {
    const compact = renderLadder({ ...DEFAULT_LADDER_ATTRS, leagueId: 'l1', rows: 3 }, league)
    expect(compact).toContain('<h2>Thursday Night League Ladder</h2>')
    expect(compact).toContain('Ladder – Week 2 of 9 · Updated 16/10/2026')
    expect(compact.match(/<tr>/g)).toHaveLength(4)
    expect(compact).not.toContain('Ratio')
    expect(compact).toContain('href="/leagues/tnl#ladder"')
    const full = renderLadder(
      { ...DEFAULT_LADDER_ATTRS, leagueId: 'l1', display: 'full', title: 'TNL', showHeading: false, showLink: false },
      league,
    )
    expect(full).toContain('Ratio')
    expect(full).not.toContain('Week 2')
    expect(full).not.toContain('#ladder')
    expect(renderLadder({ ...DEFAULT_LADDER_ATTRS, leagueId: 'nope' }, undefined)).toBe('')
  })

  it('selects this week, upcoming, results and all, with a match-day limit and a team filter', () => {
    const pick = (a: Partial<typeof DEFAULT_FIXTURES_ATTRS>) =>
      selectFixtureRows({ ...DEFAULT_FIXTURES_ATTRS, leagueId: 'l1', ...a }, league, '2026-10-15').map((r) => r.key)
    expect(pick({ range: 'this_week' })).toEqual(['g3'])
    expect(pick({ range: 'upcoming', matchDays: 2 })).toEqual(['g3', 'skip'])
    expect(pick({ range: 'upcoming', matchDays: null })).toEqual(['g3', 'skip', 'g4', 'w:bye:b', 'g5'])
    expect(pick({ range: 'results', matchDays: 2 })).toEqual(['g3', 'g1', 'g2'])
    expect(pick({ range: 'all', matchDays: null }).length).toBe(7)
    expect(pick({ range: 'upcoming', matchDays: null, teamId: 'b' })).toEqual(['g3', 'skip', 'w:bye:b', 'g5'])
  })

  it('renders fixtures with optional columns and an empty message', () => {
    const html = renderFixtures({ ...DEFAULT_FIXTURES_ATTRS, leagueId: 'l1', display: 'full' }, league, '2026-10-15')
    expect(html).toContain('<th scope="col">Duty</th>')
    expect(html).toContain('<th scope="col">Court</th>')
    expect(html).toContain('15/10/2026')
    const noCourt = renderFixtures({ ...DEFAULT_FIXTURES_ATTRS, leagueId: 'l1', showCourt: false }, league, '2026-10-15')
    expect(noCourt).not.toContain('Court')
    expect(noCourt).not.toContain('Duty')
    expect(renderFixtures({ ...DEFAULT_FIXTURES_ATTRS, leagueId: 'l1' }, league, '2027-01-01')).toContain('No games coming up.')
  })
})

describe('Venues block', () => {
  const venues = [
    {
      id: 'rw',
      name: 'Robyn Webster Sports Centre',
      slug: 'tempe',
      address: 'Holbeach Ave, Tempe NSW 2044',
      mapUrl: null,
      directions: 'By train: Wolli Creek.\nWalk 10 minutes.\n\nBy car: free parking.',
    },
    {
      id: 'mlc',
      name: 'MLC School',
      slug: 'mlc',
      address: 'Rowley St, Burwood NSW 2134',
      mapUrl: 'https://maps.example/mlc',
      directions: null,
    },
    { id: 'fd', name: 'Five <Dock>', slug: 'five-dock', address: null, mapUrl: 'javascript:alert(1)', directions: null },
  ]
  const programmes = [
    prog({ id: 'tnl', code: 'TNL', sort: 1 }),
    prog({ id: 'fnl', code: 'FNL', sort: 2 }),
    prog({ id: 'old', code: 'MNL', status: 'retired' }),
    prog({ id: 'scrim', code: 'SCT', kind: 'training', name: 'Scrim Training', slug: 'scrim', defaultVenueId: 'mlc' }),
  ]

  it('parses attrs with defaults and normalises them through a page body', () => {
    expect(parseVenuesAttrs({})).toEqual(DEFAULT_VENUES_ATTRS)
    expect(parseVenuesAttrs({ venueIds: ['rw', 'bad id', 'rw'], showMap: false, junk: 1 })).toEqual({
      ...DEFAULT_VENUES_ATTRS,
      venueIds: ['rw'],
      showMap: false,
    })
    const blocks = [{ type: 'venues', attrs: { title: '  Where   we play ' } }]
    expect(hasDataBlocks(blocks)).toBe(true)
    expect(normaliseDataBlocks(blocks)[0]!.attrs).toMatchObject({ title: 'Where we play', venueIds: [] })
    expect(dataBlockRefs(blocks)).toEqual([])
  })

  it('renders every venue with its address, map link, directions and who plays there, escaped', () => {
    const html = renderVenues(DEFAULT_VENUES_ATTRS, { venues, programmes })
    expect(html).toContain('<div class="venue" id="venue-tempe"><h2>Robyn Webster Sports Centre</h2>')
    expect(html).toContain('<p class="venue-address">Holbeach Ave, Tempe NSW 2044</p>')
    // No map link typed: a Google Maps search for the name and address.
    expect(html).toContain(
      `href="https://www.google.com/maps/search/?api=1&amp;query=${encodeURIComponent('Robyn Webster Sports Centre, Holbeach Ave, Tempe NSW 2044')}"`,
    )
    expect(html).toContain('<p>By train: Wolli Creek.<br>Walk 10 minutes.</p><p>By car: free parking.</p>')
    expect(html).toContain(
      '<strong>Who plays here:</strong> <a href="/leagues/tnl">TNL League</a>, <a href="/leagues/fnl">FNL League</a></p>',
    )
    expect(html).not.toContain('MNL')
    expect(html).toContain('href="https://maps.example/mlc"')
    expect(html).toContain('<a href="/training/scrim">Scrim Training</a>')
    // An unsafe map link and no address: no link at all.
    expect(html).toContain('<h2>Five &lt;Dock&gt;</h2>')
    expect(html).not.toContain('javascript:')
  })

  it('shows the chosen venues in the chosen order, with options off and a heading', () => {
    const html = renderVenues(
      { ...DEFAULT_VENUES_ATTRS, venueIds: ['mlc', 'gone', 'rw'], title: 'Our venues', showDirections: false, showProgrammes: false },
      { venues, programmes },
    )
    expect(html.indexOf('MLC School')).toBeLessThan(html.indexOf('Robyn Webster'))
    expect(html).toContain('<h2>Our venues</h2>')
    expect(html).toContain('<h3>MLC School</h3>')
    expect(html).not.toContain('Five')
    expect(html).not.toContain('Who plays here')
    expect(html).not.toContain('Wolli Creek')
    expect(renderVenues(DEFAULT_VENUES_ATTRS, { venues: [], programmes })).toBe('')
  })
})
