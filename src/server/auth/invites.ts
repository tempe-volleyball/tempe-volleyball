import { describeError } from '../log'
import { EmailNotConfiguredError, type Mailer } from '../email'

/**
 * The link in an invite email. The token goes in the fragment, so it never reaches server logs, analytics or a
 * Referer header; the admin app reads it from location.hash.
 */
export const inviteUrl = (siteUrl: string, token: string) => `${new URL(siteUrl).origin}/admin/invite#${token}`

export type InviteEmailStatus = 'sent' | 'logged' | 'queued' | 'failed' | 'not_configured'

/** Emails the invite. Never throws for email problems: the invite exists either way and its link can be copied. */
export async function sendInviteEmail(
  mailer: Pick<Mailer, 'sendEmail'>,
  invite: { email: string; role: string; expiresAt: string; url: string; invitedBy: string },
): Promise<InviteEmailStatus> {
  try {
    const res = await mailer.sendEmail(invite.email, 'admin.invite', {
      url: invite.url,
      role: invite.role,
      invitedBy: invite.invitedBy,
      expiresAt: invite.expiresAt,
    })
    // Only sign-in emails are rate limited per recipient, so 'limited' can't happen here.
    return res.status === 'limited' ? 'failed' : res.status
  } catch (e) {
    if (e instanceof EmailNotConfiguredError) return 'not_configured'
    console.error(`[invite] email failed: ${describeError(e)}`)
    return 'failed'
  }
}
