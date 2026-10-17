import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '../db/testing'
import { adminInvites, auditLog, session, user, type UserRole } from '../db/schema'
import { userRoles } from '../db/schema/enums'
import {
  INVITE_TTL_MS,
  RoleError,
  acceptInvite,
  assignableRoles,
  atLeast,
  canAssign,
  canManageUsers,
  canRemove,
  changeRole,
  createInvite,
  expireInvites,
  hashInviteToken,
  inviteStatus,
  listAdminUsers,
  listAudit,
  listPendingInvites,
  lookupInvite,
  outranks,
  removeUser,
  revokeInvite,
} from './roles'

const NOW = new Date('2026-10-18T00:00:00.000Z')
const later = (ms: number) => new Date(NOW.getTime() + ms)

let db: TestDb
beforeEach(() => {
  db = createTestDb().db
})

const addUser = async (id: string, role: UserRole) => {
  await db.insert(user).values({ id, name: id, email: `${id}@example.com`, emailVerified: true, role })
  return { id, ip: '203.0.113.9' }
}

const roleOf = async (id: string) => (await db.select({ role: user.role }).from(user).where(eq(user.id, id)).get())?.role
const audits = () => db.select().from(auditLog).orderBy(auditLog.at)

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(RoleError)
  expect((err as RoleError).code).toBe(code)
}

describe('role ordering', () => {
  it('ranks owner > admin > editor', () => {
    expect(outranks('owner', 'admin')).toBe(true)
    expect(outranks('admin', 'editor')).toBe(true)
    expect(outranks('owner', 'editor')).toBe(true)
    for (const r of userRoles) expect(outranks(r, r)).toBe(false)
    expect(outranks('editor', 'admin')).toBe(false)
    expect(atLeast('owner', 'admin')).toBe(true)
    expect(atLeast('admin', 'admin')).toBe(true)
    expect(atLeast('editor', 'admin')).toBe(false)
  })

  // Every (actor, from, to) combination, spelled out so a rule change has to update this table on purpose.
  const allowed: Record<UserRole, string[]> = {
    owner: [
      'new>owner',
      'new>admin',
      'new>editor',
      'owner>admin',
      'owner>editor',
      'admin>owner',
      'admin>editor',
      'editor>owner',
      'editor>admin',
    ],
    admin: ['new>editor'],
    editor: [],
  }
  for (const actor of userRoles) {
    for (const from of [null, ...userRoles]) {
      for (const to of userRoles) {
        if (from === to) continue
        const key = `${from ?? 'new'}>${to}`
        const expected = allowed[actor].includes(key)
        it(`${actor} ${expected ? 'can' : "can't"} assign ${key}`, () => expect(canAssign(actor, from, to)).toBe(expected))
      }
    }
  }

  it('removal is owner-for-anyone, otherwise strictly below', () => {
    expect(userRoles.map((t) => canRemove('owner', t))).toEqual([true, true, true])
    expect(userRoles.map((t) => canRemove('admin', t))).toEqual([false, false, true])
    expect(userRoles.map((t) => canRemove('editor', t))).toEqual([false, false, false])
  })

  it('lists assignable roles and who manages users', () => {
    expect(assignableRoles('owner')).toEqual(['owner', 'admin', 'editor'])
    expect(assignableRoles('admin')).toEqual(['editor'])
    expect(assignableRoles('editor')).toEqual([])
    expect([canManageUsers('owner'), canManageUsers('admin'), canManageUsers('editor')]).toEqual([true, true, false])
  })
})

