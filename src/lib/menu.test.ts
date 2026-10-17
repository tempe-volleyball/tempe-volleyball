import { describe, expect, it } from 'vitest'
import { buildMenu, isActive, type MenuRow } from './menu'

const row = (r: Partial<MenuRow> & Pick<MenuRow, 'id' | 'label' | 'kind'>): MenuRow => ({
  parentId: null,
  url: null,
  sort: 0,
  pagePath: null,
  leagueSlug: null,
  ...r,
})

const rows: MenuRow[] = [
  row({ id: 'home', label: 'Home', kind: 'page', pagePath: '/', sort: 0 }),
  row({ id: 'leagues', label: 'Mixed Leagues', kind: 'url', sort: 2 }),
  row({ id: 'tnl-l', parentId: 'leagues', label: 'TNL Ladder', kind: 'league_ladder', leagueSlug: 'tnl', sort: 0 }),
  row({ id: 'tnl-f', parentId: 'leagues', label: 'TNL Fixtures', kind: 'league_fixtures', leagueSlug: 'tnl', sort: 1 }),
  row({ id: 'about', label: 'About', kind: 'url', sort: 3 }),
  row({ id: 'gone', parentId: 'about', label: 'Unpublished', kind: 'page', pagePath: null }),
  row({ id: 'tvsl', label: 'Super League', kind: 'page', pagePath: '/saturday-night-endorsed-league', sort: 1 }),
  row({ id: 'insta', label: 'Instagram', kind: 'url', url: 'https://www.instagram.com/tempe.volleyball/', sort: 4 }),
]

describe('buildMenu', () => {
  const menu = buildMenu(rows)

  it('orders top-level items and nests children with league routes', () => {
    expect(menu.map((m) => m.label)).toEqual(['Home', 'Super League', 'Mixed Leagues', 'Instagram'])
    const leagues = menu.find((m) => m.id === 'leagues')!
    expect(leagues.href).toBeNull()
    expect(leagues.children.map((c) => c.href)).toEqual(['/leagues/tnl#ladder', '/leagues/tnl#fixtures'])
  })

  it('drops items whose page is unpublished, and headings left with nothing under them', () => {
    expect(menu.find((m) => m.id === 'about')).toBeUndefined()
  })

  it('marks external links', () => {
    expect(menu.find((m) => m.id === 'insta')!.external).toBe(true)
    expect(menu.find((m) => m.id === 'home')!.external).toBe(false)
  })
})

describe('isActive', () => {
  const menu = buildMenu(rows)
  const get = (id: string) => menu.find((m) => m.id === id)!

  it('matches home only on /', () => {
    expect(isActive(get('home'), '/')).toBe(true)
    expect(isActive(get('home'), '/contact')).toBe(false)
  })

  it('matches a heading through its children, including season pages under the league', () => {
    expect(isActive(get('leagues'), '/leagues/tnl')).toBe(true)
    expect(isActive(get('leagues'), '/leagues/tnl/tnl-q3-2026/')).toBe(true)
    expect(isActive(get('leagues'), '/leagues/fnl')).toBe(false)
  })

  it('ignores external links', () => {
    expect(isActive(get('insta'), '/')).toBe(false)
  })
})
