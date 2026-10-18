import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import { metaDescription } from '../../lib/content'
import { nextStartsLine, scheduleText, summaryLine, venueText } from '../../lib/programme-text'
import { categoryPath, isListedStatus, isPublicStatus, programmePath } from '../../lib/programmes'
import { sydneyDate } from '../../lib/time'
import { tags } from '../cache'
import { runBatch, type AppDb } from '../db'
import {
  categories,
  developmentTerms,
  events,
  programmes,
  programmeSessions,
  venues,
  type Category,
  type Programme,
  type ProgrammeKind,
  type Venue,
} from '../db/schema'
import type { TargetSummary } from '../enrolment/admin'
import { listOpenEnrolments, loadEnrolmentForm, type EnrolmentFormProps, type PublicTarget } from '../enrolment/public'
import { nextInstanceMap, nextInstanceQueries } from './programmes'

// What the public category, programme and /enrol pages show (docs/admin.md §3.2, §3.3, §3.6). Reads only; every
// loader is a fixed handful of D1 queries in one or two batches, whatever the number of programmes. The text comes
// from src/lib/programme-text.ts, so a hand-written summary line or "next starts" text wins everywhere.

/** A programme as listed on category pages and /enrol (active programmes only). */
export type ProgrammeCard = {
  id: string
  kind: ProgrammeKind
  name: string
  code: string
  path: string
  categoryId: string | null
  /** Hand-written summary line, else the generated one. */
  summary: string
  /** The summary is hand-written (so it may not say when and where; the card then lists them). */
  summaryCustom: boolean
  /** "Thursdays 8–10pm". */
  schedule: string
  /** "Robyn Webster Sports Centre, Tempe", or ''. */
  venue: string
  /** "Next season starts Thursday 15 January 2027", or ''. */
  nextStarts: string
  /** Something can be enrolled in right now (programme switch and window, and at least one open target). */
  enrolmentOpen: boolean
  /** The open targets, soonest first. */
  targets: CardTarget[]
}

export type CardTarget = {
  label: string
  startsOn: string | null
  /** spotsText(): "12 spots left", "Waitlist only", "Full" or '' (no cap). */
  spots: string
  /** For the spots-left meter: open, only the waitlist, or full (no waitlist). */
  state: 'open' | 'waitlist' | 'full'
  /** How many places are left of how many (team places when teams are capped, else players); null with no cap. */
  meter: { left: number; cap: number } | null
}

/** The spots-left meter's numbers and state for a target (the same rules as spotsText). */
export function spotsMeter(
  t: Pick<TargetSummary, 'caps' | 'counts'> & { waitlistEnabled?: boolean },
  waitlist = t.waitlistEnabled ?? true,
): Pick<CardTarget, 'state' | 'meter'> {
  const players = t.caps.players === null ? null : Math.max(0, t.caps.players - t.counts.players)
  const teams = t.caps.teams === null ? null : Math.max(0, t.caps.teams - t.counts.teams)
  const waiting = t.counts.waitlist > 0 || t.counts.teamsWaitlist > 0
  const state = players === 0 || teams === 0 || waiting ? (waitlist ? 'waitlist' : 'full') : 'open'
  const meter =
    teams !== null && t.caps.teams
      ? { left: state === 'open' ? teams : 0, cap: t.caps.teams }
      : players !== null && t.caps.players
        ? { left: state === 'open' ? players : 0, cap: t.caps.players }
        : null
  return { state, meter }
}

/**
 * "12 spots left", "3 team spots left", "Waitlist only", "Full" or '' (no cap), from a target's caps and live counts.
 * Players win over teams when both are capped and players are the tighter limit.
 */
export function spotsText(
  t: Pick<TargetSummary, 'caps' | 'counts'> & { waitlistEnabled?: boolean },
  waitlist = t.waitlistEnabled ?? true,
): string {
  const players = t.caps.players === null ? null : Math.max(0, t.caps.players - t.counts.players)
  const teams = t.caps.teams === null ? null : Math.max(0, t.caps.teams - t.counts.teams)
  const waiting = t.counts.waitlist > 0 || t.counts.teamsWaitlist > 0
  if (players === 0 || teams === 0 || waiting) return waitlist ? 'Waitlist only' : 'Full'
  const parts: string[] = []
  if (teams !== null) parts.push(`${teams} team ${teams === 1 ? 'spot' : 'spots'} left`)
  if (players !== null) parts.push(`${players} ${players === 1 ? 'spot' : 'spots'} left`)
  return parts.join(', ')
}

