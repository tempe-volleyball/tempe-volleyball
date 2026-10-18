import type { AstroGlobal } from 'astro'
import { PROGRAMME_PATH_PREFIX } from '../../lib/programmes'
import { normalisePath } from '../../lib/wp-import/routes'
import { cachePublic, tags } from '../cache'
import { renderBody } from '../content/blocks'
import type { ProgrammeKind } from '../db/schema'
import { publicDb, publicSite, redirectFor } from '../public'
import { getTurnstileKeys } from '../services'
import { lookupPath, type Site } from '../site'
import { groupByCategory, loadListings, loadProgrammePage, programmePageTags, type ProgrammePageData } from './public'

// The shared route logic of /training/<slug>, /programs/<slug> and /events/<slug> (leagues have their own route,
// which also shows the current season). Returns a Response to send as is (a 301), or what ProgrammeDetail renders;
// `page` null means a 404 (the status is already set). Plus the kind index pages /training, /programs, /events.

export type ProgrammeRoute = { site: Site; page: ProgrammePageData | null; now: Date }

export async function programmeRoute(astro: AstroGlobal, kind: Exclude<ProgrammeKind, 'league'>): Promise<Response | ProgrammeRoute> {
  const slug = (astro.params.slug ?? '').toLowerCase()
  const db = publicDb()
  const now = new Date()
  const [site, lookup] = await Promise.all([
    publicSite(db),
    loadProgrammePage(db, kind, slug, { turnstileSiteKey: getTurnstileKeys()?.siteKey ?? null, now }),
  ])
  if (lookup && 'redirect' in lookup) return astro.redirect(lookup.redirect, 301)
  if (!lookup) {
    const redirect = await redirectFor(astro, db, normalisePath(astro.url.pathname))
    if (redirect) return redirect
    astro.response.status = 404
    return { site, page: null, now }
  }
  cachePublic(astro.cache, ...programmePageTags(lookup.found.programme, lookup.found.category?.slug ?? null))
  return { site, page: lookup.found, now }
}

// ── Kind index pages: /training, /programs, /events ───────────────────────────

export type IndexKind = Exclude<ProgrammeKind, 'league'>

/** A kind index page's own words, used until a page published at its path supplies the title and intro. */
export const KIND_INDEX: Record<IndexKind, { title: string; intro: string; empty: string; description: string }> = {
  training: {
    title: 'Training',
    intro: 'Coached and casual volleyball training. Pick a program for its sessions, times and how to enrol.',
    empty: 'No training is running right now.',
    description: 'Volleyball training at Tempe Volleyball in Sydney: coached and casual sessions, with dates, times and enrolment.',
  },
  development: {
    title: 'Development Programs',
    intro: 'Development programs for adults and juniors, run in terms. Pick a program for its terms, times and how to enrol.',
    empty: 'No development program is running right now.',
    description: 'Volleyball development programs for adults and juniors at Tempe Volleyball in Sydney: terms, times and enrolment.',
  },
  event: {
    title: 'Events',
    intro: 'Tournaments, trials, socials and come-and-try days. Pick an event for its dates and how to enter.',
    empty: 'No events are coming up right now.',
    description: 'Volleyball events at Tempe Volleyball in Sydney: tournaments, trials, socials and come-and-try days.',
  },
}

export type KindIndexRoute = {
  site: Site
  kind: IndexKind
  path: string
  /** Active programmes of the kind, by category in category order (cards without a category last). */
  groups: ReturnType<typeof groupByCategory>
  /** The page published at this path, if any: its title is the H1 and its body (data blocks too) the intro. */
  intro: { title: string; html: string; metaDescription: string | null; bodyHtml: string } | null
  titles: Map<string, string>
}

/**
 * /training, /programs and /events (docs/admin.md §3.13): every active programme of the kind, grouped by category,
 * generated from the programmes like /enrol, so a new one appears on its own and a retired one leaves. The intro is
 * hand-editable the same way: publish a page at that path in Admin → Pages. Three parallel round trips (the Site is
 * memoised), plus one batch when the intro page has data blocks.
 */
export async function kindIndexRoute(astro: AstroGlobal, kind: IndexKind): Promise<KindIndexRoute> {
  const path = PROGRAMME_PATH_PREFIX[kind]
  const db = publicDb()
  const [site, found, listings] = await Promise.all([publicSite(db), lookupPath(db, path), loadListings(db)])
  const page = found.page
  const body = page ? await renderBody(db, site, page.body, new Date(), { turnstileSiteKey: getTurnstileKeys()?.siteKey ?? null }) : null
  cachePublic(astro.cache, tags.page(path), tags.programmes, tags.venues, ...(body?.tags ?? []))
  return {
    site,
    kind,
    path,
    groups: groupByCategory(
      listings,
      listings.programmes.filter((c) => c.kind === kind),
    ),
    intro: page ? { title: page.title, html: body?.html ?? '', metaDescription: page.metaDescription, bodyHtml: page.body.html } : null,
    titles: found.titles,
  }
}
