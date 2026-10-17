import { Suspense, lazy, useState } from 'react'
import { Link, Redirect, Route, Router, Switch, useLocation } from 'wouter'
import type { Me } from './api'
import { authClient } from './auth-client'
import { aroundNav } from './leave-guard'
import { AcceptInvite } from './screens/AcceptInvite'
import { Audit } from './screens/Audit'
import { Media } from './screens/Media'
import { Menu } from './screens/Menu'
import { PageEditor, PageList } from './screens/Pages'
import { PostEditor, PostList } from './screens/Posts'
import { Security } from './screens/Security'
import { Settings } from './screens/Settings'
import { SignIn } from './screens/SignIn'
import { Users } from './screens/Users'
import { Categories } from './programmes/Categories'
import { ProgrammeList } from './programmes/ProgrammeList'
import { ProgrammePage } from './programmes/ProgrammePage'
import { Venues } from './programmes/Venues'
import { EnrolmentList } from './enrolment/EnrolmentList'
import { FormEditor, FormList } from './enrolment/Forms'
import { TargetPage } from './enrolment/TargetPage'
import { SeasonList } from './seasons/SeasonList'
import { SeasonPage } from './seasons/SeasonPage'
import { Button, Card, RoleBadge } from './ui'

// The Stats screen (charts) is its own chunk, loaded when first opened.
const Stats = lazy(() => import('./screens/Stats'))

// The admin app: one React island at /admin/* with a client-side router (wouter, base /admin). The server renders
// the same shell for every /admin path and has already checked the session (src/middleware.ts), so `me` is the
// signed-in user, or null on the public sign-in and invite pages.

function NavLink({ href, children }: { href: string; children: string }) {
  const [location] = useLocation()
  const active = href === '/' ? location === '/' : location.startsWith(href)
  return (
    <Link
      href={href}
      className={`px-3 py-3 text-sm font-semibold tracking-wide uppercase ${active ? 'bg-accent text-ink' : 'text-white hover:bg-white/10'}`}
    >
      {children}
    </Link>
  )
}

function Shell({ me, children }: { me: Me; children: React.ReactNode }) {
  const [signingOut, setSigningOut] = useState(false)
  const signOut = async () => {
    setSigningOut(true)
    await authClient.signOut()
    window.location.assign('/admin/sign-in')
  }
  return (
    <>
      <nav className="bg-brand" aria-label="Admin">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center px-4">
          {!me.totpRequired && <NavLink href="/">Home</NavLink>}
          {!me.totpRequired && <NavLink href="/leagues">Leagues</NavLink>}
          {!me.totpRequired && <NavLink href="/training">Training</NavLink>}
          {!me.totpRequired && <NavLink href="/development">Development</NavLink>}
          {!me.totpRequired && <NavLink href="/events">Events</NavLink>}
          {!me.totpRequired && <NavLink href="/categories">Categories</NavLink>}
          {!me.totpRequired && <NavLink href="/venues">Venues</NavLink>}
          {!me.totpRequired && me.user.role !== 'editor' && <NavLink href="/enrolments">Enrolments</NavLink>}
          {!me.totpRequired && <NavLink href="/pages">Pages</NavLink>}
          {!me.totpRequired && <NavLink href="/news">News</NavLink>}
          {!me.totpRequired && <NavLink href="/menu">Menu</NavLink>}
          {!me.totpRequired && <NavLink href="/media">Media</NavLink>}
          {!me.totpRequired && <NavLink href="/stats">Stats</NavLink>}
          {!me.totpRequired && <NavLink href="/settings">Settings</NavLink>}
          {!me.totpRequired && me.canManageUsers && <NavLink href="/users">Admin users</NavLink>}
          {!me.totpRequired && me.canManageUsers && <NavLink href="/audit">Audit log</NavLink>}
          <NavLink href="/security">Security</NavLink>
          <div className="ml-auto flex items-center gap-3 py-2 text-sm text-white">
            <span className="hidden sm:inline">{me.user.email}</span>
            <RoleBadge role={me.user.role} />
            <button type="button" className="underline underline-offset-2" onClick={() => void signOut()} disabled={signingOut}>
              Sign out
            </button>
          </div>
        </div>
      </nav>
      <div className="mx-auto max-w-6xl px-4 py-8">{children}</div>
    </>
  )
}

