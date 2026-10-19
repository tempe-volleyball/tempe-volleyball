import { and, asc, desc, eq, gte, isNull, lte, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { addDays } from '../lib/fixtures'
import { atLeast } from '../lib/roles'
import { sydneyDate } from '../lib/time'
import type { SourceStatus } from './analytics/fetch'
import { listAudit } from './auth/roles'
import { runBatch, type AppDb } from './db'
import { leagues, matchDays, matches, matchResults, pageRevisions, pages, posts, seasons, type UserRole } from './db/schema'
import { listTargets, type TargetSummary } from './enrolment/admin'
import { inboxSummary, type InboxSummary } from './contact/messages'
import { interestSummary, type InterestSummary } from './interest/admin'

// The admin home page (docs/admin.md §4): what needs attention today. One db.batch() of five small grouped reads,
// plus the enrolment targets (listTargets, admins and owners) and the latest audit entries (admins and owners), so
// about 20 D1 queries in all (two for the inbox summary, four for new expressions of interest). Nothing here writes.

/** How far back a played night with missing or unpublished results still shows. */
export const DASHBOARD_LOOKBACK_DAYS = 120

export type DashboardDay = {
  matchDayId: string
  seasonId: string
  seasonName: string
  leagueCode: string
  leagueName: string
  /** YYYY-MM-DD Sydney. */
  date: string
  matchDay: number
  kind: 'regular' | 'semi' | 'final' | 'skip'
  /** HH:MM of the first game, when the draw has times. */
  firstStart: string | null
  /** Games that need a result (not cancelled, postponed or TBD). */
  games: number
  /** Of those, games with a published result. */
  published: number
  /** Games whose saved draft differs from what's published (saved but not published yet). */
  unpublished: number
  resultsPublishedAt: string | null
}

export type SetupItem = { key: 'resend' | 'turnstile' | 'analytics' | 'payid'; ok: boolean; text: string; href: string }

export type Dashboard = {
  today: string
  /** Match days from today to six days ahead, in published seasons. */
  upcoming: DashboardDay[]
  /** Earlier match days that still need results entered or published, newest first. */
  needsResults: DashboardDay[]
  /** Admins and owners: open targets and anything with a waitlist, offers out or emails to confirm. */
  enrolment: TargetSummary[] | null
  content: {
    draftProgrammes: { id: string; name: string; code: string; kind: string }[]
    draftPages: { id: string; title: string; path: string }[]
    /** Pages never edited in the admin that have a newer saved version waiting (the content map's proposals). */
    pagesToReview: { id: string; title: string; path: string }[]
    draftPosts: { id: string; title: string }[]
  }
  /** Admins and owners. */
  recent: Awaited<ReturnType<typeof listAudit>> | null
  /** Admins and owners: the contact form's inbox (unread and open counts, the latest open messages). */
  messages: InboxSummary | null
  /** Admins and owners: new expressions of interest, per programme (docs/interest.md). */
  interest: InterestSummary | null
  /** Admins and owners: what isn't connected yet. Empty when everything is. */
  setup: SetupItem[]
}

export type DashboardEnv = {
  role: UserRole
  /** RESEND_API_KEY is set. */
  resend: boolean
  /** Turnstile keys: real, Cloudflare's test keys (development and staging), or none (production refuses forms). */
  turnstile: 'real' | 'test' | 'none'
  analytics: SourceStatus[]
  /** Settings → PayID has a PayID. */
  payid: boolean
}

const LIST_LIMIT = 20

export async function loadDashboard(db: AppDb, env: DashboardEnv, now = new Date()): Promise<Dashboard> {
  const today = sydneyDate(now)
  const weekEnd = addDays(today, 6)
  const since = addDays(today, -DASHBOARD_LOOKBACK_DAYS)
  const pub = alias(matchResults, 'pub')
  const drf = alias(matchResults, 'drf')
  const off = sql`${matches.status} in ('cancelled', 'postponed', 'tbd')`
  // A game whose draft and published results differ (either missing, or any stored value different).
  const differs = sql`(${drf.matchId} is null) <> (${pub.matchId} is null) or ${drf.homeSets} is not ${pub.homeSets} or ${drf.awaySets} is not ${pub.awaySets} or ${drf.homePoints} is not ${pub.homePoints} or ${drf.awayPoints} is not ${pub.awayPoints} or ${drf.setScores} is not ${pub.setScores} or ${drf.outcome} is not ${pub.outcome}`
  const admin = atLeast(env.role, 'admin')

  const [dayRows, progRows, pageRows, reviewRows, postRows] = (await runBatch(db, [
    db
      .select({
        matchDayId: sql<string>`${matchDays.id}`.as('md_id'),
        seasonId: sql<string>`${seasons.id}`.as('season_id'),
        seasonName: sql<string>`${seasons.name}`.as('season_name'),
        leagueCode: leagues.code,
        leagueName: sql<string>`${leagues.name}`.as('league_name'),
        date: matchDays.date,
        matchDay: matchDays.number,
        kind: matchDays.kind,
        resultsPublishedAt: matchDays.resultsPublishedAt,
        firstStart: sql<string | null>`min(${matches.startTime})`.as('first_start'),
        games: sql<number>`sum(case when ${off} then 0 else 1 end)`.as('games'),
        published: sql<number>`sum(case when ${off} or ${pub.matchId} is null then 0 else 1 end)`.as('published_n'),
        unpublished: sql<number>`sum(case when ${off} then 0 when ${differs} then 1 else 0 end)`.as('unpublished_n'),
      })
      .from(matchDays)
      .innerJoin(seasons, eq(seasons.id, matchDays.seasonId))
      .innerJoin(leagues, eq(leagues.id, seasons.leagueId))
      .innerJoin(matches, eq(matches.matchDayId, matchDays.id))
      .leftJoin(pub, and(eq(pub.matchId, matches.id), eq(pub.kind, 'published')))
      .leftJoin(drf, and(eq(drf.matchId, matches.id), eq(drf.kind, 'draft')))
      .where(
        and(
          eq(seasons.status, 'published'),
          eq(matchDays.status, 'scheduled'),
          ne(matchDays.kind, 'skip'),
          gte(matchDays.date, since),
          lte(matchDays.date, weekEnd),
        ),
      )
      .groupBy(matchDays.id)
      .orderBy(asc(matchDays.date), asc(leagues.sort), asc(leagues.code)),
    db
      .select({ id: leagues.id, name: leagues.name, code: leagues.code, kind: leagues.kind })
      .from(leagues)
      .where(eq(leagues.status, 'draft'))
      .orderBy(asc(leagues.kind), asc(leagues.sort), asc(leagues.name))
      .limit(LIST_LIMIT),
    db
      .select({ id: pages.id, title: pages.title, path: pages.path })
      .from(pages)
      .where(eq(pages.status, 'draft'))
      .orderBy(desc(pages.updatedAt))
      .limit(LIST_LIMIT),
    db
      .select({ id: pages.id, title: pages.title, path: pages.path })
      .from(pages)
      .innerJoin(pageRevisions, eq(pageRevisions.pageId, pages.id))
      .where(and(isNull(pages.updatedBy), ne(pages.status, 'archived')))
      .groupBy(pages.id)
      .having(sql`max(${pageRevisions.createdAt}) > ${pages.updatedAt}`)
      .orderBy(asc(pages.path))
      .limit(LIST_LIMIT),
    db
      .select({ id: posts.id, title: posts.title })
      .from(posts)
      .where(eq(posts.status, 'draft'))
      .orderBy(desc(posts.updatedAt))
      .limit(LIST_LIMIT),
  ])) as unknown as [
    (Omit<DashboardDay, 'games' | 'published' | 'unpublished'> & {
      games: number | null
      published: number | null
      unpublished: number | null
    })[],
    Dashboard['content']['draftProgrammes'],
    Dashboard['content']['draftPages'],
    Dashboard['content']['pagesToReview'],
    Dashboard['content']['draftPosts'],
  ]

  const days: DashboardDay[] = dayRows.map((d) => ({
    ...d,
    games: Number(d.games ?? 0),
    published: Number(d.published ?? 0),
    unpublished: Number(d.unpublished ?? 0),
  }))
  const upcoming = days.filter((d) => d.date >= today)
  const needsResults = days.filter((d) => d.date < today && (d.published < d.games || d.unpublished > 0)).toReversed()

  const [targets, audit, messages, interest] = await Promise.all([
    admin ? listTargets(db, {}, now) : Promise.resolve(null),
    admin ? listAudit(db, { limit: 8 }) : Promise.resolve(null),
    admin ? inboxSummary(db) : Promise.resolve(null),
    admin ? interestSummary(db, now) : Promise.resolve(null),
  ])
  const enrolment =
    targets?.filter(
      (t) => t.open || t.counts.waitlist + t.counts.teamsWaitlist + t.counts.offered + t.counts.pending + t.counts.teamsPending > 0,
    ) ?? null

  const setup: SetupItem[] = []
  if (admin) {
    setup.push(
      {
        key: 'resend',
        ok: env.resend,
        text: env.resend
          ? 'Email is sending through Resend.'
          : 'Email isn’t connected: sign-in codes, enrolment confirmations and waitlist offers are only logged. Set the RESEND_API_KEY secret.',
        href: '/settings',
      },
      {
        key: 'turnstile',
        ok: env.turnstile === 'real',
        text:
          env.turnstile === 'real'
            ? 'The enrolment form’s spam check (Turnstile) is set up.'
            : env.turnstile === 'test'
              ? 'The enrolment form uses Cloudflare’s test spam check here. Production needs the real TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.'
              : 'Online enrolment is off: the TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY secrets aren’t set.',
        href: '/enrolments',
      },
      {
        key: 'analytics',
        ok: env.analytics.every((s) => s.configured),
        text: env.analytics.every((s) => s.configured)
          ? 'Analytics sources are connected.'
          : `Not connected yet in Stats: ${env.analytics
              .filter((s) => !s.configured)
              .map((s) => SOURCE_NAMES[s.source] ?? s.source)
              .join(', ')}.`,
        href: '/stats',
      },
      {
        key: 'payid',
        ok: env.payid,
        text: env.payid ? 'PayID details are set.' : 'No PayID in Settings yet, so enrolment emails can’t say how to pay.',
        href: '/settings#settings-payid',
      },
    )
  }

  return {
    today,
    upcoming,
    needsResults,
    enrolment,
    content: { draftProgrammes: progRows, draftPages: pageRows, pagesToReview: reviewRows, draftPosts: postRows },
    recent: audit,
    messages,
    interest,
    setup: setup.filter((s) => !s.ok),
  }
}

const SOURCE_NAMES: Record<string, string> = { ga4: 'Google Analytics', search_console: 'Search Console', cloudflare: 'Cloudflare' }
