import { and, asc, count, eq, isNotNull, like, ne, or } from 'drizzle-orm'
import { slugify } from '../../lib/content/paths'
import { tags } from '../cache'
import { runBatch, type AppDb } from '../db'
import {
  courts,
  developmentTerms,
  events,
  matchDays,
  matches,
  programmes,
  programmeSessions,
  seasons,
  venues,
  type Court,
  type Venue,
} from '../db/schema'
import { audit, conflict, isUniqueFailure, notFound, optionalText, requiredText, type Changed, type Editor } from '../content/common'
import { has, invalid, linkOrNull, longText, purgeOf, slug as parseSlug } from './common'

// Venues (the places: Robyn Webster Sports Centre, MLC School, Five Dock Leisure Centre) and the courts inside them.
//
// Rules: venue slugs and court names (within a venue) are unique. A venue can be deleted only when it has no courts
// and no programme, term, session or event uses it; a court only when no match, term or session uses it and no
// season names it as a default court or a court override. Venue details show on public pages (programme lines,
// Where We Play and the footer), so changes purge SITE and tags.venues.

export const VENUE_LIMITS = { name: 120, address: 300, directions: 4000, courtName: 60, courts: 30 } as const

export type CourtRow = Court & { matches: number; sessions: number; terms: number }
export type VenueRow = Venue & {
  courts: CourtRow[]
  /** What uses this venue (deleting it is refused while any is non-zero, courts included). */
  usage: { programmes: number; terms: number; sessions: number; events: number }
}

type ByVenue = { venueId: string | null; n: number }
type ByCourt = { courtId: string | null; n: number }

/** Every venue with its courts (in order) and what uses them. One batch. */
export async function listVenues(db: AppDb): Promise<VenueRow[]> {
  const res = (await runBatch(db, [
    db.select().from(venues).orderBy(asc(venues.sort), asc(venues.name)),
    db.select().from(courts).orderBy(asc(courts.sort), asc(courts.name)),
    db.select({ venueId: programmes.defaultVenueId, n: count() }).from(programmes).groupBy(programmes.defaultVenueId),
    db.select({ venueId: developmentTerms.venueId, n: count() }).from(developmentTerms).groupBy(developmentTerms.venueId),
    db.select({ venueId: programmeSessions.venueId, n: count() }).from(programmeSessions).groupBy(programmeSessions.venueId),
    db.select({ venueId: events.venueId, n: count() }).from(events).groupBy(events.venueId),
    db.select({ courtId: matches.courtId, n: count() }).from(matches).where(isNotNull(matches.courtId)).groupBy(matches.courtId),
    db.select({ courtId: programmeSessions.courtId, n: count() }).from(programmeSessions).groupBy(programmeSessions.courtId),
    db.select({ courtId: developmentTerms.courtId, n: count() }).from(developmentTerms).groupBy(developmentTerms.courtId),
  ])) as unknown as [Venue[], Court[], ByVenue[], ByVenue[], ByVenue[], ByVenue[], ByCourt[], ByCourt[], ByCourt[]]
  const [vs, cs, progs, terms, sessions, evs, cMatches, cSessions, cTerms] = res
  const nv = (rows: ByVenue[], id: string) => rows.find((r) => r.venueId === id)?.n ?? 0
  const nc = (rows: ByCourt[], id: string) => rows.find((r) => r.courtId === id)?.n ?? 0
  return vs.map((v) => ({
    ...v,
    courts: cs
      .filter((c) => c.venueId === v.id)
      .map((c) => ({ ...c, matches: nc(cMatches, c.id), sessions: nc(cSessions, c.id), terms: nc(cTerms, c.id) })),
    usage: { programmes: nv(progs, v.id), terms: nv(terms, v.id), sessions: nv(sessions, v.id), events: nv(evs, v.id) },
  }))
}

const venuePurge = () => purgeOf([tags.site, tags.venues, tags.programmes])

