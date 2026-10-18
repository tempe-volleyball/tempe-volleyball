import type { AstroGlobal } from 'astro'
import { env } from 'cloudflare:workers'
import { getDb } from './db'
import { cachePublic, tags } from './cache'
import { countRedirectHit, createSiteMemo, findRedirect, type Site } from './site'

// Helpers for public routes (they read bindings, so only routes import this). Public pages use a plain Drizzle client
// rather than getServices(), which would also build Better Auth (~1 ms of CPU) for nothing.

export const publicDb = () => getDb(env.DB)

/** This isolate's copy of loadSite() (src/server/site.ts createSiteMemo; the middleware clears it on admin writes). */
export const siteMemo = createSiteMemo()

/** What every public page shows around its content: memoised per isolate and checked against the site version. */
export const publicSite = (db: ReturnType<typeof publicDb>): Promise<Site> => siteMemo.load(db)

type Ctx = Pick<AstroGlobal, 'locals' | 'redirect' | 'cache'>

/**
 * When a route has nothing at `path`: follow a redirect from the redirects table (old WordPress URLs) with a 301,
 * or return null so the page renders its not-found state (with a 404 status).
 */
export async function redirectFor(ctx: Ctx, db: ReturnType<typeof publicDb>, path: string): Promise<Response | null> {
  const r = await findRedirect(db, path)
  return r ? followRedirect(ctx, db, path, r) : null
}

/** A 301 to the redirect's target, counting the hit after the response is sent. */
export function followRedirect(
  ctx: Ctx,
  db: ReturnType<typeof publicDb>,
  path: string,
  r: { id: string; toPath: string; status: number },
): Response {
  ctx.locals.cfContext?.waitUntil(
    countRedirectHit(db, r.id).then(
      () => undefined,
      (e: unknown) => console.error('redirect hit count failed', e),
    ),
  )
  cachePublic(ctx.cache, tags.page(path))
  return ctx.redirect(r.toPath, r.status === 302 ? 302 : 301)
}