/** The same for one target of the enrolment form's props (PublicTarget): "Full", "Waitlist only", "8 spots left" or "Open". */
export function publicTargetSpots(t: Pick<PublicTarget, 'full' | 'waitlistOnly' | 'spotsLeft' | 'teamSpotsLeft'>): string {
  if (t.full) return 'Full'
  if (t.waitlistOnly) return 'Waitlist only'
  const parts: string[] = []
  if (t.teamSpotsLeft !== null) parts.push(`${t.teamSpotsLeft} team ${t.teamSpotsLeft === 1 ? 'spot' : 'spots'} left`)
  if (t.spotsLeft !== null) parts.push(`${t.spotsLeft} ${t.spotsLeft === 1 ? 'spot' : 'spots'} left`)
  return parts.join(', ') || 'Open'
}

type VenueLike = Pick<Venue, 'id' | 'name' | 'address'>

export function programmeCard(
  p: Programme,
  venueById: Map<string, VenueLike>,
  nextDate: string | null,
  open: { targets: TargetSummary[] } | undefined,
): ProgrammeCard {
  const venue = (p.defaultVenueId && venueById.get(p.defaultVenueId)) || null
  return {
    id: p.id,
    kind: p.kind,
    name: p.name,
    code: p.code,
    path: programmePath(p.kind, p.slug),
    categoryId: p.categoryId,
    summary: summaryLine(p, venue),
    summaryCustom: !!p.summaryLine?.trim(),
    schedule: scheduleText(p),
    venue: venueText(venue),
    nextStarts: nextStartsLine(p, nextDate),
    enrolmentOpen: !!open && open.targets.length > 0,
    targets: (open?.targets ?? []).map((t) => ({
      label: t.label,
      startsOn: t.startsOn,
      spots: spotsText(t, t.waitlistEnabled),
      ...spotsMeter(t, t.waitlistEnabled),
    })),
  }
}

export type Listings = {
  /** Every category that isn't a draft, in menu order. */
  categories: Category[]
  /** Active programmes, in their sort order. */
  programmes: ProgrammeCard[]
}

/** Every active programme as a card, with its category and live enrolment status. Two parallel round trips. */
export async function loadListings(db: AppDb, now = new Date()): Promise<Listings> {
  const today = sydneyDate(now)
  const [batch, open] = await Promise.all([
    runBatch(db, [
      db.select().from(categories).where(ne(categories.status, 'draft')).orderBy(asc(categories.sort), asc(categories.name)),
      db.select().from(programmes).where(eq(programmes.status, 'active')).orderBy(asc(programmes.sort), asc(programmes.name)),
      db.select({ id: venues.id, name: venues.name, address: venues.address }).from(venues),
      ...nextInstanceQueries(db, today),
    ]),
    listOpenEnrolments(db, now),
  ])
  const [cats, progs, vens, ...dates] = batch as unknown as [
    Category[],
    Programme[],
    VenueLike[],
    ...{ programmeId: string; date: string | null }[][],
  ]
  const next = nextInstanceMap(dates)
  const venueById = new Map(vens.map((v) => [v.id, v]))
  const openById = new Map(open.map((o) => [o.programme.id, o]))
  return {
    categories: cats,
    programmes: progs.map((p) => programmeCard(p, venueById, next.get(p.id) ?? null, openById.get(p.id))),
  }
}

/** Groups cards by category in category order; cards without a (public) category come last under `null`. */
export function groupByCategory(listings: Listings, cards: ProgrammeCard[] = listings.programmes) {
  const groups = listings.categories
    .map((category) => ({ category: category as Category | null, cards: cards.filter((c) => c.categoryId === category.id) }))
    .filter((g) => g.cards.length > 0)
  const known = new Set(listings.categories.map((c) => c.id))
  const rest = cards.filter((c) => !c.categoryId || !known.has(c.categoryId))
  if (rest.length) groups.push({ category: null, cards: rest })
  return groups
}

export type CategoryPage = { category: Category; cards: ProgrammeCard[]; listings: Listings }

/** A category landing page (/<slug>): the category, unless it's a draft, and its active programmes. */
export async function loadCategoryPage(db: AppDb, slug: string, now = new Date()): Promise<CategoryPage | null> {
  // One cheap query first: most one-segment paths that reach here are 404s and old URLs, not categories.
  const exists = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.slug, slug), ne(categories.status, 'draft')))
    .get()
  if (!exists) return null
  const listings = await loadListings(db, now)
  const category = listings.categories.find((c) => c.slug === slug)
  if (!category) return null
  return { category, cards: listings.programmes.filter((c) => c.categoryId === category.id), listings }
}

/** The cache tags of a category page: its own, every programme listing, and venue details. */
export const categoryPageTags = (slug: string) => [tags.category(slug), tags.programmes, tags.venues, tags.page(categoryPath(slug))]

// ── Programme pages ───────────────────────────────────────────────────────────

