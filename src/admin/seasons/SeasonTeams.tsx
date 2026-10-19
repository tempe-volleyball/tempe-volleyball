import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Settings, Team } from '../../lib/fixtures'
import {
  ApiError,
  api,
  type Directory,
  type RosterChangeResult,
  type RosterFrom,
  type RosterPlayer,
  type RosterSources,
  type RosterView,
  type SourceTeam,
  type TeamInterest,
  type TeamListItem,
  type TeamRoster,
} from '../api'
import { Button, Card, Dialog, LoadError, MoveButtons, Notice, Skeleton, confirmAction, errorMessage, toast } from '../ui'
import { ConfirmDialog } from './dialogs'
import { Badge, PlayerPicker, type NewPlayer } from './PlayerPicker'
import { GENDER_SHORT, addTeams, answerLabel, lastSeasonPlan, pendingRoster, placedMap, type PickerTab } from './roster-helpers'
import { inputClass } from './styles'
import { ReturningTeamsDialog, TeamEoisDialog } from './TeamSources'

// The season's teams and their rosters (Setup → Teams; docs/interest.md "Season rosters", docs/api/rosters.md).
//
// - The team list is part of the season's working copy: adding and removing teams waits for Save, and a published
//   season's list is locked. Teams added from last season, the returning list or a team EOI carry `rosterFrom` in
//   the working copy, and Save copies those rosters in the same batch as the team list.
// - Rosters save straight away (add, remove, move, replace, captain, reorder), on draft, published and archived
//   seasons alike, since they don't change the draw. A team added but not saved yet shows what it will bring.

type Loaded = RosterView & { sources: RosterSources }
type PickerState = { mode: 'add' | 'replace'; teamId: string; replacing?: RosterPlayer; tab?: PickerTab }

