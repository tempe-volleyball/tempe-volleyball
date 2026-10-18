import type { APIRoute } from 'astro'
import { createPage, listPages } from '../../../../server/content/pages'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/** Every page (?q= searches title and path). Editors and up. */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    return json({ pages: await listPages(getServices().db, { q: url.searchParams.get('q') ?? undefined }) })
  })

/** Creates a draft page: { title, path, metaDescription?, ogImageId?, seoTitle?, noindex?, template?, blocks? }. */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'editor', request, getServices().db)
    const page = await createPage(getServices().db, actor, await readJson(request))
    return json({ page }, 201)
  })
