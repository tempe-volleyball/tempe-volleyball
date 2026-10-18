import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, Redirect, Route, Router, Switch, useLocation } from 'wouter'
import { api, type Me } from './api'
import { authClient } from './auth-client'
import { aroundNav } from './leave-guard'
import { bottomBar, isCurrent, navFor, navItemFor, HOME, type NavItem } from './nav'
import { SignIn } from './screens/SignIn'
import { AcceptInvite } from './screens/AcceptInvite'
import { ConfirmHost, RoleBadge, Skeleton, Toaster } from './ui'
import { LeaveHost } from './unsaved'

// The admin app: one React island at /admin/* with a client-side router (wouter, base /admin). The server renders
// the same shell for every /admin path and has already checked the session (src/middleware.ts), so `me` is the
// signed-in user, or null on the public sign-in and invite pages.
//
// Each section is its own chunk, loaded when first opened, so the results screen on a phone at the venue doesn't
// download the page editor, the charts or the draw generator first (docs/admin.md §4).

const Home = lazy(() => import('./screens/Home'))
const Stats = lazy(() => import('./screens/Stats'))
const Audit = lazy(() => import('./screens/Audit').then((m) => ({ default: m.Audit })))
const Matches = lazy(() => import('./screens/Matches').then((m) => ({ default: m.Matches })))
const Messages = lazy(() => import('./screens/Messages').then((m) => ({ default: m.Messages })))
const MessagePage = lazy(() => import('./screens/Messages').then((m) => ({ default: m.MessagePage })))
const Media = lazy(() => import('./screens/Media').then((m) => ({ default: m.Media })))
const Menu = lazy(() => import('./screens/Menu').then((m) => ({ default: m.Menu })))
const PageEditor = lazy(() => import('./screens/Pages').then((m) => ({ default: m.PageEditor })))
const PageList = lazy(() => import('./screens/Pages').then((m) => ({ default: m.PageList })))
const PostEditor = lazy(() => import('./screens/Posts').then((m) => ({ default: m.PostEditor })))
const PostList = lazy(() => import('./screens/Posts').then((m) => ({ default: m.PostList })))
const Security = lazy(() => import('./screens/Security').then((m) => ({ default: m.Security })))
const Settings = lazy(() => import('./screens/Settings').then((m) => ({ default: m.Settings })))
const Teams = lazy(() => import('./screens/Teams').then((m) => ({ default: m.Teams })))
const Users = lazy(() => import('./screens/Users').then((m) => ({ default: m.Users })))
const Categories = lazy(() => import('./programmes/Categories').then((m) => ({ default: m.Categories })))
const ProgrammeList = lazy(() => import('./programmes/ProgrammeList').then((m) => ({ default: m.ProgrammeList })))
const ProgrammePage = lazy(() => import('./programmes/ProgrammePage').then((m) => ({ default: m.ProgrammePage })))
const Venues = lazy(() => import('./programmes/Venues').then((m) => ({ default: m.Venues })))
const EnrolmentList = lazy(() => import('./enrolment/EnrolmentList').then((m) => ({ default: m.EnrolmentList })))
const FormEditor = lazy(() => import('./enrolment/Forms').then((m) => ({ default: m.FormEditor })))
const FormList = lazy(() => import('./enrolment/Forms').then((m) => ({ default: m.FormList })))
const TargetPage = lazy(() => import('./enrolment/TargetPage').then((m) => ({ default: m.TargetPage })))
const SeasonList = lazy(() => import('./seasons/SeasonList').then((m) => ({ default: m.SeasonList })))
const SeasonPage = lazy(() => import('./seasons/SeasonPage').then((m) => ({ default: m.SeasonPage })))

// ── Icons (inline, decorative) ────────────────────────────────────────────────

const ICONS: Record<string, string> = {
  '/': 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  '/matches': 'M4 5h16v15H4zM4 9h16M8 3v4m8-4v4',
  '/leagues': 'M7 4h10v4a5 5 0 0 1-10 0zM5 5H3a3 3 0 0 0 4 4m12-4h2a3 3 0 0 1-4 4M12 13v4m-4 3h8',
  '/enrolments': 'M9 4h6v3H9zM6 5h3m6 0h3v16H6zm3 8 2 2 4-4',
  '/pages': 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7m-7 4h7',
  more: 'M4 7h16M4 12h16M4 17h16',
}

