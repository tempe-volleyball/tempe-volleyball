import type { TeamHref } from './tables'
// Team list helpers (Admin → Teams). Pure. SportsPress grew duplicates ("Ice Cold" and "ICE COLD!", "The Aces" and
// "Aces"), so the list suggests teams that look like the same team and haven't played in the same season (two teams in
// one season are two real teams, and the server refuses to merge them).

/** A team name reduced to what tells teams apart: lower case, letters and digits only, without a leading "the". */
export function teamKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '')
    .replace(/ /g, '')
}

type TeamLike = { id: string; name: string; history: { id: string }[] }

/** Can `a` and `b` be merged? Not when they share a season. */
export const shareASeason = (a: TeamLike, b: TeamLike) => {
  const seasons = new Set(a.history.map((h) => h.id))
  return b.history.some((h) => seasons.has(h.id))
}

/**
 * Groups of two or more teams whose names match on teamKey(), each team in a group mergeable with the first (the
 * one with the most seasons, then the oldest name A–Z), which is the suggested team to keep.
 */
export function duplicateGroups<T extends TeamLike>(teams: T[]): T[][] {
  const byKey = new Map<string, T[]>()
  for (const t of teams) {
    const k = teamKey(t.name)
    if (!k) continue
    byKey.set(k, [...(byKey.get(k) ?? []), t])
  }
  const out: T[][] = []
  for (const list of byKey.values()) {
    if (list.length < 2) continue
    const [keep, ...rest] = list.toSorted((a, b) => b.history.length - a.history.length || a.name.localeCompare(b.name))
    const mergeable = rest.filter((t) => !shareASeason(keep!, t))
    if (mergeable.length) out.push([keep!, ...mergeable])
  }
  return out.toSorted((a, b) => a[0]!.name.localeCompare(b[0]!.name))
}

// ── Team pages (docs/public-site.md "Team pages"): one page per team across leagues, at /teams/<slug>. ──

export const TEAMS_PREFIX = '/teams'

export const teamPath = (slug: string) => `${TEAMS_PREFIX}/${slug}`

/** A TeamHref for the teams of a season (every team in a published season has a page). */
export function teamHrefFor(teams: readonly { id: string; slug: string }[]): TeamHref {
  const bySlug = new Map(teams.map((t) => [t.id, t.slug]))
  return (id) => {
    const slug = bySlug.get(id)
    return slug ? teamPath(slug) : null
  }
}
