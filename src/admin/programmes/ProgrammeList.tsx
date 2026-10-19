import { useEffect, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { slugify } from '../../lib/content/paths'
import { programmePath } from '../../lib/programmes'
import { api, type Me, type ProgrammeChoices, type ProgrammeKind, type ProgrammeListItem, type ProgrammeView } from '../api'
import { Skeleton, Button, Card, Dialog, Field, Notice, Select, StatusBadge, errorMessage } from '../ui'
import { KINDS, WEEKDAY_NAMES } from './kinds'

// The list screen for Training, Development and Events (Leagues use the season-centred list in
// seasons/SeasonList.tsx). Active and draft programmes first; retired ones fold away.

export function ProgrammeList({ me, kind }: { me: Me; kind: ProgrammeKind }) {
  const cfg = KINDS[kind]
  const isAdmin = me.user.role !== 'editor'
  const [rows, setRows] = useState<ProgrammeListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showRetired, setShowRetired] = useState(false)
  useEffect(() => {
    void api<{ programmes: ProgrammeListItem[] }>(`/api/admin/programmes?kind=${kind}`)
      .then((r) => setRows(r.programmes))
      .catch((e) => setError(errorMessage(e)))
  }, [kind])

  const live = rows?.filter((p) => p.status !== 'retired') ?? []
  const retired = rows?.filter((p) => p.status === 'retired') ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{cfg.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-black/60">{cfg.intro}</p>
        </div>
        {isAdmin && <Button onClick={() => setCreating(true)}>New {cfg.noun}</Button>}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      {rows === null && !error && <Skeleton />}
      {rows && rows.length === 0 && (
        <Card>
          <p className="text-sm text-black/60">
            No {cfg.noun}s yet.{isAdmin ? ` Use “New ${cfg.noun}” to add one.` : ''}
          </p>
        </Card>
      )}
      {live.length > 0 && <ProgrammeTable rows={live} kind={kind} />}
      {retired.length > 0 && (
        <div>
          <Button variant="link" onClick={() => setShowRetired((v) => !v)}>
            {showRetired ? 'Hide' : 'Show'} {retired.length} retired
          </Button>
          {showRetired && (
            <div className="mt-3">
              <ProgrammeTable rows={retired} kind={kind} />
            </div>
          )}
        </div>
      )}
      {creating && <NewProgrammeDialog kind={kind} existing={rows ?? []} onCancel={() => setCreating(false)} />}
    </div>
  )
}

