import { inArray } from 'drizzle-orm'
import { tags } from '../cache'
import { runBatch, type AppDb } from '../db'
import { siteSettings, type UserRole } from '../db/schema'
import { HttpError } from '../http'
import { atLeast } from '../../lib/roles'
import {
  checkSetting,
  isSettingKey,
  privateSettingKeys,
  readSettings,
  settingKeys,
  settingMinRole,
  type SettingKey,
  type SiteSettings,
} from '../../lib/content/settings'
import { audit, invalid, type Changed, type Editor } from './common'

// Site settings: one site_settings row per key (src/lib/content/settings.ts has the keys, defaults and rules).

export async function getSettings(db: AppDb): Promise<SiteSettings> {
  const rows = await db
    .select({ key: siteSettings.key, value: siteSettings.value })
    .from(siteSettings)
    .where(inArray(siteSettings.key, [...settingKeys]))
    .all()
  return readSettings(rows)
}

/**
 * Saves some settings: { contact: {...}, announcement: {...} }. Every key is validated and role-checked first,
 * then all are written in one batch with one settings.update audit entry per changed key.
 */
export async function saveSettings(
  db: AppDb,
  actor: Editor & { role: UserRole },
  input: Record<string, unknown>,
  now = new Date(),
): Promise<Changed<SiteSettings>> {
  const keys = Object.keys(input)
  if (keys.length === 0) throw invalid('Nothing to save.')
  const updates: { key: SettingKey; value: unknown }[] = []
  for (const key of keys) {
    if (!isSettingKey(key)) throw invalid(`Unknown setting: ${key}.`)
    if (!atLeast(actor.role, settingMinRole[key]))
      throw new HttpError(403, 'forbidden', `Only ${settingMinRole[key]}s and above can change the ${key} setting.`)
    const checked = checkSetting(key, input[key])
    if (!checked.ok) throw invalid(checked.message)
    updates.push({ key, value: checked.value })
  }
  const current = await getSettings(db)
  const changed = updates.filter((u) => JSON.stringify(u.value) !== JSON.stringify(current[u.key]))
  if (changed.length === 0) return { result: current, purge: {} }
  const at = now.toISOString()
  await runBatch(db, [
    ...changed.map((u) =>
      db
        .insert(siteSettings)
        .values({ key: u.key, value: u.value, updatedAt: at })
        .onConflictDoUpdate({ target: siteSettings.key, set: { value: u.value, updatedAt: at } }),
    ),
    ...changed.map((u) => audit(db, actor, 'settings.update', { type: 'setting', id: u.key }, current[u.key], u.value, at)),
  ])
  const publicChange = changed.some((u) => !privateSettingKeys.includes(u.key))
  return { result: await getSettings(db), purge: publicChange ? { tags: [tags.site] } : {} }
}
