import type { APIRoute } from 'astro'
import { atLeast } from '../../../../lib/roles'
import { loadStats, parseRange } from '../../../../server/analytics/stats'
import { getSettings } from '../../../../server/content/settings'
import { handle, json, requireRole } from '../../../../server/http'
import { analyticsSecrets, getServices } from '../../../../server/services'

/**
 * The Stats page: ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: the 28 days to yesterday). Read from D1 only.
 * Editors and up; the business numbers (registrations by programme) are for admins and owners.
 */
export const GET: APIRoute = ({ locals, request, url }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'editor', request, db)
    const range = parseRange(url, new Date())
    const settings = (await getSettings(db)).analytics
    const stats = await loadStats(db, range, { settings, secrets: analyticsSecrets(), withBusiness: atLeast(actor.role, 'admin') })
    return json({ ...stats, canFetch: atLeast(actor.role, 'admin') })
  })