const loadVenue = async (db: AppDb, id: string) => {
  const v = await db.select().from(venues).where(eq(venues.id, id)).get()
  if (!v) throw notFound('venue')
  return v
}

const loadCourt = async (db: AppDb, id: string) => {
  const c = await db.select().from(courts).where(eq(courts.id, id)).get()
  if (!c) throw notFound('court')
  return c
}

const venueRow = async (db: AppDb, id: string) => {
  const v = (await listVenues(db)).find((x) => x.id === id)
  if (!v) throw notFound('venue')
  return v
}

type VenuePatch = Partial<Pick<Venue, 'name' | 'slug' | 'address' | 'mapUrl' | 'directions' | 'sort'>>

function parseVenue(input: Record<string, unknown>): VenuePatch {
  const out: VenuePatch = {}
  if (has(input, 'name')) out.name = requiredText(input.name, 'Name', VENUE_LIMITS.name)
  if (has(input, 'slug')) out.slug = parseSlug(input.slug)
  if (has(input, 'address')) out.address = optionalText(input.address, 'Address', VENUE_LIMITS.address)
  if (has(input, 'mapUrl')) out.mapUrl = linkOrNull(input.mapUrl, 'Map link')
  if (has(input, 'directions')) out.directions = longText(input.directions, 'Directions', VENUE_LIMITS.directions)
  if (has(input, 'sort')) {
    if (typeof input.sort !== 'number' || !Number.isInteger(input.sort)) throw invalid('Order must be a whole number.')
    out.sort = input.sort
  }
  return out
}

const slugTaken = (s: string) => conflict(`Another venue already uses the URL name “${s}”.`)

export async function createVenue(db: AppDb, actor: Editor, input: Record<string, unknown>, now = new Date()): Promise<Changed<VenueRow>> {
  const patch = parseVenue(input)
  if (!patch.name) throw invalid('Name is required.')
  const s = patch.slug ?? parseSlug(slugify(patch.name))
  const [taken, last] = await Promise.all([
    db.select({ id: venues.id }).from(venues).where(eq(venues.slug, s)).get(),
    db.select({ sort: venues.sort }).from(venues).orderBy(asc(venues.sort)).all(),
  ])
  if (taken) throw slugTaken(s)
  const values = { sort: (last.at(-1)?.sort ?? -1) + 1, ...patch, name: patch.name, slug: s, id: crypto.randomUUID(), updatedBy: actor.id }
  const at = now.toISOString()
  try {
    await runBatch(db, [
      db.insert(venues).values({ ...values, createdAt: at, updatedAt: at }),
      audit(db, actor, 'venue.create', { type: 'venue', id: values.id }, null, values, at),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'venues.slug')) throw slugTaken(s)
    throw e
  }
  return { result: await venueRow(db, values.id), purge: venuePurge() }
}

export async function updateVenue(
  db: AppDb,
  actor: Editor,
  id: string,
  input: Record<string, unknown>,
  now = new Date(),
): Promise<Changed<VenueRow>> {
  const current = await loadVenue(db, id)
  if (typeof input.baseUpdatedAt === 'string' && input.baseUpdatedAt !== current.updatedAt)
    throw conflict('Someone else changed this venue while you were working on it. Reload to see their changes.')
  const patch = parseVenue(input)
  const next = { ...current, ...patch }
  const keys = (Object.keys(patch) as (keyof VenuePatch)[]).filter((k) => current[k] !== next[k])
  if (keys.length === 0) return { result: await venueRow(db, id), purge: {} }
  if (next.slug !== current.slug) {
    const taken = await db
      .select({ id: venues.id })
      .from(venues)
      .where(and(eq(venues.slug, next.slug), ne(venues.id, id)))
      .get()
    if (taken) throw slugTaken(next.slug)
  }
  const at = now.toISOString()
  const pick = (v: Venue) => Object.fromEntries(keys.map((k) => [k, v[k]]))
  try {
    await runBatch(db, [
      db
        .update(venues)
        .set({ ...patch, updatedAt: at, updatedBy: actor.id })
        .where(eq(venues.id, id)),
      audit(db, actor, 'venue.update', { type: 'venue', id }, pick(current), pick(next), at),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'venues.slug')) throw slugTaken(next.slug)
    throw e
  }
  return { result: await venueRow(db, id), purge: venuePurge() }
}

