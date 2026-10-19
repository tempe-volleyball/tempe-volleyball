import { useMemo, useState } from 'react'
import { formatWhen, type PreviewPlayer, type RosterSources, type SourceTeam, type TeamInterest } from '../api'
import { Button, Dialog, EmptyState } from '../ui'
import { Badge } from './PlayerPicker'
import { answerLabel, teamMatches } from './roster-helpers'
import { inputClass } from './styles'

// Where a season's teams come from (docs/interest.md "Season rosters"): returning teams (last season, this league's
// earlier seasons, other leagues), each added with the roster it had last time, and team EOIs, added with their
// members. Adding only changes the working copy; the rosters are copied when the season is saved.

const GROUPS: { key: SourceTeam['group']; title: (s: RosterSources) => string }[] = [
  { key: 'last', title: (s) => (s.lastSeason ? `Last season (${s.lastSeason.name})` : 'Last season') },
  { key: 'league', title: () => 'Earlier seasons of this league' },
  { key: 'other', title: () => 'Other leagues' },
]

/** "Ann, Ben, Cat and 5 more" */
export function previewNames(players: readonly PreviewPlayer[], max = 4): string {
  if (players.length === 0) return 'No roster saved'
  const names = players.slice(0, max).map((p) => `${p.name.split(' ')[0]}${p.role === 'captain' ? ' (c)' : ''}`)
  return players.length > max ? `${names.join(', ')} and ${players.length - max} more` : names.join(', ')
}

export function ReturningTeamsDialog({
  sources,
  inSeason,
  onAdd,
  onClose,
}: {
  sources: RosterSources
  inSeason: ReadonlySet<string>
  onAdd: (t: SourceTeam) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const rows = useMemo(() => sources.teams.filter((t) => teamMatches(t.teamName, q)), [sources, q])
  return (
    <Dialog title="Returning teams" onCancel={onClose} wide sheet footer={<CloseFooter onClose={onClose} />}>
      <p className="mb-3 text-sm text-black/70">
        Each team comes with the roster it had last time (retired players and anyone already in a team this season are left out). Rosters
        are copied when you save the season.
      </p>
      <input
        className={inputClass}
        type="search"
        autoFocus
        placeholder="Search teams"
        aria-label="Search teams"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {rows.length === 0 && (
        <div className="mt-3">
          <EmptyState title={q ? 'No team matches that search.' : 'No teams have played yet.'}>
            Close this and type a new team’s name instead.
          </EmptyState>
        </div>
      )}
      {GROUPS.map((g) => {
        const list = rows.filter((t) => t.group === g.key)
        if (list.length === 0) return null
        return (
          <section key={g.key} className="mt-4">
            <h3 className="mb-1 text-sm font-bold">
              {g.title(sources)} <span className="font-normal text-black/60">({list.length})</span>
            </h3>
            <ul className="divide-y divide-black/10 rounded border border-black/10">
              {list.map((t) => {
                const added = inSeason.has(t.teamId)
                return (
                  <li key={t.teamId} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{t.teamName}</span>
                        {t.from.withdrawn && <Badge>Withdrew</Badge>}
                      </span>
                      <span className="block text-xs text-black/60">
                        {t.from.seasonName} · {t.players.length} player{t.players.length === 1 ? '' : 's'}
                        {t.seasons > 1 ? ` · ${t.seasons} seasons` : ''}
                      </span>
                      <span className="block truncate text-xs text-black/60">{previewNames(t.players)}</span>
                    </span>
                    <Button
                      variant="secondary"
                      className="shrink-0 px-3 py-1.5 text-xs"
                      disabled={added}
                      aria-label={added ? `${t.teamName} is in this season` : `Add ${t.teamName}`}
                      onClick={() => onAdd(t)}
                    >
                      {added ? 'Added' : 'Add'}
                    </Button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </Dialog>
  )
}

export function TeamEoisDialog({
  interests,
  inSeason,
  busyId,
  onAdd,
  onClose,
}: {
  interests: TeamInterest[]
  inSeason: ReadonlySet<string>
  /** The interest being added (its team is being created). */
  busyId: string | null
  onAdd: (e: TeamInterest) => void
  onClose: () => void
}) {
  return (
    <Dialog title="Team expressions of interest" onCancel={onClose} wide sheet footer={<CloseFooter onClose={onClose} />}>
      <p className="mb-3 text-sm text-black/70">
        Open team EOIs for this league. Adding one adds the team (creating it if it’s new) with its members as the roster, and marks the EOI
        placed when you save the season.
      </p>
      {interests.length === 0 ? (
        <EmptyState title="No open team EOIs for this league.">Teams that send the expression of interest form show here.</EmptyState>
      ) : (
        <ul className="divide-y divide-black/10 rounded border border-black/10">
          {interests.map((e) => {
            const added = !!e.matchedTeam && inSeason.has(e.matchedTeam.id)
            return (
              <li key={e.interestId} className="flex flex-wrap items-start gap-3 px-3 py-3 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{e.teamName}</span>
                    <span className="text-xs text-black/60">{e.reference}</span>
                    {answerLabel(e.level) && <Badge>{answerLabel(e.level)}</Badge>}
                    <Badge tone={e.matchedTeam ? undefined : 'accent'}>
                      {e.matchedTeam ? `Existing team: ${e.matchedTeam.name}` : 'New team'}
                    </Badge>
                  </span>
                  {e.captain && (
                    <span className="mt-0.5 block text-xs text-black/70">
                      Captain: {e.captain.name}
                      {e.captain.email ? ` · ${e.captain.email}` : ''}
                      {e.captain.phone ? ` · ${e.captain.phone}` : ''}
                    </span>
                  )}
                  <span className="block text-xs text-black/60">
                    {e.members.length} member{e.members.length === 1 ? '' : 's'}: {previewNames(e.members, 6)} · sent{' '}
                    {formatWhen(e.createdAt)}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  className="shrink-0 px-3 py-1.5 text-xs"
                  disabled={added || (busyId !== null && busyId !== e.interestId)}
                  busy={busyId === e.interestId}
                  aria-label={added ? `${e.teamName} is in this season` : `Add team ${e.teamName}`}
                  onClick={() => onAdd(e)}
                >
                  {added ? 'Already in' : 'Add team'}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </Dialog>
  )
}

const CloseFooter = ({ onClose }: { onClose: () => void }) => (
  <div className="flex justify-end">
    <Button onClick={onClose}>Done</Button>
  </div>
)
