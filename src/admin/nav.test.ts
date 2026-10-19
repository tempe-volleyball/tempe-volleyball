import { describe, expect, it } from 'vitest'
import { bottomBar, isCurrent, navFor, navItemFor } from './nav'

describe('admin navigation', () => {
  it('hides enrolment from editors and people screens from those who cannot manage users', () => {
    const editor = navFor({ role: 'editor', canManageUsers: false }).flatMap((g) => g.items.map((i) => i.label))
    expect(editor).not.toContain('Enrolments')
    expect(editor).not.toContain('Forms')
    expect(editor).not.toContain('Admin users')
    expect(editor).not.toContain('Interest')
    expect(editor).not.toContain('Players')
    expect(editor).toContain('Security')
    const owner = navFor({ role: 'owner', canManageUsers: true }).flatMap((g) => g.items.map((i) => i.label))
    expect(owner).toEqual(expect.arrayContaining(['Enrolments', 'Forms', 'Admin users', 'Audit log', 'Interest', 'Players']))
    const admin = navFor({ role: 'admin', canManageUsers: false })
    expect(admin.find((g) => g.label === 'Players')?.items.map((i) => i.label)).toEqual(['Interest', 'Players'])
  })

  it('finds the section for nested locations', () => {
    expect(navItemFor('/')?.item.label).toBe('Home')
    expect(navItemFor('/seasons/abc/results')?.item.label).toBe('Leagues')
    expect(navItemFor('/seasons/abc/results')?.group?.label).toBe('Competition')
    expect(navItemFor('/training/x/details')?.item.label).toBe('Training')
    expect(navItemFor('/enrolments/season/x')?.group?.label).toBe('Programmes & enrolment')
    expect(navItemFor('/interest/abc')?.item.label).toBe('Interest')
    expect(navItemFor('/players/training/abc')?.item.label).toBe('Players')
    expect(navItemFor('/players/competition')?.group?.label).toBe('Players')
    expect(navItemFor('/nowhere')).toBeNull()
    // A prefix must end at a path segment: /newsletter isn't News.
    expect(navItemFor('/newsletter')).toBeNull()
  })

  it('marks the current bottom-bar item', () => {
    const bar = bottomBar({ role: 'editor', canManageUsers: false })
    expect(bar.map((i) => i.label)).toEqual(['Home', 'Matches', 'Leagues', 'Pages'])
    expect(bar.filter((i) => isCurrent(i, '/seasons/a/results')).map((i) => i.label)).toEqual(['Leagues'])
    expect(bar.filter((i) => isCurrent(i, '/')).map((i) => i.label)).toEqual(['Home'])
  })
})