export async function deleteVenue(db: AppDb, actor: Editor, id: string, now = new Date()): Promise<Changed<{ id: string }>> {
  const v = await venueRow(db, id)
  const u = v.usage
  const uses = [
    v.courts.length && `${v.courts.length} court${v.courts.length > 1 ? 's' : ''}`,
    u.programmes && `${u.programmes} programme${u.programmes > 1 ? 's' : ''}`,
    u.terms && `${u.terms} term${u.terms > 1 ? 's' : ''}`,
    u.sessions && `${u.sessions} session${u.sessions > 1 ? 's' : ''}`,
    u.events && `${u.events} event${u.events > 1 ? 's' : ''}`,
  ].filter(Boolean)
  if (uses.length) throw conflict(`${v.name} is still used (${uses.join(', ')}), so it can't be deleted.`)
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(venues).where(eq(venues.id, id)),
    audit(db, actor, 'venue.delete', { type: 'venue', id }, { name: v.name, slug: v.slug, address: v.address }, null, at),
  ])
  return { result: { id }, purge: venuePurge() }
}

// ── Courts ────────────────────────────────────────────────────────────────────

const courtNameTaken = (name: string, venue: string) => conflict(`${venue} already has a court called “${name}”.`)

async function assertCourtNameFree(db: AppDb, venue: Venue, name: string, exceptId?: string) {
  const others = await db
    .select({ id: courts.id, name: courts.name })
    .from(courts)
    .where(exceptId ? and(eq(courts.venueId, venue.id), ne(courts.id, exceptId)) : eq(courts.venueId, venue.id))
    .all()
  if (others.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) throw courtNameTaken(name, venue.name)
  return others.length
}

export async function createCourt(
  db: AppDb,
  actor: Editor,
  venueId: string,
  input: { name?: unknown },
  now = new Date(),
): Promise<Changed<VenueRow>> {
  const venue = await loadVenue(db, venueId)
  const name = requiredText(input.name, 'Court name', VENUE_LIMITS.courtName)
  const existing = await assertCourtNameFree(db, venue, name)
  if (existing >= VENUE_LIMITS.courts) throw invalid(`A venue can have at most ${VENUE_LIMITS.courts} courts.`)
  const last = await db.select({ sort: courts.sort }).from(courts).where(eq(courts.venueId, venueId)).orderBy(asc(courts.sort)).all()
  const values = { id: crypto.randomUUID(), venueId, name, sort: (last.at(-1)?.sort ?? -1) + 1, updatedBy: actor.id }
  const at = now.toISOString()
  try {
    await runBatch(db, [
      db.insert(courts).values({ ...values, createdAt: at, updatedAt: at }),
      audit(db, actor, 'court.create', { type: 'court', id: values.id }, null, { venue: venue.name, name }, at),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'courts.venue_id')) throw courtNameTaken(name, venue.name)
    throw e
  }
  return { result: await venueRow(db, venueId), purge: venuePurge() }
}

/** Renames a court. Seasons store court ids, so their draws and results follow the new name. */
export async function updateCourt(
  db: AppDb,
  actor: Editor,
  id: string,
  input: { name?: unknown },
  now = new Date(),
): Promise<Changed<VenueRow>> {
  const court = await loadCourt(db, id)
  const venue = await loadVenue(db, court.venueId)
  const name = requiredText(input.name, 'Court name', VENUE_LIMITS.courtName)
  if (name === court.name) return { result: await venueRow(db, venue.id), purge: {} }
  await assertCourtNameFree(db, venue, name, id)
  const at = now.toISOString()
  try {
    await runBatch(db, [
      db.update(courts).set({ name, updatedAt: at, updatedBy: actor.id }).where(eq(courts.id, id)),
      audit(db, actor, 'court.update', { type: 'court', id }, { name: court.name }, { name }, at),
    ])
  } catch (e) {
    if (isUniqueFailure(e, 'courts.venue_id')) throw courtNameTaken(name, venue.name)
    throw e
  }
  // Court names show on every fixture list.
  return { result: await venueRow(db, venue.id), purge: venuePurge() }
}

