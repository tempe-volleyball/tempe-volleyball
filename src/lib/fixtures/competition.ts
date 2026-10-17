import { assignDates, generate } from './scheduler'
import { dutyEnabled, type Competition, type Settings } from './types'

/**
 * The parts of the settings that change the draw itself (duty too: it changes
 * how games are split across sessions). Courts aren't one:
 * they're just the default court for each slot and can be changed per game.
 */
export function shapeKey(s: Settings): string {
  return JSON.stringify([s.teams.map((t) => t.id), s.sessions.length, s.meetings, s.includeFinals, dutyEnabled(s)])
}

export const isStale = (c: Competition) => !!c.weeks && c.generatedFrom !== shapeKey(c.settings)

export function withGenerated(c: Competition): Competition {
  return { ...c, weeks: generate(c.settings), edited: false, generatedFrom: shapeKey(c.settings), updatedAt: Date.now() }
}

/**
 * Apply new settings. Names, times and court names are looked up live, and
 * dates are re-laid without touching who plays whom, so only changes to the
 * shape of the competition need a regenerate.
 */
export function withSettings(c: Competition, settings: Settings): Competition {
  const weeks =
    c.weeks && /^\d{4}-\d{2}-\d{2}$/.test(settings.startDate)
      ? assignDates(
          settings,
          c.weeks.filter((w) => w.kind !== 'skip'),
        )
      : c.weeks
  return { ...c, settings, weeks, updatedAt: Date.now() }
}

export const withPublished = (c: Competition, published: boolean): Competition => ({
  ...c,
  status: published ? 'published' : 'draft',
  publishedAt: published ? Date.now() : undefined,
  updatedAt: Date.now(),
})
