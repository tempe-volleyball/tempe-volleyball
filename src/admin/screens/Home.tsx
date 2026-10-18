import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link } from 'wouter'
import { formatLong } from '../../lib/fixtures'
import { api, formatWhen, type AuditRow, type Dashboard, type DashboardDay, type Me } from '../api'
import { capText } from '../enrolment/EnrolmentList'
import { KINDS } from '../programmes/kinds'
import { Card, LoadError, Skeleton, errorMessage } from '../ui'
import { ACTIONS, describe } from './Audit'

// The admin home: what needs attention, from GET /api/admin/dashboard (one call, a few batched queries). Tonight's
// and this week's games with a link straight to entering results, earlier nights still to enter or publish,
// enrolment needing a look, drafts to review, setup still needed and recent activity. Each list links to where the
// work is done.

const time12 = (hhmm: string | null) => {
  if (!hhmm) return ''
  const [h = 0, m = 0] = hhmm.split(':').map(Number)
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`
}

const resultsHref = (d: DashboardDay) => `/seasons/${d.seasonId}/results#results-${d.matchDayId}`

function Section({ title, count, children, action }: { title: string; count?: number; children: ReactNode; action?: ReactNode }) {
  return (
    <Card
      title={count === undefined ? title : `${title} (${count})`}
      actions={action ? <span className="text-sm">{action}</span> : undefined}
    >
      {children}
    </Card>
  )
}

const rowClass = 'flex flex-wrap items-center gap-x-3 gap-y-1 py-3 first:pt-0 last:pb-0'
const linkClass = 'text-brand font-semibold underline underline-offset-2'

function DayRow({ d, today }: { d: DashboardDay; today: string }) {
  const tonight = d.date === today
  const past = d.date < today
  const left = d.games - d.published
  return (
    <li className={rowClass}>
      <div className="min-w-0 flex-1">
        <p className="font-semibold">
          {d.seasonName} · Match day {d.matchDay}
          {d.kind !== 'regular' && (
            <span className="bg-accent ml-2 rounded px-1.5 py-0.5 text-xs">{d.kind === 'semi' ? 'Semis' : 'Finals'}</span>
          )}
        </p>
        <p className="text-sm text-black/70">
          {tonight ? 'Tonight' : formatLong(d.date)}
          {d.firstStart && !past ? `, from ${time12(d.firstStart)}` : ''} · {d.games} {d.games === 1 ? 'game' : 'games'}
          {past && left > 0 && ` · ${left} without a published result`}
          {d.unpublished > 0 && ` · ${d.unpublished} saved, not published`}
        </p>
      </div>
      <span className="flex gap-2">
        {(tonight || past) && (
          <Link
            href={resultsHref(d)}
            className={`rounded px-4 py-2.5 text-sm font-semibold ${tonight ? 'bg-brand text-white' : 'border-brand text-brand border bg-white'}`}
          >
            {d.unpublished > 0 && left === 0 ? 'Publish results' : 'Enter results'}
          </Link>
        )}
        {!past && (
          <Link
            href={`/matches?from=${d.date}&to=${d.date}`}
            className="border-brand text-brand rounded border bg-white px-4 py-2.5 text-sm font-semibold"
          >
            Games
          </Link>
        )}
      </span>
    </li>
  )
}

function Chip({ children, tone = 'grey' }: { children: ReactNode; tone?: 'grey' | 'amber' | 'red' }) {
  const cls = { grey: 'bg-black/5 text-black/70', amber: 'bg-accent/30 text-ink', red: 'bg-red-100 text-red-900' }[tone]
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>
}

export default function Home({ me }: { me: Me }) {
  const [data, setData] = useState<Dashboard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fetchData = useCallback(
    () =>
      api<Dashboard>('/api/admin/dashboard')
        .then((d) => {
          setData(d)
          setError(null)
        })
        .catch((e: unknown) => setError(errorMessage(e))),
    [],
  )
  useEffect(() => {
    void fetchData()
  }, [fetchData])
  const load = () => {
    setError(null)
    void fetchData()
  }

  const name = me.user.name && me.user.name !== me.user.email.split('@')[0] ? me.user.name.split(' ')[0] : ''

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">{name ? `Hello, ${name}` : 'Admin home'}</h1>
        <p className="text-sm text-black/70">
          {data ? `${formatLong(data.today)}. ` : ''}
          What needs doing, with a link to where it’s done.
        </p>
      </div>
      {!me.user.twoFactorEnabled && (
        <Card>
          <p className="text-sm">
            Set up an authenticator app under{' '}
            <Link href="/security" className={linkClass}>
              Security
            </Link>{' '}
            so nobody can sign in as you with just access to your email.
          </p>
        </Card>
      )}
      {error && <LoadError message={error} onRetry={load} />}
      {!data && !error && (
        <Card>
          <Skeleton lines={5} label="Loading what needs attention…" />
        </Card>
      )}
      {data && <Panels data={data} me={me} />}
    </div>
  )
}

