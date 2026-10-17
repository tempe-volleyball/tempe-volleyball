import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createMigratedSqlite, createTestDb } from '../db/testing'
import { auditLog, user } from '../db/schema'
import { bootstrapOwnerSql, wranglerArgs } from './bootstrap'

describe('bootstrapOwnerSql', () => {
  it('creates an owner, and promotes an existing user on a re-run, auditing both', async () => {
    const { db, sqlite } = createTestDb()
    sqlite.exec(bootstrapOwnerSql(' Michael@Example.com ', { id: 'u1', now: new Date('2026-10-18T00:00:00Z') }))
    const row = await db.select().from(user).where(eq(user.email, 'michael@example.com')).get()
    expect(row).toMatchObject({ id: 'u1', name: 'michael', role: 'owner', emailVerified: true })
    expect(row!.createdAt.toISOString()).toBe('2026-10-18T00:00:00.000Z')

    await db.update(user).set({ role: 'editor' }).where(eq(user.id, 'u1'))
    sqlite.exec(bootstrapOwnerSql('michael@example.com', { id: 'ignored' }))
    expect((await db.select().from(user)).map((u) => [u.id, u.role])).toEqual([['u1', 'owner']])
    const log = await db.select().from(auditLog)
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({
      action: 'role.grant',
      actorUserId: null,
      targetId: 'u1',
      after: { role: 'owner', email: 'michael@example.com', via: 'bootstrap' },
    })
  })

  it('rejects anything that is not a plain email address', () => {
    for (const bad of ['', 'nobody', "x'@y.com", 'a@b', 'a b@c.com', 'x@y.com; drop table user']) {
      expect(() => bootstrapOwnerSql(bad)).toThrow('Not a valid email')
    }
  })

  it('is valid SQLite as one command', () => {
    const sqlite = createMigratedSqlite()
    expect(() => sqlite.exec(bootstrapOwnerSql('o@x.com'))).not.toThrow()
  })
})

describe('wranglerArgs', () => {
  it('targets local or the remote environment', () => {
    expect(wranglerArgs('local', 'SELECT 1')).toEqual(['wrangler', 'd1', 'execute', 'DB', '--local', '--command', 'SELECT 1'])
    expect(wranglerArgs('staging', 'SELECT 1')).toEqual([
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--env',
      'staging',
      '--remote',
      '--command',
      'SELECT 1',
    ])
  })
})