function Icon({ name }: { name: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-6 w-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
    >
      <path d={ICONS[name] ?? ICONS.more} />
    </svg>
  )
}

// ── Navigation ───────────────────────────────────────────────────────────────

/**
 * Unread contact messages, for the Messages badge (admins and owners): fetched when the admin opens, when the tab
 * comes back into view, every five minutes, and when the Messages screen changes something ('tvb:messages-changed').
 */
function useUnreadMessages(me: Me) {
  const [unread, setUnread] = useState(0)
  const allowed = me.user.role !== 'editor' && !me.totpRequired
  useEffect(() => {
    if (!allowed) return
    let live = true
    const refresh = () =>
      api<{ unread: number }>('/api/admin/messages/unread').then(
        (r) => live && setUnread(r.unread),
        () => undefined,
      )
    void refresh()
    const onVisible = () => document.visibilityState === 'visible' && void refresh()
    const timer = setInterval(() => document.visibilityState === 'visible' && void refresh(), 5 * 60_000)
    window.addEventListener('tvb:messages-changed', refresh)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      clearInterval(timer)
      window.removeEventListener('tvb:messages-changed', refresh)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [allowed])
  return allowed ? unread : 0
}

function NavLinks({ me, onNavigate }: { me: Me; onNavigate?: () => void }) {
  const [location] = useLocation()
  const unread = useUnreadMessages(me)
  const groups = me.totpRequired ? [] : navFor({ role: me.user.role, canManageUsers: me.canManageUsers })
  const link = (item: NavItem) => {
    const current = isCurrent(item, location)
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        aria-current={current ? 'page' : undefined}
        className={`block rounded px-3 py-2.5 text-sm font-semibold lg:py-1.5 ${
          current ? 'bg-accent text-ink' : 'text-white hover:bg-white/10'
        }`}
      >
        {item.label}
        {item.href === '/messages' && unread > 0 && (
          <span className={`ml-2 rounded-full px-1.5 py-0.5 text-xs font-bold ${current ? 'bg-white text-ink' : 'bg-accent text-ink'}`}>
            {unread}
            <span className="sr-only"> unread</span>
          </span>
        )}
      </Link>
    )
  }
  return (
    <div className="space-y-4">
      {!me.totpRequired && <ul>{<li>{link(HOME)}</li>}</ul>}
      {groups.map((g) => (
        <div key={g.label}>
          <h2 className="text-brand-text/80 px-3 pb-1 text-xs font-bold tracking-wider uppercase">{g.label}</h2>
          <ul>
            {g.items.map((i) => (
              <li key={i.href}>{link(i)}</li>
            ))}
          </ul>
        </div>
      ))}
      {me.totpRequired && <ul>{<li>{link({ href: '/security', label: 'Security' })}</li>}</ul>}
    </div>
  )
}

function Account({ me }: { me: Me }) {
  const [signingOut, setSigningOut] = useState(false)
  const signOut = async () => {
    setSigningOut(true)
    await authClient.signOut()
    window.location.assign('/admin/sign-in')
  }
  return (
    <div className="space-y-2 border-t border-white/20 px-3 pt-4 text-sm text-white">
      <p className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate">{me.user.email}</span>
        <RoleBadge role={me.user.role} />
      </p>
      <p className="flex flex-wrap gap-x-4 gap-y-2">
        <a href="/" className="underline underline-offset-2">
          View the public site
        </a>
        <button type="button" className="underline underline-offset-2" onClick={() => void signOut()} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </p>
    </div>
  )
}