describe('changeRole', () => {
  it('lets an owner promote and demote, auditing grant/revoke in the same write', async () => {
    const owner = await addUser('own', 'owner')
    await addUser('ed', 'editor')
    await changeRole(db, owner, 'ed', 'admin', NOW)
    expect(await roleOf('ed')).toBe('admin')
    await changeRole(db, owner, 'ed', 'editor', later(1))
    expect(await roleOf('ed')).toBe('editor')
    const log = await audits()
    expect(log.map((a) => [a.action, a.actorUserId, a.targetId, a.before, a.after, a.ip])).toEqual([
      ['role.grant', 'own', 'ed', { role: 'editor' }, { role: 'admin', email: 'ed@example.com' }, '203.0.113.9'],
      ['role.revoke', 'own', 'ed', { role: 'admin' }, { role: 'editor', email: 'ed@example.com' }, '203.0.113.9'],
    ])
  })

  it("signs the target out everywhere in the same write, and leaves other people's sessions alone", async () => {
    const owner = await addUser('own', 'owner')
    const admin = await addUser('adm', 'admin')
    await addUser('ed', 'editor')
    const addSession = (id: string, userId: string) =>
      db.insert(session).values({ id, token: `t-${id}`, userId, expiresAt: later(1e6), updatedAt: NOW })
    await addSession('s-adm-1', 'adm')
    await addSession('s-adm-2', 'adm')
    await addSession('s-own', 'own')
    await addSession('s-ed', 'ed')
    await changeRole(db, owner, 'adm', 'editor', NOW)
    expect((await db.select({ id: session.id }).from(session)).map((s) => s.id).toSorted()).toEqual(['s-ed', 's-own'])
    // A refused change doesn't touch anyone's sessions.
    await rejects(changeRole(db, admin, 'ed', 'admin'), 'forbidden')
    expect(await db.select().from(session)).toHaveLength(2)
  })

  it('lets owners make and demote other owners', async () => {
    const a = await addUser('a', 'owner')
    await addUser('b', 'admin')
    await changeRole(db, a, 'b', 'owner', NOW)
    expect(await roleOf('b')).toBe('owner')
    await changeRole(db, a, 'b', 'admin', NOW)
    expect(await roleOf('b')).toBe('admin')
  })

  it('stops admins touching admins or owners, or promoting to admin', async () => {
    await addUser('own', 'owner')
    const admin = await addUser('adm', 'admin')
    await addUser('adm2', 'admin')
    await addUser('ed', 'editor')
    await rejects(changeRole(db, admin, 'ed', 'admin'), 'forbidden')
    await rejects(changeRole(db, admin, 'adm2', 'editor'), 'forbidden')
    await rejects(changeRole(db, admin, 'own', 'editor'), 'forbidden')
    await rejects(changeRole(db, admin, 'adm', 'editor'), 'forbidden')
    expect(await audits()).toEqual([])
  })

  it('stops editors changing anyone', async () => {
    await addUser('own', 'owner')
    const ed = await addUser('ed', 'editor')
    await addUser('ed2', 'editor')
    await rejects(changeRole(db, ed, 'ed2', 'admin'), 'forbidden')
    expect(await roleOf('ed2')).toBe('editor')
  })

  it("won't demote the last owner, even themself", async () => {
    const owner = await addUser('own', 'owner')
    await rejects(changeRole(db, owner, 'own', 'admin'), 'last_owner')
    expect(await roleOf('own')).toBe('owner')
    expect(await audits()).toEqual([])
  })

  it('lets an owner step down when another owner remains', async () => {
    const a = await addUser('a', 'owner')
    await addUser('b', 'owner')
    await changeRole(db, a, 'a', 'admin')
    expect(await roleOf('a')).toBe('admin')
  })

  it('rolls back the whole batch when two owners demote each other at once', async () => {
    const a = await addUser('a', 'owner')
    const b = await addUser('b', 'owner')
    const results = await Promise.allSettled([changeRole(db, a, 'b', 'admin'), changeRole(db, b, 'a', 'admin')])
    expect(results.map((r) => r.status).toSorted()).toEqual(['fulfilled', 'rejected'])
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((failure.reason as RoleError).code).toBe('last_owner')
    const roles = [await roleOf('a'), await roleOf('b')].toSorted()
    expect(roles).toEqual(['admin', 'owner'])
    expect(await audits()).toHaveLength(1)
  })

  it('treats no-op changes as success without an audit entry, and rejects bad input', async () => {
    const owner = await addUser('own', 'owner')
    await addUser('ed', 'editor')
    await changeRole(db, owner, 'ed', 'editor')
    expect(await audits()).toEqual([])
    await rejects(changeRole(db, owner, 'ed', 'superuser' as UserRole), 'invalid_input')
    await rejects(changeRole(db, owner, 'nobody', 'admin'), 'not_found')
    await rejects(changeRole(db, { id: 'ghost' }, 'ed', 'admin'), 'forbidden')
  })
})