function Panels({ data, me }: { data: Dashboard; me: Me }) {
  const { today } = data
  const tonight = data.upcoming.filter((d) => d.date === today)
  const later = data.upcoming.filter((d) => d.date > today)
  const c = data.content
  const reviewCount = c.draftProgrammes.length + c.pagesToReview.length + c.draftPages.length + c.draftPosts.length
  const enrolment = data.enrolment ?? []

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <Section
          title={tonight.length ? 'Tonight' : 'This week'}
          action={
            <Link href="/matches" className={linkClass}>
              All games
            </Link>
          }
        >
          {data.upcoming.length === 0 ? (
            <p className="text-sm text-black/70">No games in the next seven days in any published season.</p>
          ) : (
            <ul className="divide-y divide-black/10">
              {[...tonight, ...later].map((d) => (
                <DayRow key={d.matchDayId} d={d} today={today} />
              ))}
            </ul>
          )}
        </Section>

        <Section title="Results to enter or publish" count={data.needsResults.length}>
          {data.needsResults.length === 0 ? (
            <p className="text-sm text-black/70">Every night that’s been played has its results published.</p>
          ) : (
            <ul className="divide-y divide-black/10">
              {data.needsResults.map((d) => (
                <DayRow key={d.matchDayId} d={d} today={today} />
              ))}
            </ul>
          )}
        </Section>

        {data.enrolment && (
          <Section
            title="Enrolment"
            count={enrolment.length}
            action={
              <Link href="/enrolments" className={linkClass}>
                All enrolments
              </Link>
            }
          >
            {enrolment.length === 0 ? (
              <p className="text-sm text-black/70">Nothing is open for enrolment, and nobody is waiting on a spot.</p>
            ) : (
              <ul className="divide-y divide-black/10">
                {enrolment.map((t) => {
                  const full = t.caps.players !== null && t.counts.players >= t.caps.players
                  return (
                    <li key={`${t.ref.kind}:${t.ref.id}`} className={rowClass}>
                      <Link href={`/enrolments/${t.ref.kind}/${t.ref.id}`} className="min-w-0 flex-1">
                        <span className="text-brand block font-semibold underline-offset-2 hover:underline">{t.label}</span>
                        <span className="block text-sm text-black/70">
                          {t.programme.code} · {capText(t.counts.players, t.caps.players)} players
                          {t.caps.teams !== null || t.counts.teams > 0 ? ` · ${capText(t.counts.teams, t.caps.teams)} teams` : ''}
                        </span>
                      </Link>
                      <span className="flex flex-wrap gap-1.5">
                        {t.open ? <Chip>{full ? 'Open, full' : 'Open'}</Chip> : <Chip>Closed</Chip>}
                        {t.counts.offered > 0 && <Chip tone="amber">{t.counts.offered} offer out</Chip>}
                        {t.counts.waitlist + t.counts.teamsWaitlist > 0 && (
                          <Chip tone="amber">{t.counts.waitlist + t.counts.teamsWaitlist} waitlisted</Chip>
                        )}
                        {t.counts.pending + t.counts.teamsPending > 0 && (
                          <Chip tone="amber">{t.counts.pending + t.counts.teamsPending} awaiting email</Chip>
                        )}
                        {t.counts.unpaid > 0 && <Chip tone="red">{t.counts.unpaid} unpaid</Chip>}
                      </span>
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>
        )}
      </div>

      <div className="space-y-5">
        {data.setup.length > 0 && (
          <Section title="Setup still needed" count={data.setup.length}>
            <ul className="space-y-2 text-sm">
              {data.setup.map((s) => (
                <li key={s.key} className="flex gap-2">
                  <span aria-hidden="true" className="text-accent font-bold">
                    !
                  </span>
                  <span>
                    {s.text}{' '}
                    <Link href={s.href} className={linkClass}>
                      Open
                    </Link>
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-black/60">
              Secrets are set in the Cloudflare account by whoever looks after it (PLAN.md, “Setup needed”).
            </p>
          </Section>
        )}

        {data.messages && (
          <Section
            title="Messages"
            count={data.messages.unread > 0 ? data.messages.unread : undefined}
            action={
              <Link href="/messages" className={linkClass}>
                All messages
              </Link>
            }
          >
            {data.messages.openCount === 0 ? (
              <p className="text-sm text-black/70">No open messages from the contact form.</p>
            ) : (
              <>
                <p className="mb-2 text-sm text-black/70">
                  {data.messages.unread} unread, {data.messages.openCount} not handled yet.
                </p>
                <ul className="divide-y divide-black/10">
                  {data.messages.open.map((m) => (
                    <li key={m.id} className={rowClass}>
                      <Link href={`/messages/${m.id}`} className="min-w-0 flex-1">
                        <span className={`text-brand block underline-offset-2 hover:underline ${m.status === 'new' ? 'font-bold' : 'font-semibold'}`}>
                          {m.name}
                          {m.topic ? ` · ${m.topic}` : ''}
                        </span>
                        <span className="block text-sm text-black/70">{formatWhen(m.createdAt)}</span>
                      </Link>
                      {m.status === 'new' && <Chip tone="amber">Unread</Chip>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>
        )}

        <Section title="Drafts to review" count={reviewCount}>
          {reviewCount === 0 ? (
            <p className="text-sm text-black/70">No draft programmes, pages or posts.</p>
          ) : (
            <div className="space-y-4 text-sm">
              {c.draftProgrammes.length > 0 && (
                <DraftList
                  title="Programmes not live yet"
                  hint="Check each one, add its dates, then set it Active."
                  items={c.draftProgrammes.map((p) => ({
                    key: p.id,
                    href: `${KINDS[p.kind as keyof typeof KINDS]?.base ?? '/leagues'}/${p.id}`,
                    label: p.name.includes(`(${p.code})`) ? p.name : `${p.name} (${p.code})`,
                  }))}
                />
              )}
              {c.pagesToReview.length > 0 && (
                <DraftList
                  title="Pages with a new version to review"
                  hint="Open the page’s revisions to compare, then restore or edit it."
                  items={c.pagesToReview.map((p) => ({ key: p.id, href: `/pages/${p.id}`, label: `${p.title} (${p.path})` }))}
                />
              )}
              {c.draftPages.length > 0 && (
                <DraftList
                  title="Draft pages"
                  items={c.draftPages.map((p) => ({ key: p.id, href: `/pages/${p.id}`, label: `${p.title} (${p.path})` }))}
                />
              )}
              {c.draftPosts.length > 0 && (
                <DraftList
                  title="Draft news posts"
                  items={c.draftPosts.map((p) => ({ key: p.id, href: `/news/${p.id}`, label: p.title }))}
                />
              )}
            </div>
          )}
        </Section>

        {data.recent && me.canManageUsers && (
          <Section
            title="Recent activity"
            action={
              <Link href="/audit" className={linkClass}>
                Audit log
              </Link>
            }
          >
            {data.recent.length === 0 ? (
              <p className="text-sm text-black/70">Nothing yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {data.recent.map((r) => (
                  <li key={r.id}>
                    <span className="font-semibold">{ACTIONS[r.action] ?? r.action}</span>{' '}
                    <span className="text-black/80">{describe(r as AuditRow)}</span>
                    <span className="block text-xs text-black/60">
                      {formatWhen(r.at)} · {r.actorEmail ?? 'the system'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>
    </div>
  )
}

function DraftList({ title, hint, items }: { title: string; hint?: string; items: { key: string; href: string; label: string }[] }) {
  return (
    <div>
      <h3 className="font-semibold">{title}</h3>
      {hint && <p className="text-xs text-black/60">{hint}</p>}
      <ul className="mt-1 space-y-1">
        {items.map((i) => (
          <li key={i.key}>
            <Link href={i.href} className="text-brand -my-1 inline-block py-1 underline underline-offset-2">
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
