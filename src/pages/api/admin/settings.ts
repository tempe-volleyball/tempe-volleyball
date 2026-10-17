import type { APIRoute } from 'astro'
import { settingMinRole } from '../../../lib/content/settings'
import { purge } from '../../../server/cache'
import { getSettings, saveSettings } from '../../../server/content/settings'
import { handle, json, readJson, requireRole } from '../../../server/http'
import { getServices } from '../../../server/services'

/** All site settings (defaults filled in) and the minimum role for changing each. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    requireRole(locals.user, 'editor', request)
    return json({ settings: await getSettings(getServices().db), minRole: settingMinRole })
  })

/** Saves some keys: { contact?, payid?, social?, revolutioniseUrl?, announcement? }. Role-checked and audited per key. */
export const PUT: APIRoute = ({ locals, request, cache }) =>
  handle(async () => {
    const actor = requireRole(locals.user, 'editor', request)
    const { result, purge: targets } = await saveSettings(getServices().db, actor, await readJson(request))
    return json({ settings: result, minRole: settingMinRole, cache: await purge(cache, targets) })
  })
