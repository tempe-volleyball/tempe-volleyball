import { userRoles, type UserRole } from '../server/db/schema/enums'

// The pure role rules (owner > admin > editor), shared by the server (src/server/auth/roles.ts, which enforces
// them against the database) and the admin app (which only uses them to decide what to show).

export { userRoles, type UserRole }

const RANK: Record<UserRole, number> = { owner: 0, admin: 1, editor: 2 }

export const isRole = (value: unknown): value is UserRole => typeof value === 'string' && (userRoles as readonly string[]).includes(value)

/** True if role `a` is strictly above role `b`. */
export const outranks = (a: UserRole, b: UserRole) => RANK[a] < RANK[b]

/** True if `role` is `min` or higher. */
export const atLeast = (role: UserRole, min: UserRole) => RANK[role] <= RANK[min]

/**
 * May `actor` move a user from role `from` (null for a new user, i.e. an invite) to role `to`?
 * Owners may do anything (the last-owner rule is checked separately); everyone else only below their own role,
 * on both ends.
 */
export const canAssign = (actor: UserRole, from: UserRole | null, to: UserRole) =>
  actor === 'owner' || (outranks(actor, to) && (from === null || outranks(actor, from)))

/** May `actor` remove a user whose role is `target`? */
export const canRemove = (actor: UserRole, target: UserRole) => actor === 'owner' || outranks(actor, target)

/** Roles `actor` may hand out (invite to, or change a lower user to). */
export const assignableRoles = (actor: UserRole): UserRole[] => userRoles.filter((r) => canAssign(actor, null, r))

/** Only admins and owners see the Admin users screen and audit log; editors have no one to manage. */
export const canManageUsers = (role: UserRole) => atLeast(role, 'admin')

export const roleLabel: Record<UserRole, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor' }