describe('removeUser', () => {
  it('deletes the user and their sessions, and audits it', async () => {
    const owner = await addUser('own', 'owner')
    await addUser('ed', 'editor')
    await db.insert(session).values({ id: 's1', token: 't1', userId: 'ed', expiresAt: later(1e6), updatedAt: NOW })
    await removeUser(db, owner, 'ed', NOW)
    expect(await roleOf('ed')).toBeUndefined()
    expect(await db.select().from(session)).toEqual([])
    const [entry] = await audits()
    expect(entry).toMatchObject({
      action: 'user.remove',
      actorUserId: 'own',
      targetId: 'ed',
      before: { email: 'ed@example.com', role: 'editor' },
    })
  })

  it('lets admins remove editors only', async () => {
    await addUser('own', 'owner')
    const admin = await addUser('adm', 'admin')
    await addUser('adm2', 'admin')
    await addUser('ed', 'editor')
    await rejects(removeUser(db, admin, 'adm2'), 'forbidden')
    await rejects(removeUser(db, admin, 'own'), 'forbidden')
    await removeUser(db, admin, 'ed')
    expect(await roleOf('ed')).toBeUndefined()
  })

  it("won't remove the last owner, but will remove one of two", async () => {
    const a = await addUser('a', 'owner')
    await rejects(removeUser(db, a, 'a'), 'last_owner')
    await addUser('b', 'owner')
    await removeUser(db, a, 'b')
    expect(await roleOf('b')).toBeUndefined()
  })

  it('rolls back when two owners remove each other at once', async () => {
    const a = await addUser('a', 'owner')
    const b = await addUser('b', 'owner')
    const results = await Promise.allSettled([removeUser(db, a, 'b'), removeUser(db, b, 'a')])
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect((await db.select().from(user)).filter((u) => u.role === 'owner')).toHaveLength(1)
  })

  it('keeps audit entries after the actor is deleted', async () => {
    const a = await addUser('a', 'owner')
    const b = await addUser('b', 'owner')
    await addUser('ed', 'editor')
    await removeUser(db, a, 'ed')
    await removeUser(db, b, 'a')
    expect((await audits()).map((e) => e.actorUserId)).toEqual(['a', 'b'])
  })
})

