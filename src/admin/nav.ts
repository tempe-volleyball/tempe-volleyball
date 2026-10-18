import type { UserRole } from '../lib/roles'

// The admin's navigation (docs/admin.md §4): grouped the way the organiser thinks about the work. The sidebar
// (desktop) and the "More" sheet (phones) show these groups; the phone's bottom bar shows BOTTOM_BAR.

export type NavItem = {
  href: string
  label: string
  /** Who sees it: admins and owners only, or only those who manage users. Everyone else sees all the rest. */
  only?: 'admin' | 'users'
  /** Other path prefixes that belong to this item (a season belongs to Leagues). */
  also?: string[]
}

export type NavGroup = { label: string; items: NavItem[] }

export const HOME: NavItem = { href: '/', label: 'Home' }

export const NAV: NavGroup[] = [
  {
    label: 'Competition',
    items: [
      { href: '/leagues', label: 'Leagues', also: ['/seasons'] },
      { href: '/matches', label: 'Matches' },
      { href: '/teams', label: 'Teams' },
      { href: '/venues', label: 'Venues' },
    ],
  },
  {
    label: 'Programmes & enrolment',
    items: [
      { href: '/training', label: 'Training' },
      { href: '/development', label: 'Development' },
      { href: '/events', label: 'Events' },
      { href: '/categories', label: 'Categories' },
      { href: '/enrolments', label: 'Enrolments', only: 'admin' },
      { href: '/forms', label: 'Forms', only: 'admin' },
    ],
  },
  {
    label: 'Content',
    items: [
      { href: '/pages', label: 'Pages' },
      { href: '/news', label: 'News' },
      { href: '/menu', label: 'Menu' },
      { href: '/media', label: 'Media' },
    ],
  },
  {
    label: 'Site',
    items: [
      { href: '/stats', label: 'Stats' },
      { href: '/settings', label: 'Settings' },
    ],
  },
  {
    label: 'People',
    items: [
      { href: '/users', label: 'Admin users', only: 'users' },
      { href: '/audit', label: 'Audit log', only: 'users' },
      { href: '/security', label: 'Security' },
    ],
  },
]

export type NavViewer = { role: UserRole; canManageUsers: boolean }

const visible = (item: NavItem, v: NavViewer) => !item.only || (item.only === 'admin' ? v.role !== 'editor' : v.canManageUsers)

/** The groups this viewer sees (empty groups left out). */
export const navFor = (v: NavViewer): NavGroup[] =>
  NAV.map((g) => ({ ...g, items: g.items.filter((i) => visible(i, v)) })).filter((g) => g.items.length > 0)

const matches = (prefix: string, location: string) => location === prefix || location.startsWith(`${prefix}/`)

/** The nav item a location (inside the /admin base) belongs to, and its group; Home for "/". */
export function navItemFor(location: string): { item: NavItem; group: NavGroup | null } | null {
  if (location === '/' || location === '') return { item: HOME, group: null }
  for (const group of NAV)
    for (const item of group.items) if ([item.href, ...(item.also ?? [])].some((p) => matches(p, location))) return { item, group }
  return null
}

/**
 * The phone's bottom bar: the screens used at the venue and day to day, then "More" (every group). Editors get
 * Pages instead of Enrolments, which they can't open.
 */
export const bottomBar = (v: NavViewer): NavItem[] => [
  HOME,
  { href: '/matches', label: 'Matches' },
  { href: '/leagues', label: 'Leagues', also: ['/seasons'] },
  v.role === 'editor' ? { href: '/pages', label: 'Pages' } : { href: '/enrolments', label: 'Enrolments' },
]

/** True when `item` is where `location` is. */
export const isCurrent = (item: NavItem, location: string) =>
  item.href === '/' ? location === '/' || location === '' : [item.href, ...(item.also ?? [])].some((p) => matches(p, location))
