import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import {
  ALL_TABS,
  isOffStatus,
  landingTab,
  publishWeekResults,
  setResult,
  shapeKey,
  undoWeekResultChanges,
  weekdayName,
  type Issue,
  type Result,
  type Tab,
  type Team,
  type Week,
} from '../../lib/fixtures'
import {
  api,
  isConflict,
  ApiError,
  formatWhen,
  type AdjustmentRow,
  type Me,
  type MatchDayState,
  type PurgeResult,
  type SaveDrawResult,
  type SeasonView,
} from '../api'
import { setLeaveBlocker, leaveTo } from '../leave-guard'
import { useUnsavedWarning } from '../screens/Pages'
import { Button, Notice, StatusBadge, errorMessage, purgeNote } from '../ui'
import { generateInWorker, newSeed } from './browser'
import { ConfirmDialog, LeaveDialog } from './dialogs'
import { GameStatusDialog, NightDialog, WithdrawDialog, type NightChoice } from './NightDialogs'
import { isEmptyPlan, planSave, type Draft } from './draft'
import { FixturesTab, IssueList } from './FixturesTab'
import { ForfeitDialog, MoveGameDialog } from './GameDialogs'
import { PublishTab, WebsiteTab } from './PublishTab'
import { changedResults } from './results-form'
import { ResultsTab, type DayEdit, type GameStatus, type ResultsActions } from './ResultsTab'
import { SetupTab } from './SetupTab'

// One season: /admin/seasons/<id>/<tab>. Ported from the demo's App + CompetitionPage, with the API in place of
// localStorage. The season (settings, teams, draw) is edited as a working copy and saved with an explicit Save;
// results are saved per match day. Every write sends the baseUpdatedAt it was based on, and a 409 means someone else
// saved first: we say so and offer a reload. Editors only get the Results tab (the server enforces roles anyway).

type TabDef = { id: Tab; label: string }

// Before publishing: a step-by-step flow. After: day-to-day running of the season.
const DRAFT_TABS: TabDef[] = [
  { id: 'setup', label: '1 · Setup' },
  { id: 'fixtures', label: '2 · Fixtures' },
  { id: 'publish', label: '3 · Publish' },
]
const PUBLISHED_TABS: TabDef[] = [
  { id: 'results', label: 'Results' },
  { id: 'fixtures', label: 'Fixtures' },
  { id: 'setup', label: 'Settings' },
  { id: 'website', label: 'Website' },
]
const EDITOR_TABS: TabDef[] = [{ id: 'results', label: 'Results' }]

type Confirm = 'unpublish' | 'archive' | 'unarchive' | 'delete' | 'discard'
type Problem = { message: string; issues: Issue[] }

const draftOf = (v: SeasonView): Draft => ({ competition: v.competition, setsPerMatch: v.season.setsPerMatch })
const cancelledIds = (v: SeasonView) =>
  new Set(
    Object.entries(v.matches)
      .filter(([, m]) => m.status === 'cancelled')
      .map(([mid]) => mid),
  )

