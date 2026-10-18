import type { APIRoute } from 'astro'
import { sources } from '../../../lib/analytics/rows'
import { sourceStatus } from '../../../server/analytics/fetch'
import { getSettings } from '../../../server/content/settings'
import { loadDashboard } from '../../../server/dashboard'
import { handle, json, requireRole } from '../../../server/http'
import { analyticsSecrets, getServices, getTurnstileKeys, secrets } from '../../../server/services'

/**
 * The admin home page: games this week, results still to enter or publish, enrolment needing attention, drafts to
 * review, recent activity and setup still needed (docs/admin.md §4). Editors and up; enrolment, activity and setup
 * are for admins and owners.
 */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'editor', request, db, { fresh: true })
    const settings = await getSettings(db)
    const keys = getTurnstileKeys()
    return json(
      await loadDashboard(db, {
        role: actor.role,
        resend: !!secrets.RESEND_API_KEY?.trim(),
        turnstile: !keys ? 'none' : keys.test ? 'test' : 'real',
        analytics: sources.map((s) => sourceStatus(s, settings.analytics, analyticsSecrets())),
        payid: !!settings.payid.payId.trim(),
      }),
    )
  })
