import { describe, expect, it } from 'vitest'
import { intoId, locate, moveItem, parseIntoId, type Placement } from './menu-move'

type I = { key: string; placement: Placement; children: I[] }
const item = (key: string, children: I[] = [], placement: Placement = 'after'): I => ({ key, placement, children })
const shape = (items: I[]) =>
  items.map((i) => (i.children.length ? `${i.key}[${i.children.map((c) => `${c.key}:${c.placement}`).join(' ')}]` : i.key))

const tree = () => [item('home'), item('leagues', [item('tnl'), item('fnl', [], 'before')]), item('about', [item('faq')]), item('enrol')]

describe('moveItem', () => {
  it('moves a sub-item into another dropdown, before a sibling, taking a placement', () => {
    const r = moveItem(tree(), 'faq', { parent: 'leagues', before: 'fnl', placement: 'before' })
    expect(shape(r.items)).toEqual(['home', 'leagues[tnl:after faq:before fnl:before]', 'about', 'enrol'])
  })

  it('moves a sub-item out to the top level, and a top-level item into a dropdown', () => {
    expect(shape(moveItem(tree(), 'tnl', { parent: null, before: 'about' }).items)).toEqual([
      'home',
      'leagues[fnl:before]',
      'tnl',
      'about[faq:after]',
      'enrol',
    ])
    expect(shape(moveItem(tree(), 'enrol', { parent: 'about' }).items)).toEqual([
      'home',
      'leagues[tnl:after fnl:before]',
      'about[faq:after enrol:after]',
    ])
  })

  it('keeps two levels: no dropdown inside a dropdown, nothing under itself', () => {
    const r = moveItem(tree(), 'about', { parent: 'leagues' })
    expect(r.error).toMatch(/two levels/)
    expect(shape(r.items)).toEqual(shape(tree()))
    expect(shape(moveItem(tree(), 'home', { parent: 'home' }).items)).toEqual(shape(tree()))
    expect(shape(moveItem(tree(), 'missing', { parent: null }).items)).toEqual(shape(tree()))
  })

  it('finds items and parses drop-zone ids', () => {
    expect(locate(tree(), 'faq')?.parent).toBe('about')
    expect(locate(tree(), 'home')?.parent).toBeNull()
    expect(parseIntoId(intoId('k12', 'before'))).toEqual({ parent: 'k12', placement: 'before' })
    expect(parseIntoId(intoId('k3'))).toEqual({ parent: 'k3' })
    expect(parseIntoId('k3')).toBeNull()
  })
})
