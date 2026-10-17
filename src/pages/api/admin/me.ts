import type { APIRoute } from 'astro'
import { assignableRoles, canManageUsers } from '../../../server/auth/roles'
import { mustEnrolTotp } from '../../../server/auth/guard'
import { handle, json, requireRole } from '../../../server/http'
import { getServices } from '../../../server/services'

/** Who is signed in, and what the admin app should offer them. */
export const GET: APIRoute = ({ locals, request }) =>
  handle(async () => {
    await requireRole(locals.user, 'editor', request, getServices().db)
    const u = locals.user!
    return json({
      user: { id: u.id, name: u.name, email: u.email, role: u.role, twoFactorEnabled: !!u.twoFactorEnabled },
      totpRequired: mustEnrolTotp(u),
      canManageUsers: canManageUsers(u.role),
      assignableRoles: assignableRoles(u.role),
    })
  })