/** Saves a venue's court order: every court id of the venue, first first. */
export async function reorderCourts(
  db: AppDb,
  actor: Editor,
  venueId: string,
  input: { ids?: unknown },
  now = new Date(),
): Promise<Changed<VenueRow>> {
  const venue = await loadVenue(db, venueId)
  const ids = input.ids
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw invalid('Send ids: the court ids in order.')
  const rows = await db.select({ id: courts.id, sort: courts.sort }).from(courts).where(eq(courts.venueId, venueId)).all()
  const known = new Set(rows.map((r) => r.id))
  if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((x) => !known.has(x as string)))
    throw conflict('The courts changed while you were reordering. Reload and try again.')
  const changed = (ids as string[]).map((cid, i) => ({ id: cid, sort: i })).filter((r) => rows.find((x) => x.id === r.id)?.sort !== r.sort)
  if (changed.length === 0) return { result: await venueRow(db, venueId), purge: {} }
  const at = now.toISOString()
  await runBatch(db, [
    ...changed.map((r) => db.update(courts).set({ sort: r.sort, updatedAt: at, updatedBy: actor.id }).where(eq(courts.id, r.id))),
    audit(
      db,
      actor,
      'court.update',
      { type: 'venue', id: venueId },
      { venue: venue.name, order: rows.map((r) => r.id) },
      { order: ids },
      at,
    ),
  ])
  return { result: await venueRow(db, venueId), purge: venuePurge() }
}

export async function deleteCourt(db: AppDb, actor: Editor, id: string, now = new Date()): Promise<Changed<VenueRow>> {
  const court = await loadCourt(db, id)
  const quoted = `%"${id}"%`
  const [m, s, t, seasonRefs, dayRefs] = (await runBatch(db, [
    db.select({ n: count() }).from(matches).where(eq(matches.courtId, id)),
    db.select({ n: count() }).from(programmeSessions).where(eq(programmeSessions.courtId, id)),
    db.select({ n: count() }).from(developmentTerms).where(eq(developmentTerms.courtId, id)),
    db.select({ name: seasons.name }).from(seasons).where(like(seasons.settings, quoted)).limit(5),
    db
      .select({ name: seasons.name })
      .from(matchDays)
      .innerJoin(seasons, eq(seasons.id, matchDays.seasonId))
      .where(or(like(matchDays.courtOverrides, quoted)))
      .limit(5),
  ])) as unknown as [{ n: number }[], { n: number }[], { n: number }[], { name: string }[], { name: string }[]]
  const uses = [
    m[0]?.n && `${m[0].n} match${m[0].n > 1 ? 'es' : ''}`,
    s[0]?.n && `${s[0].n} session${s[0].n > 1 ? 's' : ''}`,
    t[0]?.n && `${t[0].n} term${t[0].n > 1 ? 's' : ''}`,
    ...new Set([...seasonRefs, ...dayRefs].map((r) => `the ${r.name} draw`)),
  ].filter(Boolean)
  if (uses.length) throw conflict(`${court.name} is still used (${uses.join(', ')}), so it can't be deleted. Rename it instead.`)
  const at = now.toISOString()
  await runBatch(db, [
    db.delete(courts).where(eq(courts.id, id)),
    audit(db, actor, 'court.delete', { type: 'court', id }, { venueId: court.venueId, name: court.name }, null, at),
  ])
  return { result: await venueRow(db, court.venueId), purge: venuePurge() }
}