export function SeasonPage({ me, id, tab: requested }: { me: Me; id: string; tab: string | undefined }) {
  const [, navigate] = useLocation()
  const isAdmin = me.user.role !== 'editor'
  const [view, setView] = useState<SeasonView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** The unsaved working copy of the season; null when there's nothing unsaved. */
  const [draft, setDraft] = useState<Draft | null>(null)
  /** Unsaved results, by match day. */
  const [edits, setEdits] = useState<Record<string, DayEdit>>({})
  const [resets, setResets] = useState<Record<string, number> & { all: number }>({ all: 0 })
  const [busy, setBusy] = useState<'save' | 'status' | 'generate' | 'delete' | null>(null)
  const [busyDay, setBusyDay] = useState<string | null>(null)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [leavingTo, setLeavingTo] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  /** A question to ask before going ahead. */
  const [pending, setPending] = useState<
    | { kind: 'status'; weekId: string; gameId: string; status: 'cancelled' | 'postponed' | 'tbd' }
    | { kind: 'forfeit'; weekId: string; gameId: string }
    | { kind: 'move'; weekId: string; gameId: string }
    | { kind: 'undoMove'; gameId: string }
    | { kind: 'regenerate' }
    | { kind: 'night'; weekId: string }
    | { kind: 'restore'; weekId: string }
    | { kind: 'withdraw' }
    | { kind: 'reinstate'; teamId: string }
    | null
  >(null)

  const load = useCallback(async () => {
    const v = await api<SeasonView>(`/api/admin/seasons/${id}`)
    setView(v)
    return v
  }, [id])
  // App keys this screen by season id, so a different season starts from fresh state.
  useEffect(() => {
    let live = true
    api<SeasonView>(`/api/admin/seasons/${id}`)
      .then((v) => live && setView(v))
      .catch((e: unknown) => live && setLoadError(errorMessage(e)))
    return () => {
      live = false
    }
  }, [id])

  const saved = view ? draftOf(view) : null
  const working = draft ?? saved
  const seasonDirty = !!(saved && draft && !isEmptyPlan(planSave(saved, draft)))
  const resultsDirty = Object.keys(edits).length > 0
  const dirty = seasonDirty || resultsDirty

  // ── Unsaved-changes guard: in-app links, the back button (leave-guard.ts) and closing the tab ──
  const dirtyRef = useRef(false)
  useLayoutEffect(() => {
    dirtyRef.current = dirty
  })
  useEffect(() => {
    const here = new RegExp(`^/admin/seasons/${id}(/|$|\\?)`)
    setLeaveBlocker((to) => {
      if (!dirtyRef.current || here.test(to)) return false
      setLeavingTo(to)
      return true
    })
    return () => setLeaveBlocker(null)
  }, [id])
  useUnsavedWarning(dirty)

  const fail = (e: unknown) => {
    if (isConflict(e)) setConflict(true)
    else setProblem({ message: errorMessage(e), issues: e instanceof ApiError ? e.issues : [] })
  }
  const start = () => {
    setProblem(null)
    setMessage(null)
  }

  const reload = async () => {
    setConflict(false)
    setDraft(null)
    setEdits({})
    setResets((r) => ({ ...r, all: r.all + 1 }))
    start()
    await load().catch((e) => setLoadError(errorMessage(e)))
  }

  // ── Saving the season: team list, then the draw (with settings) or the settings alone ──
  const saveSeason = async (): Promise<SeasonView | null> => {
    if (!view || !saved || !draft) return view
    const plan = planSave(saved, draft)
    if (isEmptyPlan(plan)) {
      setDraft(null)
      return view
    }
    setBusy('save')
    start()
    const c = draft.competition
    let token = view.season.updatedAt
    let steps = 0
    let cache: PurgeResult | undefined
    let warnings: Issue[] = []
    try {
      if (plan.teamIds) {
        token = (
          await api<SeasonView>(`/api/admin/seasons/${id}/teams`, { method: 'PUT', body: { baseUpdatedAt: token, teamIds: plan.teamIds } })
        ).season.updatedAt
        steps++
      }
      if (plan.draw) {
        const r = await api<SaveDrawResult & { cache: PurgeResult }>(`/api/admin/seasons/${id}/draw`, {
          method: 'PUT',
          body: {
            baseUpdatedAt: token,
            weeks: c.weeks,
            generatedFrom: c.generatedFrom ?? null,
            edited: c.edited,
            ...(plan.settings ? { settings: plan.settings } : {}),
            ...(draft.source ? { source: draft.source } : {}),
          },
        })
        warnings = r.issues.filter((i) => i.level === 'warning')
        cache = r.cache
      } else if (plan.settings) {
        cache = (
          await api<SeasonView & { cache: PurgeResult }>(`/api/admin/seasons/${id}`, {
            method: 'PATCH',
            body: { baseUpdatedAt: token, settings: plan.settings },
          })
        ).cache
      }
      const fresh = await load()
      setDraft(null)
      setMessage(
        `Saved${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''} to check on the Fixtures tab)` : ''}.${purgeNote(cache)}`,
      )
      return fresh
    } catch (e) {
      fail(e)
      // The team list may have saved before the draw failed: pick up the new token, keep the working copy.
      if (steps > 0 && !isConflict(e)) await load().catch(() => undefined)
      return null
    } finally {
      setBusy(null)
    }
  }

  // ── Results, per match day ──
  const savedWeek = (weekId: string) => view?.competition.weeks?.find((w) => w.id === weekId)

  /** Updates one match day in the view: its token, and its weeks via `fn`. */
  const applyDay = (weekId: string, day: MatchDayState, fn: (weeks: Week[]) => Week[] = (w) => w) =>
    setView((v) =>
      v && v.competition.weeks
        ? {
            ...v,
            competition: { ...v.competition, weeks: fn(v.competition.weeks) },
            matchDays: { ...v.matchDays, [weekId]: { updatedAt: day.updatedAt, resultsPublishedAt: day.resultsPublishedAt } },
          }
        : v,
    )

  const dropEdit = (weekId: string) =>
    setEdits((all) => {
      const next = { ...all }
      delete next[weekId]
      return next
    })
  const resetDay = (weekId: string) => setResets((r) => ({ ...r, [weekId]: (r[weekId] ?? 0) + 1 }))

  /** Saves a day's unsaved results (if any) and returns the day's new token. */
  const saveDay = async (weekId: string): Promise<string> => {
    const token = view!.matchDays[weekId]!.updatedAt
    const e = edits[weekId]
    const before = savedWeek(weekId)
    if (!e || !before) return token
    const results = changedResults(before, e.week)
    if (Object.keys(results).length === 0) {
      dropEdit(weekId)
      return token
    }
    const r = await api<{ matchDay: MatchDayState }>(`/api/admin/seasons/${id}/match-days/${weekId}/results`, {
      method: 'PUT',
      body: { baseUpdatedAt: token, results },
    })
    const typed = new Map(e.week.games.map((g) => [g.id, g.result]))
    applyDay(weekId, r.matchDay, (weeks) =>
      weeks.map((w) => (w.id !== weekId ? w : { ...w, games: w.games.map((g) => ({ ...g, result: typed.get(g.id) })) })),
    )
    dropEdit(weekId)
    return r.matchDay.updatedAt
  }

  const dayAction = async (weekId: string, fn: () => Promise<void>) => {
    setBusyDay(weekId)
    start()
    try {
      await fn()
    } catch (e) {
      fail(e)
    } finally {
      setBusyDay(null)
    }
  }

  const results: ResultsActions = {
    onResult: (weekId, gameId, result, p) =>
      setEdits((all) => {
        const base = all[weekId]?.week ?? savedWeek(weekId)
        if (!base) return all
        const week = setResult([base], weekId, gameId, result ?? { home: null, away: null })[0]!
        const problems = { ...all[weekId]?.problems }
        if (p) problems[gameId] = p
        else delete problems[gameId]
        const next = { ...all }
        // Typed back to what's saved: nothing to save.
        if (Object.keys(problems).length === 0 && Object.keys(changedResults(savedWeek(weekId)!, week)).length === 0) delete next[weekId]
        else next[weekId] = { week, problems }
        return next
      }),
    onSave: (weekId) =>
      void dayAction(weekId, async () => {
        await saveDay(weekId)
        setMessage('Saved. Publish the match day when it’s ready.')
      }),
    onPublish: (weekId) =>
      void dayAction(weekId, async () => {
        const token = await saveDay(weekId)
        const r = await api<{ matchDay: MatchDayState; cache: PurgeResult }>(`/api/admin/seasons/${id}/match-days/${weekId}/publish`, {
          body: { baseUpdatedAt: token },
        })
        const at = new Date(r.matchDay.resultsPublishedAt ?? Date.now())
        applyDay(weekId, r.matchDay, (weeks) => publishWeekResults(weeks, weekId, at))
        setView((v) => {
          if (!v) return v
          const ids = new Set(v.competition.weeks?.find((w) => w.id === weekId)?.games.map((g) => g.id))
          const matches = { ...v.matches }
          for (const [mid, m] of Object.entries(matches))
            if (ids.has(mid) && m.status === 'scheduled') matches[mid] = { ...m, status: 'played' }
          return { ...v, matches }
        })
        setMessage(`Published: the ladder and website are updated.${purgeNote(r.cache)}`)
      }),
    onDiscard: (weekId) => {
      dropEdit(weekId)
      resetDay(weekId)
    },
    onUndo: (weekId) =>
      void dayAction(weekId, async () => {
        const r = await api<{ matchDay: MatchDayState }>(`/api/admin/seasons/${id}/match-days/${weekId}/undo`, {
          body: { baseUpdatedAt: view!.matchDays[weekId]!.updatedAt },
        })
        const cancelled = cancelledIds(view!)
        applyDay(weekId, r.matchDay, (weeks) =>
          undoWeekResultChanges(weeks, weekId).map((w) =>
            w.id !== weekId ? w : { ...w, games: w.games.map((g) => (cancelled.has(g.id) ? { ...g, result: undefined } : g)) },
          ),
        )
        dropEdit(weekId)
        resetDay(weekId)
        setMessage('Back to the published results.')
      }),
    onStatus: (weekId, gameId, status: GameStatus) =>
      status === 'cancelled' || status === 'postponed' || status === 'tbd'
        ? setPending({ kind: 'status', weekId, gameId, status })
        : status === 'forfeit'
          ? setPending({ kind: 'forfeit', weekId, gameId })
          : setGameStatus(weekId, gameId, status),
    onReferee: async (weekId, gameId, referee) => {
      start()
      try {
        const r = await api<{ matchDay: MatchDayState; match: { id: string; referee: string | null }; cache: PurgeResult }>(
          `/api/admin/seasons/${id}/match-days/${weekId}/matches/${gameId}`,
          { method: 'PATCH', body: { baseUpdatedAt: view!.matchDays[weekId]!.updatedAt, referee } },
        )
        const setRef = (w: Week) =>
          w.id !== weekId ? w : { ...w, games: w.games.map((g) => (g.id !== gameId ? g : { ...g, referee: r.match.referee ?? undefined })) }
        applyDay(weekId, r.matchDay, (weeks) => weeks.map(setRef))
        setEdits((all) => (all[weekId] ? { ...all, [weekId]: { ...all[weekId], week: setRef(all[weekId].week) } } : all))
        if (r.cache === 'failed') setMessage(`Referee saved.${purgeNote(r.cache)}`)
      } catch (e) {
        fail(e)
        throw e
      }
    },
    onMove: (weekId, gameId) => (blockedByEdits() ? undefined : setPending({ kind: 'move', weekId, gameId })),
    onUndoMove: (gameId) => (blockedByEdits() ? undefined : setPending({ kind: 'undoMove', gameId })),
    onNight: (weekId) => (blockedByEdits() ? undefined : setPending({ kind: 'night', weekId })),
    onRestoreNight: (weekId) => (blockedByEdits() ? undefined : setPending({ kind: 'restore', weekId })),
    onWithdraw: () => (blockedByEdits() ? undefined : setPending({ kind: 'withdraw' })),
    onReinstate: (teamId) => (blockedByEdits() ? undefined : setPending({ kind: 'reinstate', teamId })),
    onAddAdjustment: async (a) => {
      const r = await api<{ adjustments: AdjustmentRow[] }>(`/api/admin/seasons/${id}/adjustments`, { body: a })
      setView((v) => (v ? { ...v, adjustments: r.adjustments } : v))
    },
    onUpdateAdjustment: async (adjId, a) => {
      const r = await api<{ adjustments: AdjustmentRow[] }>(`/api/admin/seasons/${id}/adjustments/${adjId}`, { method: 'PATCH', body: a })
      setView((v) => (v ? { ...v, adjustments: r.adjustments } : v))
    },
    onDeleteAdjustment: async (adjId) => {
      const r = await api<{ adjustments: AdjustmentRow[] }>(`/api/admin/seasons/${id}/adjustments/${adjId}`, { method: 'DELETE' })
      setView((v) => (v ? { ...v, adjustments: r.adjustments } : v))
    },
  }

  /**
   * Marks a game played, forfeit, cancelled, postponed or TBD, with an optional public note (cancelling clears its
   * result). A forfeit with `forfeitedBy` gets the season's forfeit score as its draft result.
   */
  function setGameStatus(weekId: string, gameId: string, status: GameStatus, note?: string, forfeitedBy?: 'home' | 'away') {
    void dayAction(weekId, async () => {
      const r = await api<{
        matchDay: MatchDayState
        match: { id: string; status: SeasonView['matches'][string]['status']; statusNote: string | null }
        result?: Result
        cache: PurgeResult
      }>(`/api/admin/seasons/${id}/match-days/${weekId}/matches/${gameId}/status`, {
        body: {
          baseUpdatedAt: view!.matchDays[weekId]!.updatedAt,
          status,
          ...(note !== undefined ? { note } : {}),
          ...(forfeitedBy ? { forfeitedBy } : {}),
        },
      })
      const { status: stored, statusNote } = r.match
      const off = isOffStatus(stored)
      const score = r.result
      const patch = (w: Week, clearResult: boolean) =>
        w.id !== weekId
          ? w
          : {
              ...w,
              games: w.games.map((g) =>
                g.id !== gameId
                  ? g
                  : {
                      ...g,
                      ...(clearResult ? { result: undefined } : {}),
                      ...(score ? { result: score } : {}),
                      status: stored === 'scheduled' ? undefined : stored,
                      statusNote: statusNote ?? undefined,
                    },
              ),
            }
      applyDay(weekId, r.matchDay, (weeks) => weeks.map((w) => patch(w, stored === 'cancelled')))
      setView((v) => (v ? { ...v, matches: { ...v.matches, [gameId]: { ...v.matches[gameId]!, status: stored, statusNote } } } : v))
      if (score) {
        // The forfeit score replaces whatever was typed for that game.
        setEdits((all) => {
          const e = all[weekId]
          if (!e) return all
          const problems = { ...e.problems }
          delete problems[gameId]
          return { ...all, [weekId]: { week: patch(e.week, false), problems } }
        })
        resetDay(weekId)
      }
      if (off) {
        // Unsaved typing for a game that's now off can't be saved: drop it.
        setEdits((all) => {
          const e = all[weekId]
          if (!e) return all
          const problems = { ...e.problems }
          delete problems[gameId]
          return { ...all, [weekId]: { week: patch(e.week, true), problems } }
        })
        resetDay(weekId)
      }
      setMessage(
        stored === 'cancelled'
          ? 'Marked cancelled. Publish the match day to take any old result off the ladder.'
          : stored === 'postponed'
            ? 'Postponed. It needs no result to publish the match day; set it back to played when it’s been played.'
            : stored === 'tbd'
              ? 'Marked TBD. It needs no result to publish the match day.'
              : stored === 'forfeit'
                ? score
                  ? 'Marked as a forfeit, with the season’s forfeit score entered. Publish the match day when it’s ready.'
                  : 'Marked as a forfeit. Enter the score it counts as.'
                : 'Marked played.',
      )
    })
  }

  /** Season-level actions (a whole night, withdrawals) change many match days: unsaved work has to go first. */
  const blockedByEdits = () => {
    if (!dirtyRef.current) return false
    setProblem({ message: 'Save or discard your unsaved changes first.', issues: [] })
    return true
  }

  /** Runs a season-level action that answers with the whole season view. */
  const seasonAction = async <T extends SeasonView & { cache?: PurgeResult }>(
    path: string,
    body: Record<string, unknown>,
    done: (r: T) => string,
  ) => {
    setBusy('status')
    start()
    try {
      const r = await api<T>(`/api/admin/seasons/${id}/${path}`, { body: { baseUpdatedAt: view!.season.updatedAt, ...body } })
      setPending(null)
      setView(r)
      setDraft(null)
      setEdits({})
      setResets((x) => ({ ...x, all: x.all + 1 }))
      setMessage(`${done(r)}${purgeNote(r.cache)}`)
    } catch (e) {
      setPending(null)
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const nightAction = (weekId: string, c: NightChoice | { action: 'restore' }) =>
    void seasonAction(`match-days/${weekId}/night`, c, () =>
      c.action === 'restore'
        ? 'Restored.'
        : 'pushBack' in c && c.pushBack
          ? 'Postponed: every night from this one is a week later, and the website shows the new dates.'
          : c.action === 'postpone'
            ? 'The night is postponed. Restore it, or push the season back, once there’s a new date.'
            : 'The night is cancelled.',
    )

  /** Saves the season and every match day with unsaved results. */
  const saveAll = async (): Promise<boolean> => {
    if (seasonDirty && !(await saveSeason())) return false
    for (const weekId of Object.keys(edits)) {
      try {
        await saveDay(weekId)
      } catch (e) {
        fail(e)
        return false
      }
    }
    return true
  }

  // Ctrl/⌘+S saves, as in any editor.
  const saveRef = useRef(saveAll)
  useLayoutEffect(() => {
    saveRef.current = saveAll
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirtyRef.current) void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Generating (in a Web Worker) ──
  const generate = async (confirmed = false) => {
    if (!working) return
    const c = working.competition
    if (c.weeks && c.edited && !confirmed) return setPending({ kind: 'regenerate' })
    // The first draw uses the season's own seed; each regenerate is a fresh one (the seed is saved, so it's reproducible).
    const settings = { ...c.settings, seed: c.weeks ? newSeed() : c.settings.seed }
    setBusy('generate')
    start()
    try {
      const weeks = await generateInWorker(settings)
      setDraft({ ...working, competition: { ...c, settings, weeks, edited: false, generatedFrom: shapeKey(settings) } })
      setMessage('New draw made. Check it, then Save.')
      navigate(`/seasons/${id}/fixtures`)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  // ── Status: publish, unpublish, archive, unarchive; delete a draft ──
  const changeStatus = async (status: 'published' | 'draft' | 'archived') => {
    let base = view!.season.updatedAt
    if (seasonDirty) {
      const v = await saveSeason()
      if (!v) return
      base = v.season.updatedAt
    }
    setBusy('status')
    start()
    try {
      const r = await api<SeasonView & { cache: PurgeResult }>(`/api/admin/seasons/${id}/status`, { body: { baseUpdatedAt: base, status } })
      setView(r)
      setDraft(null)
      setMessage(
        `${status === 'published' ? (view!.season.status === 'archived' ? 'Unarchived' : 'Published: the fixtures are on the website') : status === 'draft' ? 'Unpublished: it’s a draft again' : 'Archived'}.${purgeNote(r.cache)}`,
      )
      navigate(`/seasons/${id}/${status === 'draft' ? 'publish' : 'results'}`, { replace: true })
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('delete')
    start()
    try {
      await api(`/api/admin/seasons/${id}?baseUpdatedAt=${encodeURIComponent(view!.season.updatedAt)}`, { method: 'DELETE' })
      setDraft(null)
      setEdits({})
      leaveTo('/admin/seasons')
    } catch (e) {
      fail(e)
      setBusy(null)
    }
  }

  const onTeamRenamed = (t: Team) => {
    const rename = (d: Draft): Draft => ({
      ...d,
      competition: {
        ...d.competition,
        settings: { ...d.competition.settings, teams: d.competition.settings.teams.map((x) => (x.id === t.id ? t : x)) },
      },
    })
    setView((v) => (v ? { ...v, competition: rename(draftOf(v)).competition } : v))
    setDraft((d) => (d ? rename(d) : d))
    setMessage(`Renamed to ${t.name} everywhere.`)
  }

  // ── Routing ──
  const status = view?.season.status
  const tabs = !isAdmin ? EDITOR_TABS : status === 'draft' ? DRAFT_TABS : PUBLISHED_TABS
  const hasDraw = !!working?.competition.weeks
  const asked = ALL_TABS.find((t) => t === requested)
  let tab: Tab | null = null
  if (view && working) {
    // An old link (e.g. to "publish" after publishing) lands on the nearest tab.
    const nearest = asked === 'publish' ? 'website' : asked === 'website' ? 'publish' : undefined
    tab =
      asked && tabs.some((t) => t.id === asked)
        ? asked
        : nearest && tabs.some((t) => t.id === nearest)
          ? nearest
          : landingTab(working.competition)
    if (!tabs.some((t) => t.id === tab)) tab = tabs[0]!.id
    // No draw yet: Setup, or the Fixtures tab's generate / import-from-CSV choice on a draft.
    if (!hasDraw && isAdmin && !(tab === 'fixtures' && status === 'draft')) tab = 'setup'
  }
  useEffect(() => {
    if (tab && tab !== requested) navigate(`/seasons/${id}/${tab}`, { replace: true })
  }, [tab, requested, id, navigate])
  // A new tab starts at the top (the router doesn't reset the scroll).
  // Block body on purpose: newer browsers return a Promise from scrollTo(), and React would call it as a cleanup.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [tab])

  if (loadError)
    return (
      <div className="space-y-4">
        <Link href={view ? `/leagues/${view.league.id}/seasons` : '/leagues'} className="text-brand text-sm underline">
          ← {view ? view.league.name : 'Leagues'}
        </Link>
        <Notice kind="error">{loadError}</Notice>
      </div>
    )
  if (!view || !working || !tab) return <p className="text-sm text-black/60">Loading…</p>

  const archived = status === 'archived'
  const published = status === 'published'
  const s = working.competition.settings
  const readOnly = archived || !isAdmin
  const hasResults = (view.competition.weeks ?? []).some((w) => w.games.some((g) => g.result || g.publishedResult))
  const base = `/seasons/${id}`

  if (!isAdmin && status === 'draft')
    return (
      <div className="space-y-4">
        <Link href={view ? `/leagues/${view.league.id}/seasons` : '/leagues'} className="text-brand text-sm underline">
          ← {view ? view.league.name : 'Leagues'}
        </Link>
        <h1 className="text-2xl font-bold">{view.season.name}</h1>
        <Notice>This season isn't published yet. Results can be entered once an admin publishes it.</Notice>
      </div>
    )

  return (
    <div>
      <div className="mb-5">
        <Link href={view ? `/leagues/${view.league.id}/seasons` : '/leagues'} className="text-brand text-sm underline">
          ← {view ? view.league.name : 'Leagues'}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-2xl font-bold">{s.name || view.season.name}</h1>
          <span className="text-sm text-black/60">
            {view.league.name}
            {s.startDate && ` · ${weekdayName(s.startDate)} nights`}
          </span>
          <StatusBadge status={view.season.status} />
          <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {isAdmin && !archived && (
              <>
                <span className={`text-xs ${seasonDirty ? 'text-ink font-semibold' : 'text-black/60'}`}>
                  {seasonDirty ? 'Unsaved changes' : `Saved ${formatWhen(view.season.updatedAt)}`}
                </span>
                {seasonDirty && (
                  <Button variant="secondary" className="px-3 py-1 text-xs" onClick={() => setConfirm('discard')}>
                    Discard
                  </Button>
                )}
                <Button
                  className="px-3 py-1 text-xs"
                  disabled={!seasonDirty}
                  busy={busy === 'save'}
                  onClick={() => void saveSeason()}
                  title="Save (Ctrl+S)"
                >
                  {seasonDirty ? 'Save' : '✓ Saved'}
                </Button>
              </>
            )}
            {isAdmin && published && !hasResults && (
              <Button variant="secondary" className="px-3 py-1 text-xs" onClick={() => setConfirm('unpublish')}>
                Unpublish
              </Button>
            )}
            {isAdmin && published && (
              <Button variant="secondary" className="px-3 py-1 text-xs" onClick={() => setConfirm('archive')}>
                Archive
              </Button>
            )}
            {isAdmin && archived && (
              <Button variant="secondary" className="px-3 py-1 text-xs" busy={busy === 'status'} onClick={() => setConfirm('unarchive')}>
                Unarchive
              </Button>
            )}
            {isAdmin && status === 'draft' && (
              <Button variant="danger" className="px-3 py-1 text-xs" onClick={() => setConfirm('delete')}>
                Delete
              </Button>
            )}
          </span>
        </div>
        <nav className="mt-4 flex overflow-x-auto border-b border-black/10 sm:gap-1" aria-label="Season">
          {tabs.map((t) => {
            const disabled = t.id !== 'setup' && !hasDraw && !(t.id === 'fixtures' && status === 'draft')
            return disabled ? (
              <span
                key={t.id}
                aria-disabled
                className="cursor-not-allowed border-b-4 border-transparent px-3 py-2 text-sm font-semibold whitespace-nowrap text-black/30 uppercase"
              >
                {t.label}
              </span>
            ) : (
              <Link
                key={t.id}
                href={`${base}/${t.id}`}
                aria-current={tab === t.id ? 'page' : undefined}
                className={`border-b-4 px-3 py-2 text-sm font-semibold whitespace-nowrap uppercase ${
                  tab === t.id ? 'border-accent text-ink' : 'border-transparent text-black/60 hover:text-black'
                }`}
              >
                {t.label}
              </Link>
            )
          })}
        </nav>
      </div>

      <div className="mb-4 space-y-3 empty:hidden">
        {conflict && (
          <Notice kind="warning">
            <p>
              <strong>Someone else saved changes to this season while you were working.</strong> Reload to see their version. Your unsaved
              changes here will be lost, so note anything you need first.
            </p>
            <div className="mt-2 flex gap-2">
              <Button onClick={() => void reload()}>Reload</Button>
              <Button variant="secondary" onClick={() => setConflict(false)}>
                Not yet
              </Button>
            </div>
          </Notice>
        )}
        {problem && (
          <Notice kind="error">
            <p>{problem.message}</p>
            {problem.issues.length > 0 && (
              <div className="mt-2 text-ink">
                <IssueList issues={problem.issues} />
              </div>
            )}
          </Notice>
        )}
        {message && <Notice kind="success">{message}</Notice>}
        {archived && <Notice>This season is archived, so it's read-only. Unarchive it to make changes.</Notice>}
      </div>

      {tab === 'setup' ? (
        <SetupTab
          view={view}
          draft={working}
          onChange={setDraft}
          readOnly={readOnly}
          generating={busy === 'generate'}
          onGenerate={() => void generate()}
          onTeamRenamed={onTeamRenamed}
        />
      ) : tab === 'fixtures' ? (
        <FixturesTab
          view={view}
          draft={working}
          onChange={setDraft}
          readOnly={readOnly}
          generating={busy === 'generate'}
          onGenerate={() => void generate()}
        />
      ) : tab === 'publish' ? (
        <PublishTab
          view={view}
          draft={working}
          dirty={seasonDirty}
          busy={busy === 'status' || busy === 'save'}
          readOnly={readOnly}
          onPublish={() => void changeStatus('published')}
        />
      ) : tab === 'website' ? (
        <WebsiteTab view={view} draft={saved!} />
      ) : (
        <ResultsTab view={view} edits={edits} busyDay={busyDay} canEnter={!archived} isAdmin={isAdmin} resets={resets} actions={results} />
      )}

      {leavingTo && (
        <LeaveDialog
          name={s.name}
          busy={busy === 'save'}
          // Clear leavingTo in the handlers, not on close: saving or discarding unmounts the dialog first.
          onSave={() =>
            void saveAll().then((ok) => {
              if (!ok) return setLeavingTo(null)
              const to = leavingTo
              setLeavingTo(null)
              leaveTo(to)
            })
          }
          onDiscard={() => {
            const to = leavingTo
            setDraft(null)
            setEdits({})
            setLeavingTo(null)
            leaveTo(to)
          }}
          onStay={() => setLeavingTo(null)}
        />
      )}

      {pending?.kind === 'status' && (
        <GameStatusDialog
          status={pending.status}
          current={view.matches[pending.gameId]?.statusNote ?? ''}
          onConfirm={(note) => {
            const { weekId, gameId, status: next } = pending
            setPending(null)
            setGameStatus(weekId, gameId, next, note)
          }}
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.kind === 'forfeit' && view.competition.weeks?.find((w) => w.id === pending.weekId) && (
        <ForfeitDialog
          view={view}
          game={view.competition.weeks.find((w) => w.id === pending.weekId)!.games.find((g) => g.id === pending.gameId)!}
          current={view.matches[pending.gameId]?.statusNote ?? ''}
          onConfirm={(c) => {
            const { weekId, gameId } = pending
            setPending(null)
            setGameStatus(weekId, gameId, 'forfeit', c.note, c.forfeitedBy)
          }}
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.kind === 'move' && (
        <MoveGameDialog
          view={view}
          weekId={pending.weekId}
          gameId={pending.gameId}
          busy={busy === 'status'}
          onConfirm={(c) =>
            void seasonAction<SeasonView & { warnings: string[]; created: boolean; cache?: PurgeResult }>(
              `matches/${pending.gameId}/move`,
              c,
              (r) =>
                `Moved${r.created ? ' to a new catch-up night' : ''}. The website shows it on its new night.${
                  r.warnings.length ? ` Check: ${r.warnings.join(' ')}` : ''
                }`,
            )
          }
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.kind === 'undoMove' && (
        <ConfirmDialog
          title="Move this game back?"
          confirmLabel="Move it back"
          busy={busy === 'status'}
          onConfirm={() => void seasonAction(`matches/${pending.gameId}/move`, { action: 'undo' }, () => 'Moved back to its old night.')}
          onCancel={() => setPending(null)}
        >
          <p>
            The game goes back to the night, time and court it had before its last move, with its old status. A catch-up night made for it
            is removed once it’s empty.
          </p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'night' && view.competition.weeks?.find((w) => w.id === pending.weekId) && (
        <NightDialog
          week={view.competition.weeks.find((w) => w.id === pending.weekId)!}
          weeks={view.competition.weeks}
          settings={view.competition.settings}
          busy={busy === 'status'}
          onConfirm={(c) => nightAction(pending.weekId, c)}
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.kind === 'restore' && (
        <ConfirmDialog
          title={
            view.competition.weeks?.find((w) => w.id === pending.weekId)?.kind === 'skip' ? 'Move the nights back?' : 'Restore this night?'
          }
          confirmLabel="Restore"
          busy={busy === 'status'}
          onConfirm={() => nightAction(pending.weekId, { action: 'restore' })}
          onCancel={() => setPending(null)}
        >
          {view.competition.weeks?.find((w) => w.id === pending.weekId)?.kind === 'skip' ? (
            <p>
              This week off goes, and every night that was pushed back moves back to its old date. That only works while the nights are
              still where the push-back put them.
            </p>
          ) : (
            <p>The night and its games go back to how they were before it was postponed or cancelled.</p>
          )}
        </ConfirmDialog>
      )}
      {pending?.kind === 'withdraw' && (
        <WithdrawDialog
          teams={s.teams.filter((t) => !t.withdrawn)}
          busy={busy === 'status'}
          onConfirm={(c) =>
            void seasonAction<SeasonView & { cancelled: number; dutyGames: number; cache?: PurgeResult }>(
              `teams/${c.teamId}/withdraw`,
              { reason: c.reason, cancelFixtures: c.cancelFixtures, from: c.from },
              (r) =>
                `Withdrawn. ${r.cancelled} game${r.cancelled === 1 ? '' : 's'} cancelled.${
                  r.dutyGames
                    ? ` They had duty on ${r.dutyGames} remaining game${r.dutyGames === 1 ? '' : 's'}: those need another referee.`
                    : ''
                }`,
            )
          }
          onCancel={() => setPending(null)}
        />
      )}
      {pending?.kind === 'reinstate' && (
        <ConfirmDialog
          title={`Reinstate ${s.teams.find((t) => t.id === pending.teamId)?.name ?? 'this team'}?`}
          confirmLabel="Reinstate"
          busy={busy === 'status'}
          onConfirm={() =>
            void seasonAction<SeasonView & { restored: number; cache?: PurgeResult }>(
              `teams/${pending.teamId}/reinstate`,
              {},
              (r) => `Reinstated. ${r.restored} game${r.restored === 1 ? '' : 's'} back on.`,
            )
          }
          onCancel={() => setPending(null)}
        >
          <p>The team is back on the ladder, and the games its withdrawal cancelled are back on (if they're still cancelled).</p>
        </ConfirmDialog>
      )}
      {pending?.kind === 'regenerate' && (
        <ConfirmDialog
          title="Regenerate the draw?"
          confirmLabel="Regenerate"
          danger
          onConfirm={() => {
            setPending(null)
            void generate(true)
          }}
          onCancel={() => setPending(null)}
        >
          <p>A new draw replaces the current one, including your hand edits. Nothing is saved until you press Save.</p>
        </ConfirmDialog>
      )}
      {confirm === 'discard' && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          confirmLabel="Discard changes"
          danger
          onConfirm={() => {
            setConfirm(null)
            setDraft(null)
            setMessage(null)
          }}
          onCancel={() => setConfirm(null)}
        >
          <p>Everything you changed in the setup and fixtures since the last save will be lost. (Unsaved results are kept.)</p>
        </ConfirmDialog>
      )}
      {confirm === 'unpublish' && (
        <ConfirmDialog
          title="Unpublish this season?"
          confirmLabel="Unpublish"
          danger
          busy={busy === 'status'}
          onConfirm={() => {
            setConfirm(null)
            void changeStatus('draft')
          }}
          onCancel={() => setConfirm(null)}
        >
          <p>It goes back to being a draft that players can't see, and the league page shows the previous season again.</p>
          <p>You'll be able to change the teams and format, and make a new draw.</p>
        </ConfirmDialog>
      )}
      {confirm === 'archive' && (
        <ConfirmDialog
          title="Archive this season?"
          confirmLabel="Archive"
          busy={busy === 'status'}
          onConfirm={() => {
            setConfirm(null)
            void changeStatus('archived')
          }}
          onCancel={() => setConfirm(null)}
        >
          <p>The season stays on the website, read-only: no more results or changes. Archive it once the finals are done.</p>
          <p>You can unarchive it later.</p>
        </ConfirmDialog>
      )}
      {confirm === 'unarchive' && (
        <ConfirmDialog
          title="Unarchive this season?"
          confirmLabel="Unarchive"
          busy={busy === 'status'}
          onConfirm={() => {
            setConfirm(null)
            void changeStatus('published')
          }}
          onCancel={() => setConfirm(null)}
        >
          <p>It becomes a published season again, so results and courts can be changed.</p>
        </ConfirmDialog>
      )}
      {confirm === 'delete' && (
        <ConfirmDialog
          title={`Delete ${view.season.name}?`}
          confirmLabel="Delete season"
          danger
          busy={busy === 'delete'}
          onConfirm={() => {
            setConfirm(null)
            void remove()
          }}
          onCancel={() => setConfirm(null)}
        >
          <p>The draft and its draw are deleted. This can't be undone. (The teams stay.)</p>
        </ConfirmDialog>
      )}
    </div>
  )
}