/** One dated thing a programme runs, as its page lists it: a training session, a development term or an event. */
export type ProgrammeInstance = {
  kind: 'session' | 'term' | 'event'
  id: string
  /** "Term 4 2026", "Tempe Cup 2026", a session's title, or ''. */
  title: string
  startDate: string
  endDate: string | null
  startTime: string | null
  endTime: string | null
  /** Null weekday = the programme's (terms only). */
  weekday: number | null
  venueId: string | null
  ageGroup: string | null
  status: 'scheduled' | 'postponed' | 'cancelled'
  note: string | null
  /** The date it was first planned for, once it has moved. */
  movedFrom: string | null
}

export type ProgrammePageData = {
  programme: Programme
  path: string
  category: Pick<Category, 'id' | 'name' | 'slug' | 'status'> | null
  /** Upcoming sessions, terms or events (not leagues: their seasons come from the site loader), soonest first. */
  upcoming: ProgrammeInstance[]
  /** The latest past ones, newest first (the archive on a retired programme's page). */
  past: ProgrammeInstance[]
  /** The next season/session/term/event start, for "Next … starts". */
  nextInstanceDate: string | null
  /** The enrolment form's props, when something is open now. */
  enrolment: EnrolmentFormProps | null
}

export type ProgrammeLookup = { found: ProgrammePageData } | { redirect: string } | null

const UPCOMING_LIMIT = 60
const PAST_LIMIT = 12

const bySlug = (db: AppDb, slug: string) => db.select({ id: programmes.id }).from(programmes).where(eq(programmes.slug, slug))

function instanceQueries(db: AppDb, kind: ProgrammeKind, slug: string, today: string) {
  const ids = bySlug(db, slug)
  if (kind === 'training') {
    const base = and(inArray(programmeSessions.programmeId, ids), isNull(programmeSessions.termId))
    const cols = {
      id: programmeSessions.id,
      title: programmeSessions.title,
      date: programmeSessions.date,
      startTime: programmeSessions.startTime,
      endTime: programmeSessions.endTime,
      venueId: programmeSessions.venueId,
      status: programmeSessions.status,
      note: programmeSessions.note,
      originalDate: programmeSessions.originalDate,
    }
    return [
      db
        .select(cols)
        .from(programmeSessions)
        .where(and(base, gte(programmeSessions.date, today)))
        .orderBy(asc(programmeSessions.date), asc(programmeSessions.startTime))
        .limit(UPCOMING_LIMIT),
      db
        .select(cols)
        .from(programmeSessions)
        .where(and(base, lt(programmeSessions.date, today)))
        .orderBy(desc(programmeSessions.date))
        .limit(PAST_LIMIT),
    ] as const
  }
  if (kind === 'development') {
    const ends = sql<string>`coalesce(${developmentTerms.endDate}, ${developmentTerms.startDate})`
    const base = inArray(developmentTerms.programmeId, ids)
    return [
      db
        .select()
        .from(developmentTerms)
        .where(and(base, gte(ends, today)))
        .orderBy(asc(developmentTerms.startDate), asc(developmentTerms.sort))
        .limit(UPCOMING_LIMIT),
      db
        .select()
        .from(developmentTerms)
        .where(and(base, lt(ends, today)))
        .orderBy(desc(developmentTerms.startDate))
        .limit(PAST_LIMIT),
    ] as const
  }
  const ends = sql<string>`coalesce(${events.endDate}, ${events.startDate})`
  const base = inArray(events.programmeId, ids)
  return [
    db
      .select()
      .from(events)
      .where(and(base, gte(ends, today)))
      .orderBy(asc(events.startDate))
      .limit(UPCOMING_LIMIT),
    db
      .select()
      .from(events)
      .where(and(base, lt(ends, today)))
      .orderBy(desc(events.startDate))
      .limit(PAST_LIMIT),
  ] as const
}

type SessionRow = {
  id: string
  title: string | null
  date: string
  startTime: string | null
  endTime: string | null
  venueId: string | null
  status: ProgrammeInstance['status']
  note: string | null
  originalDate: string | null
}
type TermRow = typeof developmentTerms.$inferSelect
type EventRow = typeof events.$inferSelect

const moved = (original: string | null, now: string) => (original && original !== now ? original : null)

