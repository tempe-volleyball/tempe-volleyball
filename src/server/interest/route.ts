import type { AstroGlobal } from 'astro'
import { INTEREST_ROUTE, interestPath } from '../../lib/interest'
import { cachePublic, tags } from '../cache'
import { renderBody } from '../content/blocks'
import { publicDb, publicSite, redirectFor } from '../public'
import { getTurnstileKeys } from '../services'
import { lookupPath, type Site } from '../site'
import { loadInterestForm, type InterestFormLoad, type InterestProgrammeOption } from './public'

// The route logic of /interest and /interest/<programme slug> (src/pages/interest/), rendered by
// src/components/interest/InterestPage.astro. Returns a Response to send as is (a redirect), or what the page shows;
// `missing` means a 404 (the status is already set).
//
// - /interest/<slug> of a programme that exists but isn't taking EOIs (enrolment mode, EOIs off, retired) is a 302 to
//   /interest: temporary, because EOIs may open again and a cached 301 would keep sending people away.
// - An unknown (or draft) slug tries the redirects table, else 404s.
// - /interest's intro is editable twice over: a page published at /interest (title = H1, body above the form,
//   description = meta description), and Settings → Interest → Intro (the form's own lead).
//
// Edge-cached: every EOI page carries tags.page('/interest') (purged when an enrolment form changes, see
// src/server/enrolment/forms.ts formPurge), tags.programmes (every programme save), tags.venues (the summary lines);
// a Settings save purges `site`, which every page carries.

export type InterestRoute = {
  site: Site
  slug: string | null
  missing: boolean
  form: InterestFormLoad['form']
  programme: InterestProgrammeOption | null
  intro: { title: string; html: string; metaDescription: string | null; bodyHtml: string } | null
  titles: Map<string, string>
}

export const interestPageTags = (slug: string | null) => [
  tags.page(INTEREST_ROUTE),
  tags.programmes,
  tags.venues,
  ...(slug ? [tags.page(interestPath(slug)), tags.programme(slug)] : []),
]

export async function interestRoute(astro: AstroGlobal, rawSlug: string | null): Promise<Response | InterestRoute> {
  const slug = rawSlug?.toLowerCase() || null
  const db = publicDb()
  const now = new Date()
  const turnstileSiteKey = getTurnstileKeys()?.siteKey ?? null
  const [site, found, load] = await Promise.all([
    publicSite(db),
    slug ? Promise.resolve(null) : lookupPath(db, INTEREST_ROUTE),
    loadInterestForm(db, now, { programmeSlug: slug, turnstileSiteKey }),
  ])
  if (load.slug?.status === 'not_offered') {
    cachePublic(astro.cache, ...interestPageTags(slug))
    return astro.redirect(INTEREST_ROUTE, 302)
  }
  const base = { site, slug, form: load.form, programme: load.slug?.programme ?? null, titles: found?.titles ?? new Map<string, string>() }
  if (load.slug?.status === 'unknown') {
    const redirect = await redirectFor(astro, db, interestPath(slug))
    if (redirect) return redirect
    astro.response.status = 404
    return { ...base, missing: true, intro: null }
  }
  const page = found?.page ?? null
  const body = page ? await renderBody(db, site, page.body, now, { turnstileSiteKey }) : null
  cachePublic(astro.cache, ...interestPageTags(slug), ...(body?.tags ?? []))
  return {
    ...base,
    missing: false,
    intro: page ? { title: page.title, html: body?.html ?? '', metaDescription: page.metaDescription, bodyHtml: page.body.html } : null,
  }
}
