import type { APIRoute } from 'astro'
import { env } from 'cloudflare:workers'
import { createInvite, isRole } from '../../../../server/auth/roles'
import { inviteUrl, sendInviteEmail } from '../../../../server/auth/invites'
import { HttpError, handle, json, readJson, requireRole } from '../../../../server/http'
import { getServices } from '../../../../server/services'

/**
 * Invite someone: { email, role }. Emails the link and also returns it, so it can be passed on another way if
 * email isn't set up yet (the token is only shown here, once).
 */
export const POST: APIRoute = ({ locals, request }) =>
  handle(async () => {
    const actor = await requireRole(locals.user, 'admin', request, getServices().db)
    const { email, role } = await readJson<{ email: string; role: string }>(request)
    if (typeof email !== 'string' || !isRole(role)) throw new HttpError(400, 'invalid_input', 'Give an email and a role.')
    const { db, mailer } = getServices()
    const invite = await createInvite(db, actor, { email, role })
    const url = inviteUrl(env.SITE_URL, invite.token)
    const emailStatus = await sendInviteEmail(mailer, { ...invite, url, invitedBy: locals.user!.name || locals.user!.email })
    return json({ id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt, url, emailStatus }, 201)
  })