/** Rows of whichever table `kind` reads, as ProgrammeInstance. */
export function toInstances(kind: ProgrammeKind, rows: unknown[]): ProgrammeInstance[] {
  if (kind === 'training')
    return (rows as SessionRow[]).map((r) => ({
      kind: 'session',
      id: r.id,
      title: r.title ?? '',
      startDate: r.date,
      endDate: null,
      startTime: r.startTime,
      endTime: r.endTime,
      weekday: null,
      venueId: r.venueId,
      ageGroup: null,
      status: r.status,
      note: r.note,
      movedFrom: moved(r.originalDate, r.date),
    }))
  if (kind === 'development')
    return (rows as TermRow[]).map((r) => ({
      kind: 'term',
      id: r.id,
      title: r.name,
      startDate: r.startDate,
      endDate: r.endDate,
      startTime: r.startTime,
      endTime: r.endTime,
      weekday: r.weekday,
      venueId: r.venueId,
      ageGroup: r.ageGroup,
      status: r.status,
      note: r.note,
      movedFrom: null,
    }))
  if (kind === 'event')
    return (rows as EventRow[]).map((r) => ({
      kind: 'event',
      id: r.id,
      title: r.name,
      startDate: r.startDate,
      endDate: r.endDate,
      startTime: r.startTime,
      endTime: r.endTime,
      weekday: null,
      venueId: r.venueId,
      ageGroup: null,
      status: r.status,
      note: r.note,
      movedFrom: moved(r.originalStartDate, r.startDate),
    }))
  return []
}

/**
 * A programme's public page data, by the kind its URL says and its slug:
 *  - null when there's no such programme or it's a draft (the route then tries the redirects table, else 404s);
 *  - { redirect } when the slug belongs to a programme of another kind (/training/tnl -> /leagues/tnl);
 *  - { found } otherwise, retired programmes included (their page stays up with the archive).
 * One batch (about eight queries), plus the enrolment form's (about ten) only while enrolment is switched on.
 */
export async function loadProgrammePage(
  db: AppDb,
  kind: ProgrammeKind,
  slug: string,
  opts: { turnstileSiteKey: string | null; now?: Date },
): Promise<ProgrammeLookup> {
  const now = opts.now ?? new Date()
  const today = sydneyDate(now)
  const instances = kind === 'league' ? [] : instanceQueries(db, kind, slug, today)
  // No joins: D1 returns batch rows as objects, so two tables' same-named columns (slug, name) would collide.
  const res = (await runBatch(db, [
    db.select().from(programmes).where(eq(programmes.slug, slug)).limit(1),
    db
      .select({ id: categories.id, name: categories.name, slug: categories.slug, status: categories.status })
      .from(categories)
      .where(inArray(categories.id, db.select({ id: programmes.categoryId }).from(programmes).where(eq(programmes.slug, slug)))),
    ...instances,
    ...nextInstanceQueries(db, today),
  ])) as unknown as [Programme[], NonNullable<ProgrammePageData['category']>[], ...unknown[][]]
  const [rows, cats, ...rest] = res
  const p = rows[0]
  if (!p || !isPublicStatus(p.status)) return null
  if (p.kind !== kind) return { redirect: programmePath(p.kind, p.slug) }
  const category = cats[0] && cats[0].status !== 'draft' ? cats[0] : null
  const [upcomingRows = [], pastRows = []] = kind === 'league' ? [] : rest.slice(0, 2)
  const next = nextInstanceMap(rest.slice(instances.length) as { programmeId: string; date: string | null }[][])
  const enrolment = isListedStatus(p.status) && p.enrolmentOpen ? await loadEnrolmentForm(db, p.id, opts.turnstileSiteKey, now) : null
  return {
    found: {
      programme: p,
      path: programmePath(p.kind, p.slug),
      category,
      upcoming: toInstances(kind, upcomingRows),
      past: toInstances(kind, pastRows),
      nextInstanceDate: next.get(p.id) ?? null,
      enrolment,
    },
  }
}

/** The <title> text and meta description of a programme page: the SEO fields when Michael set them, else generated. */
export function programmeSeo(
  p: Pick<Programme, 'kind' | 'name' | 'seoTitle' | 'seoDescription' | 'description'>,
  summary: string,
  nextStarts: string,
  /** Leagues: whether any season is public (current or archived). Without one there's no ladder to promise. */
  { hasSeasons = true }: { hasSeasons?: boolean } = {},
) {
  const title = p.seoTitle?.trim() || (p.kind === 'league' && hasSeasons ? `${p.name} Ladder, Fixtures and Results` : p.name)
  const generated = [summary, nextStarts].filter(Boolean).join('. ')
  return {
    title,
    description: metaDescription(p.seoDescription?.trim() || generated, { bodyHtml: p.description?.html ?? '' }),
  }
}

/** Cache tags for a programme page: its own (and the league's), its category (breadcrumb), venues and its path. */
export const programmePageTags = (p: Pick<Programme, 'kind' | 'slug'>, categorySlug: string | null) => [
  tags.programme(p.slug),
  ...(p.kind === 'league' ? [tags.league(p.slug)] : []),
  ...(categorySlug ? [tags.category(categorySlug)] : []),
  tags.venues,
  tags.page(programmePath(p.kind, p.slug)),
]
