import type { AstroGlobal } from 'astro'
import { normalisePath } from '../../lib/wp-import/routes'
import { cachePublic } from '../cache'
import type { ProgrammeKind } from '../db/schema'
import { publicDb, redirectFor } from '../public'
import { getTurnstileKeys } from '../services'
import { loadSite, type Site } from '../site'
import { loadProgrammePage, programmePageTags, type ProgrammePageData } from './public'

// The shared route logic of /training/<slug>, /programs/<slug> and /events/<slug> (leagues have their own route,
// which also shows the current season). Returns a Response to send as is (a 301), or what ProgrammeDetail renders;
// `page` null means a 404 (the status is already set).

export type ProgrammeRoute = { site: Site; page: ProgrammePageData | null; now: Date }

export async function programmeRoute(astro: AstroGlobal, kind: Exclude<ProgrammeKind, 'league'>): Promise<Response | ProgrammeRoute> {
  const slug = (astro.params.slug ?? '').toLowerCase()
  const db = publicDb()
  const now = new Date()
  const [site, lookup] = await Promise.all([
    loadSite(db),
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
