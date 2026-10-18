import { useCallback, useEffect, useState } from 'react'
import { Link } from 'wouter'
import { api, formatWhen, type AuditRow, type Me } from '../api'
import { Button, Card, EmailText, Notice, errorMessage } from '../ui'

// The audit log, newest first, 50 at a time.

export const ACTIONS: Record<string, string> = {
  'role.grant': 'Promoted',
  'role.revoke': 'Demoted',
  'invite.create': 'Invited',
  'invite.revoke': 'Cancelled invite',
  'invite.accept': 'Accepted invite',
  'user.remove': 'Removed user',
  'page.publish': 'Published page',
  'page.unpublish': 'Unpublished page',
  'page.delete': 'Deleted page',
  'post.publish': 'Published post',
  'post.unpublish': 'Unpublished post',
  'post.delete': 'Deleted post',
  'media.delete': 'Deleted file',
  'menu.update': 'Changed menu',
  'settings.update': 'Changed setting',
  'season.create': 'Created season',
  'season.update': 'Changed season settings',
  'season.draw_save': 'Saved draw',
  'season.teams': 'Changed season teams',
  'season.publish': 'Published season',
  'season.unpublish': 'Unpublished season',
  'season.archive': 'Archived season',
  'season.unarchive': 'Unarchived season',
  'season.delete': 'Deleted season',
  'results.publish': 'Published results',
  'match.status': 'Changed game status',
  'match.update': 'Changed game referee',
  'match.move': 'Moved game to another night',
  'match.move_undo': 'Moved game back',
  'team.merge': 'Merged teams',
  'team.merge_undo': 'Undid team merge',
  'import.fix': 'Tidied imported data',
  'ladder.adjust': 'Adjusted ladder',
  'team.create': 'Created team',
  'team.rename': 'Renamed team',
  'team.withdraw': 'Withdrew team',
  'team.reinstate': 'Reinstated team',
  'match_day.postpone': 'Postponed night',
  'match_day.cancel': 'Cancelled night',
  'match_day.restore': 'Restored night',
  'season.push_back': 'Pushed season back',
  'fixtures.import': 'Imported fixtures (CSV)',
}

/** A merge can be undone from Admin → Teams for 30 days (the screen says whether this one still can). */
const UndoLink = ({ row, now }: { row: AuditRow; now: number }) =>
  row.action === 'team.merge' && now - Date.parse(row.at) < 30 * 86_400_000 ? (
    <Link href="/teams#merges" className="text-brand ml-2 text-xs underline">
      Undo on Teams
    </Link>
  ) : null

const lengthOf = (v: unknown) => (Array.isArray(v) ? v.length : 0)

const who = (r: AuditRow) => r.actorEmail ?? (r.actorUserId ? 'Removed user' : 'System')

