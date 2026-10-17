import { describe, expect, it } from 'vitest'
import {
  autoProgrammes,
  buildMenuTree,
  checkMenu,
  isActive,
  menuToInput,
  publicMenu,
  type MenuData,
  type MenuProgramme,
  type MenuRow,
} from './menu'

const PAGE = '11111111-1111-4111-8111-111111111111'
const LEAGUE = '22222222-2222-4222-8222-222222222222'
const TRAINING = '44444444-4444-4444-8444-444444444444'
const known = {
  pageIds: new Set([PAGE]),
  leagueIds: new Set([LEAGUE]),
  programmeIds: new Set([LEAGUE, TRAINING]),
  categoryIds: new Set(['cat_mixed_leagues']),
}
let n = 0
const newId = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

const row = (r: Partial<MenuRow> & Pick<MenuRow, 'id' | 'label' | 'kind'>): MenuRow => ({
  parentId: null,
  pageId: null,
  leagueId: null,
  categoryId: null,
  url: null,
  sort: 0,
  placement: null,
  hidden: false,
  ...r,
})

const prog = (p: Partial<MenuProgramme> & Pick<MenuProgramme, 'id' | 'code'>): MenuProgramme => ({
  kind: 'league',
  name: `${p.code} league`,
  slug: p.code.toLowerCase(),
  status: 'active',
  menuVisible: true,
  categoryId: 'mixed',
  sort: 0,
  ...p,
})

const data: MenuData = {
  pagePath: (id) => ({ home: '/', about: '/about', jdp: '/junior-development-program-jdp' })[id] ?? null,
  programmes: [
    prog({ id: 'fnl', code: 'FNL', sort: 2 }),
    prog({ id: 'tnl', code: 'TNL', sort: 1 }),
    prog({ id: 'sal', code: 'SAL', sort: 4, menuVisible: false }),
    prog({ id: 'snl', code: 'SNL', sort: 3, status: 'retired' }),
    prog({ id: 'new', code: 'MNL', sort: 5, status: 'draft' }),
    prog({ id: 'tvsl', code: 'TVSL', categoryId: 'super' }),
    prog({ id: 'scrim', code: 'SCT', kind: 'training', name: 'Scrim & Coached Training', slug: 'scrim', categoryId: 'adult' }),
  ],
  categories: [
    { id: 'mixed', name: 'Mixed Leagues', slug: 'mixed-leagues', status: 'active' },
    { id: 'super', name: 'Super League', slug: 'super-league', status: 'active' },
    { id: 'adult', name: 'Adult Training', slug: 'adult-training', status: 'active' },
    { id: 'off', name: 'Old', slug: 'old', status: 'retired' },
  ],
}

