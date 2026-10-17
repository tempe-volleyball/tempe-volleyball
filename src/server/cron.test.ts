import { describe, expect, it } from 'vitest'
import { createTestDb } from './db/testing'
import { adminInvites, emailOutbox, user } from './db/schema'
import { createMailer } from './email'
import { runJobs } from './cron'

describe('runJobs', () => {
  it('expires overdue invites and drains the outbox', async () => {
    const { db } = createTestDb()
    await db.insert(user).values({ id: 'o', name: 'o', email: 'o@x.com', role: 'owner' })
    await db
      .insert(adminInvites)
      .values({ email: 'a@x.com', role: 'editor', tokenHash: 'h1', invitedBy: 'o', expiresAt: '2026-10-01T00:00:00.000Z' })
    await db.insert(emailOutbox).values({
      to: 'q@x.com',
      template: 'admin.invite',
      payload: { url: 'u', role: 'editor', invitedBy: 'o', expiresAt: '2026-10-25T00:00:00.000Z' },
    })
    const logs: string[] = []
    const mailer = createMailer({ db, env: { SITE_ENV: 'development' }, log: (m) => logs.push(m) })
    const result = await runJobs(db, mailer, new Date('2026-10-18T00:00:00.000Z'))
    expect(result).toEqual({ invitesExpired: 1, email: { sent: 1, failed: 0, remaining: 0 } })
    expect((await db.select().from(adminInvites))[0]!.expiredAt).toBe('2026-10-18T00:00:00.000Z')
    expect(logs).toHaveLength(1)
  })

  it('keeps going when one job fails', async () => {
    const { db } = createTestDb()
    const result = await runJobs(db, { drainOutbox: () => Promise.reject(new Error('resend down')) })
    expect(result).toEqual({ invitesExpired: 0, email: 'error: Error: resend down' })
  })
})