describe('invites', () => {
  it('creates a 7-day invite storing only the token hash, and audits it', async () => {
    const owner = await addUser('own', 'owner')
    const inv = await createInvite(db, owner, { email: '  New.Person@Example.COM ', role: 'admin' }, NOW)
    expect(inv.email).toBe('new.person@example.com')
    expect(inv.expiresAt).toBe(later(INVITE_TTL_MS).toISOString())
    expect(inv.token).toMatch(/^[\w-]{43}$/)
    const [row] = await db.select().from(adminInvites)
    expect(row!.tokenHash).toBe(await hashInviteToken(inv.token))
    expect(row!.tokenHash).not.toContain(inv.token)
    expect(row!.invitedBy).toBe('own')
    const [entry] = await audits()
    expect(entry).toMatchObject({
      action: 'invite.create',
      targetType: 'invite',
      targetId: inv.id,
      after: { email: inv.email, role: 'admin' },
    })
    expect(JSON.stringify(entry)).not.toContain(inv.token)
  })

  it('enforces who can invite whom', async () => {
    const owner = await addUser('own', 'owner')
    const admin = await addUser('adm', 'admin')
    const ed = await addUser('ed', 'editor')
    await createInvite(db, owner, { email: 'o2@example.com', role: 'owner' })
    await createInvite(db, admin, { email: 'e2@example.com', role: 'editor' })
    await rejects(createInvite(db, admin, { email: 'a2@example.com', role: 'admin' }), 'forbidden')
    await rejects(createInvite(db, ed, { email: 'e3@example.com', role: 'editor' }), 'forbidden')
    await rejects(createInvite(db, owner, { email: 'not-an-email', role: 'editor' }), 'invalid_input')
    await rejects(createInvite(db, owner, { email: 'ed@example.com', role: 'editor' }), 'user_exists')
    expect((await listPendingInvites(db)).map((i) => i.email).toSorted()).toEqual(['e2@example.com', 'o2@example.com'])
  })

  it('replaces a pending invite for the same address, revoking the old one', async () => {
    const owner = await addUser('own', 'owner')
    const first = await createInvite(db, owner, { email: 'x@example.com', role: 'editor' }, NOW)
    const second = await createInvite(db, owner, { email: 'x@example.com', role: 'admin' }, later(1000))
    await rejects(lookupInvite(db, first.token, later(2000)), 'invite_revoked')
    expect(await lookupInvite(db, second.token, later(2000))).toMatchObject({ email: 'x@example.com', role: 'admin' })
    expect((await audits()).map((a) => a.action)).toEqual(['invite.create', 'invite.revoke', 'invite.create'])
    expect(await listPendingInvites(db, later(2000))).toHaveLength(1)
  })

  it("won't let an admin replace an owner's pending admin invite", async () => {
    const owner = await addUser('own', 'owner')
    const admin = await addUser('adm', 'admin')
    await createInvite(db, owner, { email: 'x@example.com', role: 'admin' })
    await rejects(createInvite(db, admin, { email: 'x@example.com', role: 'editor' }), 'forbidden')
    expect((await listPendingInvites(db)).map((i) => i.role)).toEqual(['admin'])
  })

  it('accepts once: creates the user with the role, verified, and audits it', async () => {
    const owner = await addUser('own', 'owner')
    const inv = await createInvite(db, owner, { email: 'x@example.com', role: 'admin' }, NOW)
    const u = await acceptInvite(db, { token: inv.token, name: ' Xavier ', ip: '198.51.100.1' }, later(1000))
    expect(u).toMatchObject({ email: 'x@example.com', name: 'Xavier', role: 'admin' })
    const row = await db.select().from(user).where(eq(user.id, u.id)).get()
    expect(row).toMatchObject({ role: 'admin', emailVerified: true })
    await rejects(acceptInvite(db, { token: inv.token }, later(2000)), 'invite_used')
    const last = (await audits()).at(-1)
    expect(last).toMatchObject({ action: 'invite.accept', actorUserId: u.id, targetId: inv.id, ip: '198.51.100.1' })
  })

  it('accepts only once under concurrency', async () => {
    const owner = await addUser('own', 'owner')
    const inv = await createInvite(db, owner, { email: 'x@example.com', role: 'editor' }, NOW)
    const results = await Promise.allSettled([
      acceptInvite(db, { token: inv.token }, later(5)),
      acceptInvite(db, { token: inv.token }, later(6)),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await db.select().from(user)).filter((u) => u.email === 'x@example.com')).toHaveLength(1)
  })

  it('defaults the name to the email local part', async () => {
    const owner = await addUser('own', 'owner')
    const inv = await createInvite(db, owner, { email: 'michael@example.com', role: 'editor' }, NOW)
    expect((await acceptInvite(db, { token: inv.token }, NOW)).name).toBe('michael')
  })

  it('rejects expired, revoked and unknown tokens', async () => {
    const owner = await addUser('own', 'owner')
    const inv = await createInvite(db, owner, { email: 'x@example.com', role: 'editor' }, NOW)
    await rejects(acceptInvite(db, { token: inv.token }, later(INVITE_TTL_MS)), 'invite_expired')
    await rejects(lookupInvite(db, 'x'.repeat(43), NOW), 'invite_invalid')
    await rejects(lookupInvite(db, 'short', NOW), 'invite_invalid')
    const other = await createInvite(db, owner, { email: 'y@example.com', role: 'editor' }, NOW)
    await revokeInvite(db, owner, other.id, later(1))
    await rejects(acceptInvite(db, { token: other.token }, later(2)), 'invite_revoked')
    await rejects(revokeInvite(db, owner, other.id, later(3)), 'invite_revoked')
    expect((await audits()).map((a) => a.action)).toEqual(['invite.create', 'invite.create', 'invite.revoke'])
  })

  it('rejects acceptance when the address already has an account', async () => {
    const owner = await addUser('own', 'owner')
    const inv = await createInvite(db, owner, { email: 'x@example.com', role: 'editor' }, NOW)
    await addUser('x', 'editor')
    await rejects(acceptInvite(db, { token: inv.token }, NOW), 'user_exists')
    expect(await listPendingInvites(db, NOW)).toHaveLength(1)
  })

  it('limits revoking to invites you could have sent', async () => {
    const owner = await addUser('own', 'owner')
    const admin = await addUser('adm', 'admin')
    const ownerInvite = await createInvite(db, owner, { email: 'a@example.com', role: 'admin' }, NOW)
    const editorInvite = await createInvite(db, owner, { email: 'e@example.com', role: 'editor' }, NOW)
    await rejects(revokeInvite(db, admin, ownerInvite.id, NOW), 'forbidden')
    await revokeInvite(db, admin, editorInvite.id, NOW)
    await rejects(revokeInvite(db, admin, 'nope', NOW), 'not_found')
    expect((await listPendingInvites(db, NOW)).map((i) => i.id)).toEqual([ownerInvite.id])
  })

  it('cron marks expired invites once, and status reflects it', async () => {
    const owner = await addUser('own', 'owner')
    const a = await createInvite(db, owner, { email: 'a@example.com', role: 'editor' }, NOW)
    const b = await createInvite(db, owner, { email: 'b@example.com', role: 'editor' }, later(60_000))
    await acceptInvite(db, { token: b.token }, later(120_000))
    expect(await expireInvites(db, later(INVITE_TTL_MS - 1))).toBe(0)
    expect(await expireInvites(db, later(INVITE_TTL_MS + 70_000))).toBe(1)
    expect(await expireInvites(db, later(INVITE_TTL_MS + 80_000))).toBe(0)
    const row = await db.select().from(adminInvites).where(eq(adminInvites.id, a.id)).get()
    expect(row!.expiredAt).toBe(later(INVITE_TTL_MS + 70_000).toISOString())
    expect(inviteStatus(row!, NOW)).toBe('expired')
  })
})

describe('reads', () => {
  it('lists users owners first and pages the audit log newest first', async () => {
    const owner = await addUser('zed', 'owner')
    await addUser('amy', 'editor')
    await addUser('bob', 'admin')
    expect((await listAdminUsers(db)).map((u) => u.id)).toEqual(['zed', 'bob', 'amy'])
    for (let i = 0; i < 5; i++) await createInvite(db, owner, { email: `p${i}@example.com`, role: 'editor' }, later(i * 1000))
    const page1 = await listAudit(db, { limit: 3 })
    expect(page1.map((e) => e.after)).toMatchObject([{ email: 'p4@example.com' }, { email: 'p3@example.com' }, { email: 'p2@example.com' }])
    expect(page1[0]!.actorEmail).toBe('zed@example.com')
    const page2 = await listAudit(db, { limit: 3, before: page1.at(-1)!.at })
    expect(page2.map((e) => (e.after as { email: string }).email)).toEqual(['p1@example.com', 'p0@example.com'])
  })
})