describe('checkMenu', () => {
  it('flattens a two-level tree into rows with parents and sort order', () => {
    const res = checkMenu(
      [
        { label: 'Home', kind: 'page', pageId: PAGE },
        {
          label: ' Mixed   Leagues ',
          kind: 'url',
          children: [
            { label: 'TNL Ladder', kind: 'league_ladder', leagueId: LEAGUE },
            { label: 'Instagram', kind: 'url', url: 'https://www.instagram.com/tempe.volleyball/' },
          ],
        },
      ],
      known,
      newId,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.rows.map((r) => [r.label, r.parentId === null, r.sort, r.kind])).toEqual([
      ['Home', true, 0, 'page'],
      ['Mixed Leagues', true, 1, 'url'],
      ['TNL Ladder', false, 0, 'league_ladder'],
      ['Instagram', false, 1, 'url'],
    ])
    expect(res.rows[2]!.parentId).toBe(res.rows[1]!.id)
    expect(res.rows[1]!.url).toBeNull()
  })

  it('accepts category and programme items, with placement only under a category and hidden flags', () => {
    const res = checkMenu(
      [
        {
          label: 'Mixed Leagues',
          kind: 'category',
          categoryId: 'cat_mixed_leagues',
          children: [
            { label: 'Rules', kind: 'page', pageId: PAGE, placement: 'before' },
            { label: 'Scrims', kind: 'programme', leagueId: TRAINING, hidden: true },
          ],
        },
        { label: 'About', kind: 'url', children: [{ label: 'Rules', kind: 'page', pageId: PAGE, placement: 'before' }] },
      ],
      known,
      newId,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.rows.map((r) => [r.kind, r.categoryId, r.leagueId, r.placement, r.hidden])).toEqual([
      ['category', 'cat_mixed_leagues', null, null, false],
      ['page', null, null, 'before', false],
      ['programme', null, TRAINING, null, true],
      ['url', null, null, null, false],
      ['page', null, null, null, false],
    ])
  })

  it('keeps valid ids and replaces bad or duplicate ones', () => {
    const id = '33333333-3333-4333-8333-333333333333'
    const res = checkMenu(
      [
        { id, label: 'A', kind: 'url', url: '/a' },
        { id, label: 'B', kind: 'url', url: '/b' },
        { id: 'nope', label: 'C', kind: 'url', url: '/c' },
      ],
      known,
      newId,
    )
    expect(res.ok && res.rows.map((r) => r.id === id)).toEqual([true, false, false])
  })

  it('rejects bad items', () => {
    const bad = [
      [{ label: '', kind: 'url' }],
      [{ label: 'x', kind: 'weird' }],
      [{ label: 'x', kind: 'page', pageId: 'missing' }],
      [{ label: 'x', kind: 'league_fixtures' }],
      // A training programme isn't a league, so it can't be a ladder link.
      [{ label: 'x', kind: 'league_ladder', leagueId: TRAINING }],
      [{ label: 'x', kind: 'category', categoryId: 'nope' }],
      [{ label: 'x', kind: 'programme', leagueId: 'nope' }],
      [{ label: 'x', kind: 'category', categoryId: 'cat_mixed_leagues', children: [{ label: 'y', kind: 'url', placement: 'middle' }] }],
      [{ label: 'x', kind: 'url', url: 'javascript:alert(1)' }],
      [{ label: 'x', kind: 'url', children: [{ label: 'y', kind: 'url', children: [{ label: 'z', kind: 'url' }] }] }],
      'not a list',
      Array.from({ length: 21 }, () => ({ label: 'x', kind: 'url' })),
    ]
    for (const b of bad) expect.soft(checkMenu(b, known, newId)).toMatchObject({ ok: false })
  })
})