function ProgrammeTable({ rows, kind }: { rows: ProgrammeListItem[]; kind: ProgrammeKind }) {
  const cfg = KINDS[kind]
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs text-black/60 uppercase">
              <th className="pr-3 pb-2 font-semibold">Name</th>
              <th className="pr-3 pb-2 font-semibold">Category</th>
              <th className="pr-3 pb-2 font-semibold">When and where</th>
              <th className="pr-3 pb-2 font-semibold">{cfg.instancesTab.label}</th>
              <th className="pr-3 pb-2 font-semibold">Sign-ups</th>
              <th className="pb-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-t border-black/10 align-top">
                <td className="py-2 pr-3">
                  <Link href={`${cfg.base}/${p.id}`} className="text-brand font-semibold underline">
                    {p.name}
                  </Link>
                  <span className="ml-2 text-xs text-black/60">{p.code}</span>
                  <div className="font-mono text-xs text-black/60">{p.path}</div>
                </td>
                <td className="py-2 pr-3">{p.category?.name ?? <span className="text-red-700">None</span>}</td>
                <td className="py-2 pr-3">
                  {p.generated.schedule || '—'}
                  {p.venue && <div className="text-xs text-black/60">{p.venue.name}</div>}
                </td>
                <td className="py-2 pr-3">
                  {p.instances}
                  {p.generated.nextInstanceDate && <div className="text-xs text-black/60">next {p.generated.nextInstanceDate}</div>}
                </td>
                <td className="py-2 pr-3">
                  {p.generated.signupMode === 'interest'
                    ? p.interestOpen
                      ? 'Interest'
                      : 'Interest off'
                    : p.enrolmentOpenNow
                      ? 'Open'
                      : p.enrolmentOpen
                        ? 'Scheduled'
                        : 'Closed'}
                  {p.generated.signupMode === 'interest' && <div className="text-xs text-black/60">expressions of interest</div>}
                </td>
                <td className="py-2">
                  <StatusBadge status={p.status} />
                  {!p.menuVisible && <div className="text-xs text-black/60">hidden from menu</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** The short "new programme" form: just enough to create the draft, then the full editor opens. */
/**
 * The category a new programme starts in: the one most programmes of this kind already use, else the kind's hint
 * (KINDS[kind].categoryHint), else the first category that isn't retired.
 */
export function defaultCategoryId(
  kind: ProgrammeKind,
  categories: ProgrammeChoices['categories'],
  existing: { categoryId: string | null }[] = [],
): string {
  const usable = categories.filter((c) => c.status !== 'retired')
  const uses = new Map<string, number>()
  for (const p of existing) if (p.categoryId) uses.set(p.categoryId, (uses.get(p.categoryId) ?? 0) + 1)
  const mostUsed = usable.filter((c) => uses.has(c.id)).toSorted((a, b) => uses.get(b.id)! - uses.get(a.id)!)[0]
  const hinted = usable.find((c) => c.slug === KINDS[kind].categoryHint)
  return (mostUsed ?? hinted ?? usable[0])?.id ?? ''
}

export function NewProgrammeDialog({
  kind,
  existing,
  onCancel,
}: {
  kind: ProgrammeKind
  /** Programmes of this kind already there, to pick the usual category. */
  existing?: { categoryId: string | null }[]
  onCancel: () => void
}) {
  const cfg = KINDS[kind]
  const [, navigate] = useLocation()
  const [choices, setChoices] = useState<ProgrammeChoices | null>(null)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [categoryId, setCategoryId] = useState('')
  const [weekday, setWeekday] = useState(kind === 'event' ? '6' : '4')
  const [venueId, setVenueId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void api<ProgrammeChoices>('/api/admin/programmes/choices')
      .then((c) => {
        setChoices(c)
        setCategoryId((cur) => cur || defaultCategoryId(kind, c.categories, existing))
      })
      .catch((e) => setError(errorMessage(e)))
    // Only on open: `existing` is a snapshot of the list behind the dialog.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])
  const autoSlug = slugify(kind === 'league' ? code : name)

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const v = await api<ProgrammeView>('/api/admin/programmes', {
        body: {
          kind,
          name,
          code,
          slug: slugEdited ? slug : autoSlug,
          categoryId,
          weekday: Number(weekday),
          defaultVenueId: venueId || null,
        },
      })
      onCancel()
      navigate(`${cfg.base}/${v.programme.id}`)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Dialog title={`New ${cfg.noun}`} onCancel={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        {error && <Notice kind="error">{error}</Notice>}
        <Field label="Name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Code"
            required
            maxLength={16}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            hint="Short and unique: TNL, ADP, CUP."
          />
          <Field
            label="URL name"
            value={slugEdited ? slug : autoSlug}
            onChange={(e) => {
              setSlugEdited(true)
              setSlug(e.target.value)
            }}
            hint={`The page will be ${programmePath(kind, slugEdited ? slug : autoSlug)}`}
          />
        </div>
        <Select label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
          {choices?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.status !== 'active' ? ` (${c.status})` : ''}
            </option>
          ))}
        </Select>
        <div className="grid grid-cols-2 gap-3">
          {cfg.fields.weekday && (
            <Select label="Usual day" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
              {WEEKDAY_NAMES.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </Select>
          )}
          <Select label="Venue" value={venueId} onChange={(e) => setVenueId(e.target.value)}>
            <option value="">None yet</option>
            {choices?.venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-xs text-black/60">It starts as a draft, hidden from the public site until you make it active.</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" busy={busy} disabled={!choices}>
            Create draft
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
