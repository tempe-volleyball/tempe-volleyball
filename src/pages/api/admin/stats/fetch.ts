import type { APIRoute } from 'astro'
import { sources, type Source } from '../../../../lib/analytics/rows'
import { runAnalytics } from '../../../../server/analytics/fetch'
import { audit } from '../../../../server/content/common'
import { HttpError, handle, json, readJson, requireRole } from '../../../../server/http'
import { analyticsSecrets, getServices } from '../../../../server/services'

/**
 * "Fetch now": { source: 'ga4' | 'search_console' | 'cloudflare' }. Fetches that one source straight away (the
 * next window, or the last few days again when it's up to date), ignoring the retry backoff. Admins and owners.
 * Audited as analytics.fetch. The result is RunResult from src/server/analytics/fetch.ts.
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const { db } = getServices()
    const actor = await requireRole(locals.user, 'admin', request, db)
    const body = await readJson<{ source: string }>(request)
    if (!sources.includes(body.source as Source)) throw new HttpError(400, 'invalid_input', 'Pick a source to fetch.')
    const source = body.source as Source
    const result = await runAnalytics(db, { secrets: analyticsSecrets(), fetch: (i, init) => fetch(i, init) }, new Date(), { source })
    await audit(db, actor, 'analytics.fetch', { type: 'analytics', id: source }, null, result, new Date().toISOString())
    return json({ result })
  })
