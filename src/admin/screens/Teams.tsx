import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { duplicateGroups, shareASeason, teamKey } from '../../lib/teams'
import { api, type Me, type PurgeResult, type TeamListItem } from '../api'
import { Button, Card, Dialog, Notice, errorMessage, purgeNote } from '../ui'

// Admin → Teams (docs/admin.md §1 "Teams and rollover"): every team across leagues, with the seasons each played,
// search, rename, new team, and merging duplicates (a duplicate's seasons, games, adjustments and enrolment groups move
// to the team kept, in one audited batch). Teams that look alike and never shared a season are suggested for merging.

const seasonsText = (n: number) => `${n} season${n === 1 ? '' : 's'}`

const inputClass = 'focus:border-brand rounded border border-black/20 bg-white px-3 py-2 text-sm outline-none'

export function Teams({ me }: { me: Me }) {
  const isAdmin = me.user.role !== 'editor'
  const [teams, setTeams] = useState<TeamListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<TeamListItem | null>(null)
  const [merging, setMerging] = useState<{ keep?: TeamListItem; merge: TeamListItem } | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(
    () =>
      api<{ teams: TeamListItem[] }>('/api/admin/teams')
        .then((r) => setTeams(r.teams))
        .catch((e: unknown) => setError(errorMessage(e))),
    [],
  )
  useEffect(() => {
    void load()
  }, [load])

  const shown = useMemo(() => {
    const q = teamKey(query)
    return (teams ?? []).filter((t) => !q || teamKey(t.name).includes(q))
  }, [teams, query])
  const dupes = useMemo(() => duplicateGroups(teams ?? []), [teams])

  const done = (text: string) => {
    setMessage(text)
    setError(null)
    void load()
  }

  if (!teams) return error ? <Notice kind="error">{error}</Notice> : <p className="text-sm text-black/60">Loading…</p>

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Teams</h1>
        <span className="text-sm text-black/60">{teams.length} teams across every league</span>
        {isAdmin && (
          <Button className="ml-auto" onClick={() => setAdding(true)}>
            New team
          </Button>
        )}
      </div>
      <p className="text-sm text-black/60">
        Teams carry over from season to season. A season’s team list is on its Setup tab; this is every team there has ever been. Renaming
        changes the name everywhere, past seasons included.
      </p>
      {message && <Notice kind="success">{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}

      {isAdmin && dupes.length > 0 && (
        <Card title="Possible duplicates">
          <p className="-mt-2 mb-3 text-sm text-black/60">
            These names look like the same team, and they never played in the same season. Merge them if they are.
          </p>
          <ul className="space-y-2 text-sm">
            {dupes.map(([keep, ...rest]) => (
              <li key={keep!.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold">{keep!.name}</span>
                <span className="text-black/60">({seasonsText(keep!.seasons)})</span>
                {rest.map((t) => (
                  <span key={t.id} className="flex items-center gap-1">
                    and {t.name} <span className="text-black/60">({seasonsText(t.seasons)})</span>
                    <Button variant="link" onClick={() => setMerging({ keep, merge: t })}>
                      Merge into {keep!.name}
                    </Button>
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <input
        className={`${inputClass} w-full sm:w-80`}
        type="search"
        placeholder="Search teams"
        aria-label="Search teams"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <Card>
        {shown.length === 0 ? (
          <p className="text-sm text-black/60">No teams match.</p>
        ) : (
          <ul className="divide-y divide-black/10">
            {shown.map((t) => (
              <li key={t.id} className="py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <button
                    type="button"
                    className="text-left font-semibold hover:underline"
                    aria-expanded={open === t.id}
                    onClick={() => setOpen((o) => (o === t.id ? null : t.id))}
                  >
                    {t.name}
                  </button>
                  <span className="text-xs text-black/60">
                    {t.seasons === 0 ? 'No seasons yet' : `${t.seasons} season${t.seasons === 1 ? '' : 's'}`}
                    {t.lastSeason ? ` · last ${t.lastSeason.name}` : ''}
                  </span>
                  {isAdmin && (
                    <span className="ml-auto flex gap-3">
                      <Button variant="link" onClick={() => setRenaming(t)}>
                        Rename
                      </Button>
                      <Button variant="link" onClick={() => setMerging({ merge: t })}>
                        Merge into…
                      </Button>
                    </span>
                  )}
                </div>
                {open === t.id && (
                  <ul className="mt-2 ml-1 space-y-0.5 text-sm">
                    {t.history.length === 0 && <li className="text-black/60">Not in any season yet.</li>}
                    {t.history.map((h) => (
                      <li key={h.id} className="flex flex-wrap gap-x-2">
                        <Link href={`/seasons/${h.id}`} className="text-brand underline">
                          {h.name}
                        </Link>
                        <span className="text-black/60">
                          {h.leagueCode} · {h.status}
                          {h.withdrawnAt ? ' · withdrew' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {renaming && (
        <RenameDialog
          team={renaming}
          onDone={(name, cache) => {
            setRenaming(null)
            done(`Renamed to ${name} everywhere.${purgeNote(cache)}`)
          }}
          onCancel={() => setRenaming(null)}
        />
      )}
      {adding && (
        <RenameDialog
          onDone={(name) => {
            setAdding(false)
            done(`Added ${name}. Put it in a season from the season’s Setup tab.`)
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {merging && (
        <MergeDialog
          teams={teams}
          merge={merging.merge}
          keep={merging.keep}
          onDone={(r) => {
            setMerging(null)
            done(`Merged ${r.merged.name} into ${r.team.name}: ${seasonsText(r.seasons)} now.${purgeNote(r.cache)}`)
          }}
          onCancel={() => setMerging(null)}
        />
      )}
    </div>
  )
}

/** Renames a team, or (without `team`) creates one. */
function RenameDialog({
  team,
  onDone,
  onCancel,
}: {
  team?: TeamListItem
  onDone: (name: string, cache?: PurgeResult) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(team?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      if (team) {
        const r = await api<{ team: { name: string }; cache: PurgeResult }>(`/api/admin/teams/${team.id}`, {
          method: 'PATCH',
          body: { name },
        })
        onDone(r.team.name, r.cache)
      } else {
        const r = await api<{ team: { name: string } }>('/api/admin/teams', { body: { name } })
        onDone(r.team.name)
      }
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog title={team ? `Rename ${team.name}` : 'New team'} onCancel={onCancel}>
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) void save()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <label className="block">
          <span className="mb-1 block font-semibold">Name</span>
          <input className={`${inputClass} w-full`} maxLength={80} value={name} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        {team && (
          <p className="text-black/60">The name changes on every ladder and fixture list, past seasons included. Its web address stays.</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!name.trim() || name.trim() === team?.name}>
            {team ? 'Rename' : 'Add team'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

type MergeDone = { team: { id: string; name: string }; merged: { id: string; name: string }; seasons: number; cache?: PurgeResult }

/** Merges `merge` into the team picked (or `keep`). */
function MergeDialog({
  teams,
  merge,
  keep: initial,
  onDone,
  onCancel,
}: {
  teams: TeamListItem[]
  merge: TeamListItem
  keep?: TeamListItem
  onDone: (r: MergeDone) => void
  onCancel: () => void
}) {
  const [keepId, setKeepId] = useState(initial?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const options = teams.filter((t) => t.id !== merge.id)
  const keep = teams.find((t) => t.id === keepId)
  const clash = keep ? shareASeason(keep, merge) : false
  const go = async () => {
    if (!keep) return
    setBusy(true)
    setError(null)
    try {
      onDone(await api<MergeDone>(`/api/admin/teams/${keep.id}/merge`, { body: { mergeId: merge.id } }))
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog title={`Merge ${merge.name}`} onCancel={onCancel}>
      <div className="space-y-3 text-sm">
        {error && <Notice kind="error">{error}</Notice>}
        <label className="block">
          <span className="mb-1 block font-semibold">Into</span>
          <select className={`${inputClass} w-full`} value={keepId} onChange={(e) => setKeepId(e.target.value)}>
            <option value="">Pick the team to keep…</option>
            {options.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.seasons} season{t.seasons === 1 ? '' : 's'})
              </option>
            ))}
          </select>
        </label>
        {keep && clash && (
          <Notice kind="error">
            {keep.name} and {merge.name} both played in the same season, so they’re different teams. Rename one instead.
          </Notice>
        )}
        {keep && !clash && (
          <p>
            {merge.name}’s {merge.seasons} season{merge.seasons === 1 ? '' : 's'} ({merge.history.map((h) => h.name).join(', ') || 'none'}),
            its games, duties, ladder adjustments and enrolment groups move to <strong>{keep.name}</strong>, which keeps its name and web
            address. {merge.name} is then deleted, and its calendar feeds redirect to {keep.name}’s. This can’t be undone (it’s in the audit
            log).
          </p>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" busy={busy} disabled={!keep || clash} onClick={() => void go()}>
          Merge
        </Button>
      </div>
    </Dialog>
  )
}
