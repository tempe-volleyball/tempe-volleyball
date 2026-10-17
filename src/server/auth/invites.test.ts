import { describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../db/testing'
import { createMailer, EmailNotConfiguredError } from '../email'
import { inviteUrl, sendInviteEmail } from './invites'

const invite = {
  email: 'x@example.com',
  role: 'editor',
  expiresAt: '2026-10-25T00:00:00.000Z',
  url: 'https://site/admin/invite#tok',
  invitedBy: 'Michael',
}

describe('inviteUrl', () => {
  it('puts the token in the fragment on the site origin', () => {
    expect(inviteUrl('https://tempe-volleyball-staging.tempevb.workers.dev', 'abc')).toBe(
      'https://tempe-volleyball-staging.tempevb.workers.dev/admin/invite#abc',
    )
    expect(inviteUrl('http://localhost:4321/', 'abc')).toBe('http://localhost:4321/admin/invite#abc')
  })
})

describe('sendInviteEmail', () => {
  it('reports how the email went', async () => {
    const { db } = createTestDb()
    const logs: string[] = []
    const mailer = createMailer({ db, env: { SITE_ENV: 'staging' }, log: (m) => logs.push(m) })
    expect(await sendInviteEmail(mailer, invite)).toBe('logged')
    expect(logs[0]).toContain('https://site/admin/invite#tok')
    expect(logs[0]).toContain('Michael has invited you')
  })

  it("doesn't throw when email isn't configured or fails", async () => {
    const notConfigured = { sendEmail: async () => Promise.reject(new EmailNotConfiguredError()) }
    expect(await sendInviteEmail(notConfigured, invite)).toBe('not_configured')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = { sendEmail: async () => Promise.reject(new Error('db down')) }
    expect(await sendInviteEmail(broken, invite)).toBe('failed')
    error.mockRestore()
  })
})
