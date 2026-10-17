import { describe, expect, it } from 'vitest'
import { createTestDb } from './db/testing'
import { adminInvites, emailOutbox, user } from './db/schema'
import { hashInviteToken } from './auth/roles'
import { createMailer } from './email'
import { runJobs } from './cron'

const NOW = new Date('2026-10-18T00:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const HOUR = 60 * 60 * 1000

describe('runJobs', () => {
  it('expires overdue invites, drains the outbox and scrubs old secrets', async () => {
    const { db } = createTestDb()
    await db.insert(user).values({ id: 'o', name: 'o', email: 'o@x.com', role: 'owner' })
    await db.insert(adminInvites).values([
      { email: 'a@x.com', role: 'editor', tokenHash: 'h1', invitedBy: 'o', expiresAt: '2026-10-01T00:00:00.000Z' },
      {
        email: 'q@x.com',
        role: 'editor',
        tokenHash: await hashInviteToken('tok-q'),
        invitedBy: 'o',
        expiresAt: '2026-10-25T00:00:00.000Z',
      },
    ])
    await db.insert(emailOutbox).values({
      to: 'q@x.com',
      template: 'admin.invite',
      payload: { url: 'https://x/admin/invite#tok-q', role: 'editor', invitedBy: 'o', expiresAt: '2026-10-25T00:00:00.000Z' },
      createdAt: ago(1000),
    })
    await db
      .insert(emailOutbox)
      .values({ to: 'o@x.com', template: 'auth.otp', payload: { otp: '123456' }, status: 'failed', createdAt: ago(2 * HOUR) })
    const logs: string[] = []
    const mailer = createMailer({ db, env: { SITE_ENV: 'development' }, log: (m) => logs.push(m), now: () => NOW })
    const result = await runJobs(db, mailer, NOW)
    expect(result).toEqual({ invitesExpired: 1, email: { sent: 1, failed: 0, skipped: 0, remaining: 0 }, payloadsScrubbed: 1 })
    expect((await db.select().from(adminInvites))[0]!.expiredAt).toBe('2026-10-18T00:00:00.000Z')
    expect(logs).toHaveLength(1)
    expect(JSON.stringify(await db.select().from(emailOutbox))).not.toMatch(/123456|tok-q/)
  })

  it('keeps going when one job fails', async () => {
    const { db } = createTestDb()
    const result = await runJobs(db, {
      drainOutbox: () => Promise.reject(new Error('resend down')),
      scrubSensitivePayloads: () => Promise.resolve(0),
    })
    expect(result).toEqual({ invitesExpired: 0, email: 'error: Error: resend down', payloadsScrubbed: 0 })
  })
})