describe('buildMenuTree', () => {
  it('builds the admin tree with links, keeping unpublished pages and hidden items', () => {
    const rows = [
      row({ id: 'b', label: 'About', kind: 'url', sort: 1 }),
      row({ id: 'a', label: 'Home', kind: 'page', pageId: 'home' }),
      row({ id: 'c', parentId: 'b', label: 'Draft page', kind: 'page', pageId: 'p2' }),
      row({ id: 'd', parentId: 'b', label: 'Ladder', kind: 'league_ladder', leagueId: 'tnl', sort: 1 }),
      row({ id: 'e', label: 'Empty heading', kind: 'url', sort: 2, hidden: true }),
    ]
    const admin = buildMenuTree(rows, data)
    expect(admin.map((x) => x.label)).toEqual(['Home', 'About', 'Empty heading'])
    expect(admin[1]!.children.map((c) => [c.label, c.href])).toEqual([
      ['Draft page', null],
      ['Ladder', '/leagues/tnl#ladder'],
    ])
    const pub = buildMenuTree(rows, data, { publicOnly: true })
    expect(pub.map((x) => x.label)).toEqual(['Home', 'About'])
    expect(pub[1]!.children.map((c) => c.label)).toEqual(['Ladder'])
    expect(menuToInput(admin)[1]!.children!.length).toBe(2)
  })

  it('expands a category into its landing page plus active, menu-visible programmes, with pinned links around them', () => {
    const rows = [
      row({ id: 'm', label: 'Mixed Leagues', kind: 'category', categoryId: 'mixed' }),
      row({ id: 'p1', parentId: 'm', label: 'How leagues work', kind: 'page', pageId: 'about', placement: 'before', sort: 5 }),
      row({ id: 'p2', parentId: 'm', label: 'Enrol', kind: 'url', url: '/enrol', sort: 0 }),
      row({ id: 'p3', parentId: 'm', label: 'Hidden link', kind: 'url', url: '/x', hidden: true }),
    ]
    const [mixed] = buildMenuTree(rows, data, { publicOnly: true, expand: true })
    expect(mixed!.href).toBe('/mixed-leagues')
    expect(mixed!.children.map((c) => [c.label, c.href, !!c.auto])).toEqual([
      ['How leagues work', '/about', false],
      ['TNL league', '/leagues/tnl', true],
      ['FNL league', '/leagues/fnl', true],
      ['Enrol', '/enrol', false],
    ])
    // The admin tree doesn't expand, and automatic links never go back into a save.
    expect(buildMenuTree(rows, data)[0]!.children.every((c) => !c.auto)).toBe(true)
    expect(menuToInput(buildMenuTree(rows, data, { expand: true }))[0]!.children!.map((c) => c.label)).toEqual([
      'How leagues work',
      'Enrol',
      'Hidden link',
    ])
  })

  it('lets a hand-made programme child replace the automatic link (rename and pin)', () => {
    const rows = [
      row({ id: 'm', label: 'Mixed', kind: 'category', categoryId: 'mixed' }),
      row({ id: 'x', parentId: 'm', label: 'Thursday nights', kind: 'programme', leagueId: 'tnl', placement: 'after' }),
    ]
    const [mixed] = buildMenuTree(rows, data, { publicOnly: true, expand: true })
    expect(mixed!.children.map((c) => c.label)).toEqual(['FNL league', 'Thursday nights'])
  })

  it('drops retired programmes and categories from the public menu, and programme items link any kind', () => {
    const rows = [
      row({ id: 'old', label: 'Old', kind: 'category', categoryId: 'off' }),
      row({ id: 'snl', label: 'SNL', kind: 'programme', leagueId: 'snl', sort: 1 }),
      row({ id: 'scrim', label: 'Training', kind: 'programme', leagueId: 'scrim', sort: 2 }),
      row({ id: 'fix', label: 'SNL fixtures', kind: 'league_fixtures', leagueId: 'snl', sort: 3 }),
    ]
    expect(buildMenuTree(rows, data, { publicOnly: true, expand: true }).map((r) => [r.label, r.href])).toEqual([
      ['Training', '/training/scrim'],
    ])
    // The admin still sees them, with their links.
    expect(buildMenuTree(rows, data).map((r) => r.href)).toEqual(['/old', '/leagues/snl', '/training/scrim', '/leagues/snl#fixtures'])
  })

  it('autoProgrammes follows programme order and skips hidden, retired and draft programmes', () => {
    expect(autoProgrammes('mixed', data.programmes).map((p) => p.code)).toEqual(['TNL', 'FNL'])
  })
})

describe('publicMenu and isActive', () => {
  const rows: MenuRow[] = [
    row({ id: 'home', label: 'Home', kind: 'page', pageId: 'home', sort: 0 }),
    row({ id: 'leagues', label: 'Mixed Leagues', kind: 'category', categoryId: 'mixed', sort: 2 }),
    row({ id: 'about', label: 'About', kind: 'url', sort: 3 }),
    row({ id: 'gone', parentId: 'about', label: 'Unpublished', kind: 'page', pageId: 'draft' }),
    row({ id: 'tvsl', label: 'Super League', kind: 'programme', leagueId: 'tvsl', sort: 1 }),
    row({ id: 'insta', label: 'Instagram', kind: 'url', url: 'https://www.instagram.com/tempe.volleyball/', sort: 4 }),
  ]
  const menu = publicMenu(rows, data)
  const get = (id: string) => menu.find((m) => m.id === id)!

  it('orders items, drops headings left with nothing, and marks external links', () => {
    expect(menu.map((m) => m.label)).toEqual(['Home', 'Super League', 'Mixed Leagues', 'Instagram'])
    expect(get('insta').external).toBe(true)
    expect(get('home').external).toBe(false)
  })

  it('matches home only on /', () => {
    expect(isActive(get('home'), '/')).toBe(true)
    expect(isActive(get('home'), '/contact')).toBe(false)
  })

  it('matches a category through its programmes, including season pages under a league', () => {
    expect(isActive(get('leagues'), '/mixed-leagues')).toBe(true)
    expect(isActive(get('leagues'), '/leagues/tnl')).toBe(true)
    expect(isActive(get('leagues'), '/leagues/tnl/tnl-q3-2026/')).toBe(true)
    expect(isActive(get('leagues'), '/leagues/tvsl')).toBe(false)
  })

  it('ignores external links', () => {
    expect(isActive(get('insta'), '/')).toBe(false)
  })
})
