declare namespace App {
  interface Locals {
    /** The signed-in admin user on /admin/* and /api/admin/* (set by src/middleware.ts), else null. */
    user: import('./server/auth/auth').SessionUser | null
    session: import('./server/auth/auth').AuthSession['session'] | null
  }
}