export const describe = (row: AuditRow) => {
  const before = (row.before ?? {}) as Record<string, unknown>
  const after = (row.after ?? {}) as Record<string, unknown>
  const email = (after.email ?? before.email ?? '') as string
  if (row.action === 'role.grant' || row.action === 'role.revoke')
    return before.role ? `${email}: ${String(before.role)} → ${String(after.role ?? 'none')}` : `${email} made ${String(after.role ?? '?')}`
  if (row.action.startsWith('invite.')) return `${email}${after.role || before.role ? ` as ${String(after.role ?? before.role)}` : ''}`
  if (row.action === 'user.remove') return `${email} (${String(before.role ?? '')})`
  if (row.action.startsWith('page.')) return `${String(after.title ?? before.title ?? '')} (${String(after.path ?? before.path ?? '')})`
  if (row.action.startsWith('post.'))
    return `${String(after.title ?? before.title ?? '')} (/news/${String(after.slug ?? before.slug ?? '')})`
  if (row.action === 'media.delete') return String(before.filename ?? row.targetId ?? '')
  if (row.action === 'menu.update') return `${String(before.items ?? 0)} → ${String(after.items ?? 0)} items`
  if (row.action === 'settings.update') return row.targetId ?? ''
  if (row.action === 'season.teams') {
    const count = (v: unknown) => (Array.isArray(v) ? v.length : '?')
    return `${count(before.teams)} → ${count(after.teamIds)} teams`
  }
  if (row.action.startsWith('match_day.') || row.action === 'season.push_back')
    return `${String(after.season ?? before.season ?? '')} match day ${String(after.matchDay ?? before.matchDay ?? '')} (${String(after.date ?? before.date ?? '')})${after.note ? `: ${String(after.note)}` : ''}`
  if (row.action === 'team.withdraw' || row.action === 'team.reinstate')
    return `${String(after.team ?? before.team ?? '')}, ${String(after.season ?? before.season ?? '')}${after.reason ? `: ${String(after.reason)}` : ''}`
  if (row.action === 'fixtures.import') return `${String(after.matchDays ?? 0)} match days, ${String(after.matches ?? 0)} games`
  if (row.action.startsWith('season.')) {
    const name = String(after.name ?? before.name ?? '')
    if (row.action === 'season.update' && Array.isArray(after.changed))
      return `${name}: ${(after.changed as string[]).join(', ') || 'no changes'}`
    if (row.action === 'season.draw_save')
      return `${String(after.matchDays ?? 0)} match days, ${String(after.matches ?? 0)} games${after.courtsOnly ? ' (courts only)' : ''}`
    return name || (row.targetId ?? '')
  }
  if (row.action === 'results.publish')
    return `${String(after.season ?? '')} match day ${String(after.matchDay ?? '')} (${String(after.date ?? '')})`
  if (row.action === 'match.status')
    return `${String(after.season ?? '')} ${String(after.date ?? '')}: ${String(before.status ?? '?')} → ${String(after.status ?? '?')}`
  if (row.action === 'match.update')
    return `${String(after.season ?? '')} ${String(after.date ?? '')}: referee ${String(before.referee ?? 'none')} → ${String(after.referee ?? 'none')}`
  if (row.action === 'match.move' || row.action === 'match.move_undo')
    return `${String(after.season ?? '')} ${String(after.game ?? '')}: ${String(before.date ?? '?')} → ${String(after.date ?? '?')}`
  if (row.action === 'team.merge') return `${String(before.name ?? '?')} merged into ${String(after.name ?? '?')}`
  if (row.action === 'team.merge_undo') return `${String(after.name ?? '?')} split from ${String(before.name ?? '?')} again`
  if (row.action === 'import.fix') {
    const n = lengthOf
    return `${n(before.seasonsWithoutKey)} imported seasons' draw keys, ${n(before.placeholderTeams)} placeholder teams removed`
  }
  if (row.action === 'team.create') return String(after.name ?? '')
  if (row.action === 'team.rename') return `${String(before.name ?? '?')} → ${String(after.name ?? '?')}`
  return row.targetType ? `${row.targetType} ${row.targetId ?? ''}` : ''
}

export function Audit({ me }: { me: Me }) {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now] = useState(() => Date.now())

  const fetchPage = useCallback(
    (before?: string) =>
      api<{ entries: AuditRow[]; next: string | null }>(`/api/admin/audit?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`)
        .then((res) => {
          setRows((r) => (before ? [...r, ...res.entries] : res.entries))
          setNext(res.next)
        })
        .catch((e) => setError(errorMessage(e)))
        .finally(() => setLoading(false)),
    [],
  )
  useEffect(() => {
    void fetchPage()
  }, [fetchPage])

  const load = (before: string) => {
    setLoading(true)
    void fetchPage(before)
  }

  if (!me.canManageUsers) return <Notice kind="error">Only admins and owners can see the audit log.</Notice>

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Audit log</h1>
      {error && <Notice kind="error">{error}</Notice>}
      <Card>
        {rows.length === 0 && !loading ? (
          <p className="text-sm text-black/60">Nothing yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-black/60 uppercase">
                  <th className="hidden pr-3 pb-2 font-semibold sm:table-cell">When</th>
                  <th className="hidden pr-3 pb-2 font-semibold sm:table-cell">Who</th>
                  <th className="pr-3 pb-2 font-semibold">What</th>
                  <th className="hidden pb-2 font-semibold sm:table-cell">Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-black/10 align-top">
                    <td className="hidden py-2 pr-3 whitespace-nowrap sm:table-cell">{formatWhen(r.at)}</td>
                    <td className="hidden py-2 pr-3 sm:table-cell">{r.actorEmail ? <EmailText email={r.actorEmail} /> : who(r)}</td>
                    <td className="py-2 pr-3 sm:whitespace-nowrap">
                      <span className="font-semibold sm:font-normal">{ACTIONS[r.action] ?? r.action}</span>
                      {/* Phones: one stacked entry (what, details, then when and who) instead of four narrow columns. */}
                      <span className="block break-words sm:hidden">
                        {describe(r)}
                        <UndoLink row={r} now={now} />
                      </span>
                      <span className="block text-xs text-black/60 sm:hidden">
                        {formatWhen(r.at)} · {who(r)}
                        {r.ip && ` · ${r.ip}`}
                      </span>
                    </td>
                    <td className="hidden py-2 break-all sm:table-cell">
                      {describe(r)}
                      <UndoLink row={r} now={now} />
                      {r.ip && <span className="ml-2 text-xs text-black/60">{r.ip}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next && (
          <div className="mt-4">
            <Button variant="secondary" onClick={() => load(next)} busy={loading}>
              Load more
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}
