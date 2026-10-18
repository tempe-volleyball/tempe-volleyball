import type { APIRoute } from 'astro'
import { previewBlock } from '../../../../server/content/blocks'
import { handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices, getTurnstileKeys } from '../../../../server/services'
import { loadSite } from '../../../../server/site'

/**
 * One data block rendered as the public page would show it: { block: { type, attrs } } -> { html, lines, note }.
 * Read-only (POST because the block travels in the body). Editors and up.
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'editor', request, db)
    const { block } = await readJson<{ block: unknown }>(request)
    return json(await previewBlock(db, await loadSite(db), block, new Date(), { turnstileSiteKey: getTurnstileKeys()?.siteKey ?? null }))
  })
