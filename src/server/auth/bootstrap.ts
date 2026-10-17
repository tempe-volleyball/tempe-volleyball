// SQL for scripts/admin-bootstrap.ts: create or promote an owner directly in D1 (there's no one to invite the
// first owner). Pure so it's tested; the script runs it through `wrangler d1 execute`.

const EMAIL_RE = /^[^\s@'"\\;]+@[^\s@'"\\;]+\.[^\s@'"\\;]+$/

export const bootstrapEnvs = ['local', 'staging', 'production'] as const
export type BootstrapEnv = (typeof bootstrapEnvs)[number]

const quote = (s: string) => `'${s.replaceAll("'", "''")}'`

/**
 * Upserts the user as an owner (email verified, so email-code sign-in works) and writes a role.grant audit entry
 * with no actor. Safe to re-run. The email is validated and lower-cased; quotes are rejected outright.
 */
export function bootstrapOwnerSql(rawEmail: string, opts: { now?: Date; id?: string; name?: string } = {}) {
  const email = rawEmail.trim().toLowerCase()
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error(`Not a valid email address: ${rawEmail}`)
  const now = opts.now ?? new Date()
  const ms = now.getTime()
  const iso = now.toISOString()
  const id = opts.id ?? crypto.randomUUID()
  const name = (opts.name ?? email.split('@')[0]!).slice(0, 100)
  return [
    `INSERT INTO "user" (id, name, email, email_verified, role, created_at, updated_at) VALUES (${quote(id)}, ${quote(name)}, ${quote(email)}, 1, 'owner', ${ms}, ${ms})`,
    `  ON CONFLICT(email) DO UPDATE SET role = 'owner', email_verified = 1, updated_at = ${ms};`,
    `INSERT INTO audit_log (id, at, actor_user_id, action, target_type, target_id, before, after, ip)`,
    `  SELECT ${quote(crypto.randomUUID())}, ${quote(iso)}, NULL, 'role.grant', 'user', id, NULL, json_object('role', 'owner', 'email', email, 'via', 'bootstrap'), NULL`,
    `  FROM "user" WHERE email = ${quote(email)};`,
  ].join('\n')
}

/** Arguments for `wrangler d1 execute` against the right database. */
export function wranglerArgs(env: BootstrapEnv, sql: string) {
  const target = env === 'local' ? ['--local'] : ['--env', env, '--remote']
  return ['wrangler', 'd1', 'execute', 'DB', ...target, '--command', sql]
}
