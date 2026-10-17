import { isPublished, type Competition } from './types'

export type Tab = 'setup' | 'fixtures' | 'publish' | 'results' | 'website'
export const ALL_TABS: Tab[] = ['setup', 'fixtures', 'publish', 'results', 'website']

/** Where the home page sends you for a competition. */
export const landingTab = (c: Competition): Tab => (isPublished(c) ? 'results' : c.weeks ? 'fixtures' : 'setup')