function Home({ me }: { me: Me }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Hello, {me.user.name || me.user.email}</h1>
      <Card title="Admin">
        <p className="text-sm">You can:</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
          <li>
            <Link href="/leagues" className="text-brand underline">
              {me.user.role === 'editor' ? 'Enter and publish results' : 'Set up seasons, make the draw and enter results'}
            </Link>
          </li>
          {me.user.role !== 'editor' && (
            <li>
              <Link href="/enrolments" className="text-brand underline">
                See enrolments, mark payments and manage waitlists
              </Link>{' '}
              (and the{' '}
              <Link href="/forms" className="text-brand underline">
                enrolment forms
              </Link>
              )
            </li>
          )}
          <li>
            {me.user.role === 'editor' ? 'See' : 'Manage'} the{' '}
            <Link href="/leagues" className="text-brand underline">
              leagues
            </Link>
            ,{' '}
            <Link href="/training" className="text-brand underline">
              training
            </Link>
            ,{' '}
            <Link href="/development" className="text-brand underline">
              development programmes
            </Link>{' '}
            and{' '}
            <Link href="/events" className="text-brand underline">
              events
            </Link>
            , their{' '}
            <Link href="/categories" className="text-brand underline">
              categories
            </Link>{' '}
            and{' '}
            <Link href="/venues" className="text-brand underline">
              venues
            </Link>
          </li>
          <li>
            <Link href="/pages" className="text-brand underline">
              Edit pages
            </Link>{' '}
            and{' '}
            <Link href="/news" className="text-brand underline">
              news posts
            </Link>
          </li>
          <li>
            <Link href="/menu" className="text-brand underline">
              Change the menu
            </Link>
          </li>
          <li>
            <Link href="/media" className="text-brand underline">
              Upload images and files
            </Link>
          </li>
          <li>
            <Link href="/stats" className="text-brand underline">
              See visitors, Google searches and site speed
            </Link>
          </li>
          <li>
            <Link href="/settings" className="text-brand underline">
              Update contact details, the announcement banner and other settings
            </Link>
          </li>
          {me.canManageUsers && (
            <li>
              <Link href="/users" className="text-brand underline">
                Invite and manage admin users
              </Link>
            </li>
          )}
          {me.canManageUsers && (
            <li>
              <Link href="/audit" className="text-brand underline">
                See the audit log
              </Link>
            </li>
          )}
          <li>
            <Link href="/security" className="text-brand underline">
              {me.user.twoFactorEnabled ? 'Manage two-factor sign-in' : 'Set up two-factor sign-in'}
            </Link>
          </li>
        </ul>
      </Card>
      {!me.user.twoFactorEnabled && (
        <Card>
          <p className="text-sm">
            Tip: set up an authenticator app under{' '}
            <Link href="/security" className="text-brand underline">
              Security
            </Link>{' '}
            so nobody can sign in as you with just access to your email.
          </p>
        </Card>
      )}
      <Button variant="link" onClick={() => window.location.assign('/')}>
        View the public site
      </Button>
    </div>
  )
}

function SignedIn({ me }: { me: Me }) {
  const [location] = useLocation()
  // The server already redirects; this covers navigation inside the app.
  if (me.totpRequired && location !== '/security') return <Redirect to="/security?required=1" />
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
        <Route path="/seasons/:id/:tab?">{(p) => <SeasonPage key={p.id} me={me} id={p.id} tab={p.tab} />}</Route>
        {me.user.role !== 'editor' && (
          <Route path="/enrolments">
            <EnrolmentList />
          </Route>
        )}
        {me.user.role !== 'editor' && (
          <Route path="/enrolments/:kind/:id">{(p) => <TargetPage key={`${p.kind}/${p.id}`} kind={p.kind} id={p.id} />}</Route>
        )}
        {me.user.role !== 'editor' && (
          <Route path="/forms">
            <FormList />
          </Route>
        )}
        {me.user.role !== 'editor' && <Route path="/forms/:id">{(p) => <FormEditor key={p.id} id={p.id} />}</Route>}
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
          <Menu />
        </Route>
        <Route path="/media">
          <Media />
        </Route>
        <Route path="/stats">
          <Suspense fallback={<p className="text-sm text-black/60">Loading…</p>}>
            <Stats me={me} />
          </Suspense>
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
          <Card title="Not found">
            <p className="text-sm">
              There's nothing here yet.{' '}
              <Link href="/" className="text-brand underline">
                Back to the admin home
              </Link>
              .
            </p>
          </Card>
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
          <SignIn />
        </Route>
        <Route path="/invite">
          <AcceptInvite />
        </Route>
        <Route>{me ? <SignedIn me={me} /> : <Redirect to="/sign-in" />}</Route>
      </Switch>
    </Router>
  )
}
