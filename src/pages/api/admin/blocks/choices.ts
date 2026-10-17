import type { APIRoute } from 'astro'
import { blockChoices } from '../../../../server/content/blocks'
import { handle, json, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'
import { loadSite } from '../../../../server/site'

/** Categories, programmes and leagues (with current-season teams) for the page editor's data blocks. Editors and up. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    await requireRole(locals.user, 'editor', request, db)
    return json(await blockChoices(db, await loadSite(db)))
  })
