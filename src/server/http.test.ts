import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { saveSettings } from './content/settings'
import { createTestDb, type TestDb } from './db/testing'
import { user, type UserRole } from './db/schema'
import { RoleError } from './auth/roles'
import { HttpError, requireRole } from './http'

let db: TestDb
beforeEach(() => {
  db = createTestDb().db
})

const addUser = (id: string, role: UserRole) =>
  db.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: true, role })

const req = (method: string) => new Request('https://x/api/admin/settings', { method, headers: { 'cf-connecting-ip': '203.0.113.9' } })

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof HttpError || e instanceof RoleError ? `${e.status} ${e.code}` : String(e)),
  )

describe('requireRole', () => {
  it('rejects missing users and roles below the minimum', async () => {
    expect(await codeOf(requireRole(null, 'editor', req('GET'), db))).toBe('401 unauthenticated')
    expect(await codeOf(requireRole({ id: 'e', role: 'editor' }, 'admin', req('GET'), db))).toBe('403 forbidden')
  })

  it('trusts the cached role for reads, without touching D1', async () => {
    // No user row at all: a GET still passes on the session's role.
    expect(await requireRole({ id: 'cached', role: 'admin' }, 'admin', req('GET'), db)).toEqual({
      id: 'cached',
      role: 'admin',
      ip: '203.0.113.9',
    })
  })

  it('re-reads the role from D1 for unsafe methods and uses that one', async () => {
    await addUser('a', 'admin')
    // Demoted to editor since the session cookie was cached as admin.
    await db.update(user).set({ role: 'editor' }).where(eq(user.id, 'a'))
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect(await codeOf(requireRole({ id: 'a', role: 'admin' }, 'admin', req(method), db))).toBe('403 forbidden')
    // Still an editor, so editor-level writes work, but with the fresh role.
    expect(await requireRole({ id: 'a', role: 'admin' }, 'editor', req('PUT'), db)).toMatchObject({ role: 'editor' })
  })

  it('rejects unsafe requests from a user who has been removed', async () => {
    expect(await codeOf(requireRole({ id: 'gone', role: 'owner' }, 'editor', req('POST'), db))).toBe('403 forbidden')
  })

  it('stops a demoted admin changing PayID with a stale session', async () => {
    await addUser('a', 'admin')
    await db.update(user).set({ role: 'editor' }).where(eq(user.id, 'a'))
    const actor = await requireRole({ id: 'a', role: 'admin' }, 'editor', req('PUT'), db)
    const err = await saveSettings(db, actor, { payid: { name: 'Mallory', payid: 'mallory@example.com' } }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(403)
  })
})