/** Phones and tablets: everything, grouped, in a sheet from the bottom of the screen (reachable with a thumb). */
function MoreSheet({ me, onClose }: { me: Me; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      aria-label="All admin screens"
      className="bg-brand mt-auto mb-0 max-h-[85vh] w-full max-w-none overflow-y-auto rounded-t-xl p-0 pb-[env(safe-area-inset-bottom)] backdrop:bg-black/50"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
      onClick={(e) => {
        // A tap on the backdrop (outside the sheet's content) closes it.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="px-3 pt-3 pb-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="px-3 font-bold text-white">All screens</span>
          <button
            type="button"
            className="flex h-11 w-11 items-center justify-center text-2xl text-white"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <NavLinks me={me} onNavigate={onClose} />
        </div>
        <div className="mt-4">
          <Account me={me} />
        </div>
      </div>
    </dialog>
  )
}

function BottomBar({ me }: { me: Me }) {
  const [location] = useLocation()
  const [more, setMore] = useState(false)
  const items = me.totpRequired ? [] : bottomBar({ role: me.user.role, canManageUsers: me.canManageUsers })
  const inBar = items.some((i) => isCurrent(i, location))
  return (
    <>
      <nav
        aria-label="Quick"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-black/10 bg-white pb-[env(safe-area-inset-bottom)] shadow-[0_-2px_8px_rgba(0,0,0,0.08)] lg:hidden"
      >
        <ul className="mx-auto flex max-w-xl">
          {items.map((i) => {
            const current = isCurrent(i, location)
            return (
              <li key={i.href} className="flex-1">
                <Link
                  href={i.href}
                  aria-current={current ? 'page' : undefined}
                  className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${
                    current ? 'text-brand' : 'text-black/60'
                  }`}
                >
                  <Icon name={i.href} />
                  <span className={current ? 'border-accent border-b-2' : 'border-b-2 border-transparent'}>{i.label}</span>
                </Link>
              </li>
            )
          })}
          <li className="flex-1">
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={more}
              onClick={() => setMore(true)}
              className={`flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] font-semibold ${
                !inBar ? 'text-brand' : 'text-black/60'
              }`}
            >
              <Icon name="more" />
              <span className={!inBar ? 'border-accent border-b-2' : 'border-b-2 border-transparent'}>
                {me.totpRequired ? 'Menu' : 'More'}
              </span>
            </button>
          </li>
        </ul>
      </nav>
      {more && <MoreSheet me={me} onClose={() => setMore(false)} />}
    </>
  )
}

/** "Leagues · Admin · Tempe Volleyball", so tabs and history say where each one is. */
function useDocumentTitle() {
  const [location] = useLocation()
  useEffect(() => {
    const found = navItemFor(location)
    document.title = `${found && found.item !== HOME ? `${found.item.label} · ` : ''}Admin · Tempe Volleyball`
  }, [location])
}

function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const [location] = useLocation()
  useDocumentTitle()
  // A new screen starts at the top and moves keyboard and screen-reader focus to it (not on the first load).
  const main = useRef<HTMLDivElement>(null)
  const shown = useRef(location)
  useEffect(() => {
    if (shown.current === location) return
    shown.current = location
    main.current?.focus({ preventScroll: true })
  })
  return (
    <div className="lg:flex">
      <a href="#admin-main" className="focus:bg-accent sr-only focus:not-sr-only focus:absolute focus:z-50 focus:px-4 focus:py-2">
        Skip to content
      </a>
      <nav aria-label="Admin" className="bg-brand hidden w-60 shrink-0 lg:block">
        <div className="sticky top-0 flex max-h-screen flex-col gap-4 overflow-y-auto px-3 py-5">
          <NavLinks me={me} />
          <Account me={me} />
        </div>
      </nav>
      <div
        id="admin-main"
        ref={main}
        tabIndex={-1}
        className="min-w-0 flex-1 px-4 pt-5 pb-[calc(5.5rem+env(safe-area-inset-bottom))] outline-none sm:pt-6 lg:px-8 lg:py-8"
      >
        <div className="mx-auto max-w-6xl">
          <Suspense fallback={<Skeleton lines={6} />}>{children}</Suspense>
        </div>
      </div>
      <BottomBar me={me} />
      <Toaster />
      <ConfirmHost />
      <LeaveHost />
    </div>
  )
}

function SignedIn({ me }: { me: Me }) {
  const [location] = useLocation()
  // The server already redirects; this covers navigation inside the app.
  if (me.totpRequired && location !== '/security') return <Redirect to="/security?required=1" />
  const admin = me.user.role !== 'editor'
  return (
    <Shell me={me}>
      <Switch>
        <Route path="/">
          <Home me={me} />
        </Route>
        <Route path="/seasons">
          <Redirect to="/leagues" replace />
        </Route>
        <Route path="/leagues">
          <SeasonList me={me} />
        </Route>
        <Route path="/teams">
          <Teams me={me} />
        </Route>
        <Route path="/leagues/:id/:tab?">{(p) => <ProgrammePage key={p.id} me={me} kind="league" id={p.id} tab={p.tab} />}</Route>
        <Route path="/training">
          <ProgrammeList me={me} kind="training" />
        </Route>
        <Route path="/training/:id/:tab?">{(p) => <ProgrammePage key={p.id} me={me} kind="training" id={p.id} tab={p.tab} />}</Route>
        <Route path="/development">
          <ProgrammeList me={me} kind="development" />
        </Route>
        <Route path="/development/:id/:tab?">{(p) => <ProgrammePage key={p.id} me={me} kind="development" id={p.id} tab={p.tab} />}</Route>
        <Route path="/events">
          <ProgrammeList me={me} kind="event" />
        </Route>
        <Route path="/events/:id/:tab?">{(p) => <ProgrammePage key={p.id} me={me} kind="event" id={p.id} tab={p.tab} />}</Route>
        <Route path="/categories">
          <Categories me={me} />
        </Route>
        <Route path="/venues">
          <Venues me={me} />
        </Route>
        <Route path="/matches">
          <Matches />
        </Route>
        <Route path="/seasons/:id/:tab?">{(p) => <SeasonPage key={p.id} me={me} id={p.id} tab={p.tab} />}</Route>
        {admin && (
          <Route path="/enrolments">
            <EnrolmentList />
          </Route>
        )}
        {admin && <Route path="/enrolments/:kind/:id">{(p) => <TargetPage key={`${p.kind}/${p.id}`} kind={p.kind} id={p.id} />}</Route>}
        {admin && (
          <Route path="/messages">
            <Messages />
          </Route>
        )}
        {admin && <Route path="/messages/:id">{(p) => <MessagePage key={p.id} id={p.id} />}</Route>}
        {admin && (
          <Route path="/forms">
            <FormList />
          </Route>
        )}
        {admin && <Route path="/forms/:id">{(p) => <FormEditor key={p.id} id={p.id} />}</Route>}
        <Route path="/pages">
          <PageList />
        </Route>
        <Route path="/pages/new">
          <PageEditor id={null} />
        </Route>
        <Route path="/pages/:id">{(p) => <PageEditor key={p.id} id={p.id} />}</Route>
        <Route path="/news">
          <PostList />
        </Route>
        <Route path="/news/new">
          <PostEditor id={null} />
        </Route>
        <Route path="/news/:id">{(p) => <PostEditor key={p.id} id={p.id} />}</Route>
        <Route path="/menu">
          <Menu me={me} />
        </Route>
        <Route path="/media">
          <Media />
        </Route>
        <Route path="/stats">
          <Stats me={me} />
        </Route>
        <Route path="/settings">
          <Settings me={me} />
        </Route>
        <Route path="/users">
          <Users me={me} />
        </Route>
        <Route path="/audit">
          <Audit me={me} />
        </Route>
        <Route path="/security">
          <Security me={me} />
        </Route>
        <Route>
          <div className="space-y-3">
            <h1 className="text-2xl font-bold">Not found</h1>
            <p className="text-sm">
              There's nothing at this address.{' '}
              <Link href="/" className="text-brand underline">
                Back to the admin home
              </Link>
              .
            </p>
          </div>
        </Route>
      </Switch>
    </Shell>
  )
}

export default function App({ me }: { me: Me | null }) {
  return (
    <Router base="/admin" aroundNav={aroundNav}>
      <Switch>
        <Route path="/sign-in">
          <div className="px-4">
            <SignIn />
          </div>
        </Route>
        <Route path="/invite">
          <div className="px-4">
            <AcceptInvite />
          </div>
        </Route>
        <Route>{me ? <SignedIn me={me} /> : <Redirect to="/sign-in" />}</Route>
      </Switch>
    </Router>
  )
}