export function TeamsCard({
  seasonId,
  savedToken,
  settings: s,
  rosterFrom,
  setTeams,
  locked,
  readOnly,
  canEditRosters,
  onRenamed,
}: {
  seasonId: string
  /** The saved season's updatedAt: rosters reload after a Save. */
  savedToken: string
  settings: Settings
  rosterFrom: Record<string, RosterFrom> | undefined
  setTeams: (teams: Team[], rosterFrom: Record<string, RosterFrom>) => void
  /** Published: the team list is locked (rosters aren't). */
  locked: boolean
  /** Archived: the team list is read-only (rosters aren't). */
  readOnly: boolean
  canEditRosters: boolean
  onRenamed: (t: Team) => void
}) {
  const listLocked = locked || readOnly
  const [all, setAll] = useState<TeamListItem[] | null>(null)
  const [data, setData] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dir, setDir] = useState<Directory | null>(null)
  const [dirError, setDirError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [paste, setPaste] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<Team | null>(null)
  const [ask, setAsk] = useState<{ names: string[]; missing: string[] } | null>(null)
  const [dialog, setDialog] = useState<'returning' | 'eois' | null>(null)
  const [eoiBusy, setEoiBusy] = useState<string | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [pickerBusy, setPickerBusy] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [moving, setMoving] = useState<{ teamId: string; player: RosterPlayer } | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [rowBusy, setRowBusy] = useState<string | null>(null)

  useEffect(() => {
    if (listLocked) return
    void api<{ teams: TeamListItem[] }>('/api/admin/teams')
      .then((r) => setAll(r.teams))
      .catch((e) => setError(errorMessage(e)))
  }, [listLocked])

  // Rosters and team sources: again after every Save (the token is in the URL so a new one refetches).
  const [reloads, setReloads] = useState(0)
  useEffect(() => {
    if (!canEditRosters) return
    let live = true
    api<Loaded>(`/api/admin/seasons/${seasonId}/rosters?v=${encodeURIComponent(savedToken)}&n=${reloads}`)
      .then((d) => {
        if (!live) return
        setData(d)
        setLoadError(null)
      })
      .catch((e) => live && setLoadError(errorMessage(e)))
    return () => {
      live = false
    }
  }, [seasonId, canEditRosters, savedToken, reloads])
  const load = () => {
    setLoadError(null)
    setReloads((n) => n + 1)
  }

  // The picker's player list: fetched when the picker first opens (and again after new players were created).
  const dirLoading = useRef(false)
  const loadDir = useCallback(() => {
    if (dirLoading.current) return
    dirLoading.current = true
    setDirError(null)
    api<Directory>(`/api/admin/seasons/${seasonId}/players`)
      .then(setDir)
      .catch((e) => setDirError(errorMessage(e)))
      .finally(() => {
        dirLoading.current = false
      })
  }, [seasonId])

  const inSeason = useMemo(() => new Set(s.teams.map((t) => t.id)), [s.teams])
  const sources = data?.sources ?? null
  const plan = useMemo(() => lastSeasonPlan(sources, inSeason), [sources, inSeason])
  const savedRosters = useMemo(() => new Map((data?.rosters ?? []).map((r) => [r.teamId, r])), [data])
  const savedTeams = (data?.rosters ?? []).map((r) => ({ id: r.teamId, name: r.teamName }))
  const placed = useMemo(() => placedMap(data?.rosters ?? []), [data])
  const leaving = (data?.rosters ?? []).filter((r) => !inSeason.has(r.teamId) && r.players.length > 0)
  const openEois = (sources?.interests ?? []).filter((e) => !(e.matchedTeam && inSeason.has(e.matchedTeam.id)))

  const add = (list: { team: Team; from: RosterFrom | null }[]) => {
    const r = addTeams(s.teams, rosterFrom, list)
    setTeams(r.teams, r.rosterFrom)
  }
  const fromSource = (teamId: string): RosterFrom | null => {
    const src = sources?.teams.find((t) => t.teamId === teamId)
    return src ? { seasonId: src.from.seasonId } : null
  }

  // ── Adding teams ──
  const addAllLast = async () => {
    if (!plan.season || plan.add.length === 0) return
    const players = plan.add.reduce((n, t) => n + t.players.length, 0)
    const yes = await confirmAction({
      title: `Add ${plan.add.length} team${plan.add.length === 1 ? '' : 's'} from ${plan.season.name}?`,
      body: (
        <>
          <p>
            {plan.add.map((t) => t.teamName).join(', ')}, with their rosters ({players} player{players === 1 ? '' : 's'}). The rosters are
            copied when you save the season.
          </p>
          {plan.withdrawn.length > 0 && (
            <p className="text-black/70">
              Left out because they withdrew: {plan.withdrawn.map((t) => t.teamName).join(', ')}. You can still add them from Returning
              teams.
            </p>
          )}
          {plan.already.length > 0 && <p className="text-black/70">Already in: {plan.already.map((t) => t.teamName).join(', ')}.</p>}
        </>
      ),
      confirmLabel: `Add ${plan.add.length} team${plan.add.length === 1 ? '' : 's'}`,
    })
    if (!yes) return
    add(plan.add.map((t) => ({ team: { id: t.teamId, name: t.teamName }, from: { seasonId: t.from.seasonId } })))
    toast(`Added ${plan.add.length} teams. Save the season to keep them.`)
  }

  const addSource = (t: SourceTeam) => {
    add([{ team: { id: t.teamId, name: t.teamName }, from: { seasonId: t.from.seasonId } }])
    toast(`${t.teamName} added${t.players.length ? ` with ${t.players.length} players` : ''}. Save the season to keep it.`, 'info')
  }

  /** A team that's new: created straight away (or, if someone just made it, theirs). */
  const createTeam = async (n: string): Promise<TeamListItem | null> => {
    try {
      const t = (await api<{ team: TeamListItem }>('/api/admin/teams', { body: { name: n } })).team
      setAll((a) => [...(a ?? []), t].toSorted((x, y) => x.name.localeCompare(y.name)))
      return t
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'team_exists')) throw e
      const fresh = await api<{ teams: TeamListItem[] }>('/api/admin/teams')
      setAll(fresh.teams)
      return fresh.teams.find((x) => x.name.toLowerCase() === n.toLowerCase()) ?? null
    }
  }

  const addEoi = async (e: TeamInterest) => {
    setEoiBusy(e.interestId)
    try {
      const team = e.matchedTeam ?? (await createTeam(e.teamName))
      if (!team) throw new Error(`Couldn’t create the team “${e.teamName}”.`)
      add([{ team: { id: team.id, name: team.name }, from: { interestId: e.interestId } }])
      toast(
        `${team.name} added with ${e.members.length} player${e.members.length === 1 ? '' : 's'} from ${e.reference}. Save the season to keep it.`,
        'info',
      )
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setEoiBusy(null)
    }
  }

  /** Adds teams by name: existing ones by name (any case, with last time's roster), new ones created first. */
  const addNames = async (names: string[], confirmed = false) => {
    setError(null)
    const wanted = [...new Set(names.map((n) => n.trim().replace(/\s+/g, ' ')).filter(Boolean))]
    const have = new Set(s.teams.map((t) => t.name.toLowerCase()))
    const toAdd: Team[] = []
    const missing: string[] = []
    for (const n of wanted) {
      if (have.has(n.toLowerCase())) continue
      const found = (all ?? []).find((t) => t.name.toLowerCase() === n.toLowerCase())
      if (found) toAdd.push({ id: found.id, name: found.name })
      else missing.push(n)
    }
    if (missing.length && !confirmed) {
      setAsk({ names, missing })
      return false
    }
    setBusy(true)
    try {
      const created: Team[] = []
      for (const n of missing) {
        const t = await createTeam(n)
        if (t) created.push({ id: t.id, name: t.name })
      }
      add([...toAdd.map((team) => ({ team, from: fromSource(team.id) })), ...created.map((team) => ({ team, from: null }))])
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const removeTeam = (t: Team) => {
    const next = { ...rosterFrom }
    delete next[t.id]
    setTeams(
      s.teams.filter((x) => x.id !== t.id),
      next,
    )
  }

  // ── Roster changes (saved straight away) ──
  const change = async (
    body: Record<string, unknown>,
    done: (r: RosterChangeResult) => string,
    onError?: (m: string) => void,
  ): Promise<boolean> => {
    try {
      const r = await api<RosterChangeResult>(`/api/admin/seasons/${seasonId}/rosters`, { body })
      setData((d) => (d ? { ...d, ...r } : d))
      // New players aren't in the picker's list yet: fetch it again next time.
      if (r.done.created > 0) setDir(null)
      toast(done(r))
      return true
    } catch (e) {
      if (e instanceof ApiError && e.code === 'already_in_team' && !body.move) {
        const who = (e.details.players ?? []) as { name: string; teamName: string }[]
        const yes = await confirmAction({
          title: who.length === 1 ? `Move ${who[0]!.name}?` : `Move ${who.length} players?`,
          body: (
            <p>
              {who.map((w) => `${w.name} is in ${w.teamName}`).join('; ')}. A player can be in one team per season, so they’d move out of
              their current team.
            </p>
          ),
          confirmLabel: who.length === 1 ? 'Move them' : 'Move them all',
        })
        return yes ? change({ ...body, move: true }, done, onError) : false
      }
      if (onError) onError(errorMessage(e))
      else toast(errorMessage(e), 'error')
      return false
    }
  }
  const rowChange = async (playerId: string, body: Record<string, unknown>, done: (r: RosterChangeResult) => string) => {
    setRowBusy(playerId)
    await change(body, done)
    setRowBusy(null)
  }

  const removePlayer = async (t: Team, p: RosterPlayer) => {
    const yes = await confirmAction({
      title: `Take ${p.firstName} ${p.lastName} out of ${t.name}?`,
      body: p.interest ? `Their expression of interest (${p.interest.reference}) goes back to “contacted”.` : undefined,
      confirmLabel: 'Take them out',
      danger: true,
    })
    if (yes)
      await rowChange(p.playerId, { action: 'remove', teamId: t.id, playerId: p.playerId }, () => `${p.firstName} taken out of ${t.name}.`)
  }

  const openPicker = (p: PickerState) => {
    setPickerError(null)
    setPicker(p)
    if (!dir) loadDir()
  }
  const pickerAdd = async (teamId: string, playerIds: string[], newPlayers: NewPlayer[]) => {
    setPickerBusy(true)
    setPickerError(null)
    const team = savedRosters.get(teamId)?.teamName ?? 'the team'
    const ok = await change(
      { action: 'add', teamId, playerIds, newPlayers },
      (r) =>
        `Added ${r.done.added} player${r.done.added === 1 ? '' : 's'} to ${team}${r.done.moved ? ` (${r.done.moved} moved from other teams)` : ''}.`,
      setPickerError,
    )
    setPickerBusy(false)
    if (ok) setPicker(null)
  }
  const pickerReplace = async (pick: { playerId: string } | { newPlayer: NewPlayer }) => {
    if (!picker?.replacing) return
    setPickerBusy(true)
    setPickerError(null)
    const out = picker.replacing
    const ok = await change(
      {
        action: 'replace',
        teamId: picker.teamId,
        playerId: out.playerId,
        ...('playerId' in pick ? { withPlayerId: pick.playerId } : { newPlayer: pick.newPlayer }),
      },
      () => `Replaced ${out.firstName} ${out.lastName}.`,
      setPickerError,
    )
    setPickerBusy(false)
    if (ok) setPicker(null)
  }

  const toggle = (teamId: string) =>
    setExpanded((x) => {
      const n = new Set(x)
      if (n.has(teamId)) n.delete(teamId)
      else n.add(teamId)
      return n
    })
  const allOpen = s.teams.length > 0 && s.teams.every((t) => expanded.has(t.id))

  return (
    <Card
      id="season-teams"
      title={`Teams (${s.teams.length})`}
      actions={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {s.teams.length > 0 && (
            <Button variant="link" className="text-sm" onClick={() => setExpanded(allOpen ? new Set() : new Set(s.teams.map((t) => t.id)))}>
              {allOpen ? 'Collapse all' : 'Show all rosters'}
            </Button>
          )}
          {canEditRosters && data && data.placed > 0 && (
            <a className="text-brand text-sm underline underline-offset-2" href={`/api/admin/seasons/${seasonId}/rosters.csv`} download>
              Download rosters (CSV)
            </a>
          )}
          {!listLocked && (
            <Button variant="link" className="text-sm" onClick={() => setPaste((p) => (p === null ? '' : null))}>
              {paste === null ? 'Paste a list' : 'Close the list'}
            </Button>
          )}
        </span>
      }
    >
      {(locked || readOnly) && (
        <p className="-mt-2 mb-3 text-sm text-black/60">
          {readOnly ? 'The season is archived, so the team list is read-only.' : 'The team list is locked while the season is published.'}
          {canEditRosters ? ' Rosters can still change.' : ''}
        </p>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {loadError && <LoadError message={loadError} onRetry={load} />}

      {canEditRosters && data && (
        <p className="mb-3 text-sm text-black/70">
          {data.placed} player{data.placed === 1 ? '' : 's'} in teams
          {data.openInterest > 0 && (
            <>
              {' · '}
              <button
                type="button"
                className="text-brand font-semibold underline underline-offset-2 disabled:no-underline disabled:opacity-60"
                disabled={savedTeams.length === 0}
                title={savedTeams.length === 0 ? 'Save the team list first' : undefined}
                onClick={() => openPicker({ mode: 'add', teamId: savedTeams[0]!.id, tab: 'interest' })}
              >
                {data.openInterest} open player EOI{data.openInterest === 1 ? '' : 's'} not placed yet
              </button>
            </>
          )}
        </p>
      )}

      {!listLocked && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            className="text-sm"
            disabled={!data || plan.add.length === 0}
            title={!plan.season ? 'This is the league’s first season.' : plan.add.length === 0 ? 'They’re all in already.' : undefined}
            onClick={() => void addAllLast()}
          >
            Add all of last season’s teams{data ? ` (${plan.add.length})` : ''}
          </Button>
          <Button variant="secondary" className="text-sm" disabled={!data} onClick={() => setDialog('returning')}>
            Returning teams…
          </Button>
          <Button variant="secondary" className="text-sm" disabled={!data} onClick={() => setDialog('eois')}>
            Team EOIs{data ? ` (${openEois.length})` : ''}
          </Button>
        </div>
      )}

      {paste !== null && !listLocked && (
        <div className="mb-4 rounded bg-black/5 p-3">
          <textarea
            className={`${inputClass} h-32 font-mono`}
            placeholder={'One team per line\nHit For Brains\nIce Cold\n…'}
            aria-label="Team names, one per line"
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
          <Button
            className="mt-2"
            busy={busy}
            onClick={() =>
              void addNames(paste.split(/\n|,/)).then((ok) => {
                if (ok) setPaste(null)
              })
            }
          >
            Add teams
          </Button>
        </div>
      )}

      {leaving.length > 0 && (
        <div className="mb-3">
          <Notice kind="warning">
            Saving takes {leaving.map((r) => `${r.teamName} (${r.players.length})`).join(', ')} out of this season, with{' '}
            {leaving.length === 1 ? 'its' : 'their'} roster{leaving.length === 1 ? '' : 's'}.
          </Notice>
        </div>
      )}

      {s.teams.length === 0 && (
        <p className="mb-3 text-sm text-black/60">No teams yet. Add last season’s, pick returning teams, or type a name.</p>
      )}
      <ol className="space-y-1.5">
        {s.teams.map((t, i) => (
          <TeamRow
            key={t.id}
            index={i}
            team={t}
            roster={canEditRosters ? (savedRosters.get(t.id) ?? null) : null}
            loading={canEditRosters && !data && !loadError}
            pending={
              canEditRosters && data && !savedRosters.has(t.id)
                ? (pendingRoster(t.id, rosterFrom?.[t.id], sources) ?? { label: '', players: [] })
                : null
            }
            expanded={expanded.has(t.id)}
            onToggle={() => toggle(t.id)}
            canRename={!readOnly}
            canRemove={!listLocked}
            canEditRosters={canEditRosters}
            otherTeams={savedTeams.length > 1}
            rowBusy={rowBusy}
            onRename={() => setRenaming(t)}
            onRemove={() => removeTeam(t)}
            onAddPlayers={() => openPicker({ mode: 'add', teamId: t.id })}
            onReplace={(p) => openPicker({ mode: 'replace', teamId: t.id, replacing: p })}
            onMove={(p) => setMoving({ teamId: t.id, player: p })}
            onCaptain={(p) =>
              void rowChange(p.playerId, { action: 'captain', teamId: t.id, playerId: p.playerId, captain: p.role !== 'captain' }, () =>
                p.role === 'captain' ? `${p.firstName} is no longer captain.` : `${p.firstName} is captain of ${t.name}.`,
              )
            }
            onRemovePlayer={(p) => void removePlayer(t, p)}
            onReorder={(ids) => void rowChange('order', { action: 'order', teamId: t.id, playerIds: ids }, () => 'Order saved.')}
          />
        ))}
      </ol>

      {!listLocked && (
        <form
          className="mt-3 flex gap-2 sm:w-1/2"
          onSubmit={(e) => {
            e.preventDefault()
            void addNames([name]).then((ok) => {
              if (ok) setName('')
            })
          }}
        >
          <input
            className={inputClass}
            list="season-team-options"
            placeholder={all ? 'New team (or a returning team’s name)' : 'Loading teams…'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Add a team by name"
          />
          <datalist id="season-team-options">
            {(all ?? [])
              .filter((t) => !inSeason.has(t.id))
              .map((t) => (
                <option key={t.id} value={t.name} />
              ))}
          </datalist>
          <Button variant="secondary" type="submit" busy={busy} disabled={!name.trim() || !all}>
            Add
          </Button>
        </form>
      )}

      {dialog === 'returning' && sources && (
        <ReturningTeamsDialog sources={sources} inSeason={inSeason} onAdd={addSource} onClose={() => setDialog(null)} />
      )}
      {dialog === 'eois' && sources && (
        <TeamEoisDialog
          interests={sources.interests}
          inSeason={inSeason}
          busyId={eoiBusy}
          onAdd={(e) => void addEoi(e)}
          onClose={() => setDialog(null)}
        />
      )}
      {picker && (
        <PlayerPicker
          mode={picker.mode}
          teams={savedTeams}
          teamId={picker.teamId}
          replacing={
            picker.replacing
              ? { playerId: picker.replacing.playerId, name: `${picker.replacing.firstName} ${picker.replacing.lastName}` }
              : undefined
          }
          directory={dir}
          directoryError={dirError}
          onRetry={loadDir}
          placed={placed}
          initialTab={picker.tab}
          busy={pickerBusy}
          error={pickerError}
          onCancel={() => setPicker(null)}
          onAdd={(teamId, ids, fresh) => void pickerAdd(teamId, ids, fresh)}
          onReplace={(pick) => void pickerReplace(pick)}
        />
      )}
      {moving && (
        <MoveDialog
          player={moving.player}
          from={savedRosters.get(moving.teamId)?.teamName ?? ''}
          teams={savedTeams.filter((x) => x.id !== moving.teamId)}
          onCancel={() => setMoving(null)}
          onMove={async (toTeamId) => {
            const m = moving
            const to = savedTeams.find((x) => x.id === toTeamId)?.name ?? 'the team'
            const ok = await change(
              { action: 'move', teamId: m.teamId, playerId: m.player.playerId, toTeamId },
              () => `${m.player.firstName} moved to ${to}.`,
            )
            if (ok) setMoving(null)
          }}
        />
      )}
      {ask && (
        <ConfirmDialog
          title={ask.missing.length === 1 ? 'Create a new team?' : `Create ${ask.missing.length} new teams?`}
          confirmLabel={ask.missing.length === 1 ? 'Create team' : 'Create teams'}
          onConfirm={() => {
            const names = ask.names
            setAsk(null)
            void addNames(names, true).then((ok) => {
              if (!ok) return
              setName('')
              setPaste(null)
            })
          }}
          onCancel={() => setAsk(null)}
        >
          <p>{ask.missing.length === 1 ? 'There’s no team with this name yet:' : 'There are no teams with these names yet:'}</p>
          <ul className="list-disc pl-5">
            {ask.missing.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <p className="text-black/60">Check for typos: a returning team should be picked from the list so its history carries over.</p>
        </ConfirmDialog>
      )}
      {renaming && (
        <RenameTeamDialog
          team={renaming}
          onDone={(t) => {
            setRenaming(null)
            if (t) {
              setAll((a) => a?.map((x) => (x.id === t.id ? { ...x, name: t.name } : x)) ?? a)
              setData((d) => (d ? { ...d, rosters: d.rosters.map((r) => (r.teamId === t.id ? { ...r, teamName: t.name } : r)) } : d))
              onRenamed(t)
            }
          }}
        />
      )}
    </Card>
  )
}

// ── One team ──────────────────────────────────────────────────────────────────

function TeamRow({
  index,
  team,
  roster,
  loading,
  pending,
  expanded,
  onToggle,
  canRename,
  canRemove,
  canEditRosters,
  otherTeams,
  rowBusy,
  onRename,
  onRemove,
  onAddPlayers,
  onReplace,
  onMove,
  onCaptain,
  onRemovePlayer,
  onReorder,
}: {
  index: number
  team: Team
  roster: TeamRoster | null
  loading: boolean
  /** Added in the working copy, not saved: what Save will copy (label '' = nothing). */
  pending: { label: string; players: { name: string; role: string }[] } | null
  expanded: boolean
  onToggle: () => void
  canRename: boolean
  canRemove: boolean
  canEditRosters: boolean
  otherTeams: boolean
  rowBusy: string | null
  onRename: () => void
  onRemove: () => void
  onAddPlayers: () => void
  onReplace: (p: RosterPlayer) => void
  onMove: (p: RosterPlayer) => void
  onCaptain: (p: RosterPlayer) => void
  onRemovePlayer: (p: RosterPlayer) => void
  onReorder: (playerIds: string[]) => void
}) {
  const bodyId = useId()
  const captain = roster?.players.find((p) => p.role === 'captain')
  const summary = pending
    ? pending.players.length
      ? `Not saved · ${pending.players.length} to copy`
      : 'Not saved'
    : roster
      ? `${roster.players.length} player${roster.players.length === 1 ? '' : 's'}${captain ? ` · captain ${captain.firstName}` : ''}`
      : ''
  return (
    <li className={`rounded border ${pending ? 'border-accent border-dashed' : 'border-black/10'}`}>
      <div className="flex items-center gap-1.5 pr-1">
        <button
          type="button"
          aria-expanded={canEditRosters ? expanded : undefined}
          aria-controls={canEditRosters ? bodyId : undefined}
          disabled={!canEditRosters}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left hover:bg-black/5 disabled:hover:bg-transparent"
          onClick={onToggle}
        >
          {canEditRosters && (
            <span aria-hidden="true" className={`text-xs text-black/60 transition-transform ${expanded ? 'rotate-90' : ''}`}>
              ▶
            </span>
          )}
          <span className="w-5 shrink-0 text-right text-xs text-black/60">{index + 1}</span>
          <span className="min-w-0 flex-1 sm:flex sm:items-baseline sm:gap-3">
            <span className="block truncate text-sm font-semibold">{team.name}</span>
            {summary && <span className="block truncate text-xs text-black/60">{summary}</span>}
            {roster?.withdrawn && <Badge>Withdrawn</Badge>}
          </span>
        </button>
        {canRename && (
          <button
            type="button"
            className="text-brand px-1.5 py-1 text-xs hover:underline"
            onClick={onRename}
            aria-label={`Rename ${team.name}`}
          >
            Rename
          </button>
        )}
        {canRemove && (
          <button
            type="button"
            aria-label={`Remove ${team.name} from the season`}
            className="rounded px-2 py-1 text-black/60 hover:bg-red-50 hover:text-red-700"
            onClick={onRemove}
          >
            ✕
          </button>
        )}
      </div>
      {canEditRosters && expanded && (
        <div id={bodyId} className="border-t border-black/10 px-2 py-2 sm:px-3">
          {loading ? (
            <Skeleton lines={3} label="Loading the roster…" />
          ) : pending ? (
            <div className="text-sm">
              {pending.players.length > 0 ? (
                <>
                  <p className="text-xs font-semibold text-black/70">{pending.label}:</p>
                  <ul className="mt-1 grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                    {pending.players.map((p, i) => (
                      <li key={i}>
                        {p.name}
                        {p.role === 'captain' && <span className="ml-1.5 text-xs font-bold">(captain)</span>}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-black/70">{pending.label ? `${pending.label}: no players saved.` : 'A team with no roster yet.'}</p>
              )}
              <p className="mt-2 text-xs text-black/60">Save the season to edit this roster.</p>
            </div>
          ) : roster ? (
            <>
              {roster.players.length === 0 ? (
                <p className="py-1 text-sm text-black/60">No players yet.</p>
              ) : (
                <ol className="divide-y divide-black/5">
                  {roster.players.map((p, i) => (
                    <PlayerRow
                      key={p.playerId}
                      player={p}
                      first={i === 0}
                      last={i === roster.players.length - 1}
                      busy={rowBusy === p.playerId || rowBusy === 'order'}
                      otherTeams={otherTeams}
                      onMoveBy={(by) => {
                        const ids = roster.players.map((x) => x.playerId)
                        const [moved] = ids.splice(i, 1)
                        ids.splice(i + by, 0, moved!)
                        onReorder(ids)
                      }}
                      onReplace={() => onReplace(p)}
                      onMove={() => onMove(p)}
                      onCaptain={() => onCaptain(p)}
                      onRemove={() => onRemovePlayer(p)}
                    />
                  ))}
                </ol>
              )}
              <Button variant="secondary" className="mt-2 px-3 py-1.5 text-xs" onClick={onAddPlayers}>
                + Add players
              </Button>
            </>
          ) : (
            <p className="text-sm text-black/60">Save the season to add this team’s players.</p>
          )}
        </div>
      )}
    </li>
  )
}

function PlayerRow({
  player: p,
  first,
  last,
  busy,
  otherTeams,
  onMoveBy,
  onReplace,
  onMove,
  onCaptain,
  onRemove,
}: {
  player: RosterPlayer
  first: boolean
  last: boolean
  busy: boolean
  otherTeams: boolean
  onMoveBy: (by: -1 | 1) => void
  onReplace: () => void
  onMove: () => void
  onCaptain: () => void
  onRemove: () => void
}) {
  const name = `${p.firstName} ${p.lastName}`.trim()
  const level = answerLabel(p.level)
  const position = answerLabel(p.position)
  return (
    <li className={`flex items-center gap-1 py-1 ${busy ? 'opacity-60' : ''}`} aria-busy={busy || undefined}>
      <MoveButtons name={name} first={first} last={last} disabled={busy} onMove={onMoveBy} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="font-semibold">{name}</span>
          {p.role === 'captain' && (
            <span className="bg-ink rounded px-1.5 py-0.5 text-[0.7rem] leading-tight font-bold text-white" title="Captain">
              C<span className="sr-only">aptain</span>
            </span>
          )}
          {p.gender && <span className="text-xs text-black/60">{GENDER_SHORT[p.gender]}</span>}
          {level && <Badge>{level}</Badge>}
          {position && <Badge>{position}</Badge>}
          {p.retired && <Badge>Retired</Badge>}
        </span>
        <span className="block truncate text-xs text-black/60">
          {[p.email || null, p.phone, p.interest ? p.interest.reference : p.fromSeason ? `from ${p.fromSeason.name}` : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <PlayerMenu
        name={name}
        disabled={busy}
        items={[
          { label: p.role === 'captain' ? 'Not captain' : 'Make captain', onSelect: onCaptain },
          { label: 'Replace…', onSelect: onReplace },
          ...(otherTeams ? [{ label: 'Move to another team…', onSelect: onMove }] : []),
          { label: 'Take out of the team', onSelect: onRemove, danger: true },
        ]}
      />
    </li>
  )
}

/** A small "⋯" actions menu: ↑/↓ between items, Escape closes and returns focus, a click outside closes. */
function PlayerMenu({
  name,
  items,
  disabled,
}: {
  name: string
  items: { label: string; onSelect: () => void; danger?: boolean }[]
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const close = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  const focusItem = (by: number) => {
    const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    list[(i + by + list.length) % list.length]?.focus()
  }
  return (
    <span className="relative shrink-0">
      <button
        ref={button}
        type="button"
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        className="flex h-8 w-9 items-center justify-center rounded text-lg leading-none text-black/70 hover:bg-black/5 disabled:opacity-40 pointer-coarse:h-11 pointer-coarse:w-11"
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={`Actions for ${name}`}
          className="absolute right-0 z-20 mt-1 w-56 rounded border border-black/10 bg-white py-1 shadow-lg"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
              button.current?.focus()
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              focusItem(e.key === 'ArrowDown' ? 1 : -1)
            } else if (e.key === 'Tab') setOpen(false)
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`block w-full px-3 py-2 text-left text-sm hover:bg-black/5 focus:bg-black/5 focus:outline-none ${it.danger ? 'text-red-700' : ''}`}
              onClick={() => {
                setOpen(false)
                it.onSelect()
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

function MoveDialog({
  player,
  from,
  teams,
  onCancel,
  onMove,
}: {
  player: RosterPlayer
  from: string
  teams: { id: string; name: string }[]
  onCancel: () => void
  onMove: (teamId: string) => Promise<void>
}) {
  const [to, setTo] = useState(teams[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title={`Move ${player.firstName} ${player.lastName}`} onCancel={onCancel} dirty={false}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          setBusy(true)
          void onMove(to).finally(() => setBusy(false))
        }}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-semibold">From {from} to</span>
          <select className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} autoFocus>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {player.role === 'captain' && <p className="text-xs text-black/60">They stay captain if the new team doesn’t have one.</p>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!to}>
            Move
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function RenameTeamDialog({ team, onDone }: { team: Team; onDone: (t: Team | null) => void }) {
  const [name, setName] = useState(team.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ team: TeamListItem }>(`/api/admin/teams/${team.id}`, { method: 'PATCH', body: { name: name.trim() } })
      onDone({ id: r.team.id, name: r.team.name })
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog title={`Rename ${team.name}`} onCancel={() => onDone(null)}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          autoFocus
          aria-label="New name"
        />
        <p className="text-xs text-black/60">
          The new name shows everywhere straight away: ladders, fixtures and past seasons. It doesn't wait for Save.
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!name.trim() || name.trim() === team.name}>
            Rename
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
