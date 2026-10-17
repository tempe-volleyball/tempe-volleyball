import { useState } from 'react'
import { Link, Redirect, Route, Router, Switch, useLocation } from 'wouter'
import type { Me } from './api'
import { authClient } from './auth-client'
import { AcceptInvite } from './screens/AcceptInvite'
import { Audit } from './screens/Audit'
import { Security } from './screens/Security'
import { SignIn } from './screens/SignIn'
import { Users } from './screens/Users'
import { Button, Card, RoleBadge } from './ui'

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
        <p className="text-sm">Pages, menus, media, seasons and results editing are on their way. For now you can:</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
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
    <Router base="/admin">
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
