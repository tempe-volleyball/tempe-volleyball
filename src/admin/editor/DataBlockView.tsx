import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  PROGRAMME_TEMPLATE_PLACEHOLDERS,
  SUGGESTED_PROGRAMME_LINE_TEMPLATE,
  blockDisplays,
  enrolmentFilters,
  fixtureRanges,
  type ContactFormAttrs,
  type FixturesAttrs,
  type LadderAttrs,
  type ProgrammeLineSource,
  type ProgrammeListAttrs,
  type VenuesAttrs,
} from '../../lib/content/blocks'
import {
  parseContactFormAttrs,
  parseFixturesAttrs,
  parseLadderAttrs,
  parseProgrammeListAttrs,
  parseVenuesAttrs,
  type ProgrammeLine,
} from '../../lib/content/data-blocks'
import { programmeKinds } from '../../server/db/schema/enums'
import { api } from '../api'
import { Button, Checkbox, Dialog, Field, Notice, Select, Skeleton, errorMessage } from '../ui'
import type { DataBlockType } from './data-blocks'

// The editor's view of a data block: a live preview (rendered by the server exactly as the public page will show it),
// a warning when overridden lines have changed underneath, and a settings dialog. The dialog lives in a portal so
// ProseMirror never sees its keystrokes.

const LABELS: Record<DataBlockType, string> = {
  programmeList: 'Programme list',
  ladder: 'Ladder',
  fixtures: 'Fixtures',
  venues: 'Venues',
  contactForm: 'Contact form',
}

type Choices = {
  categories: { id: string; name: string; status: string }[]
  programmes: { id: string; kind: string; code: string; name: string; status: string; categoryId: string | null }[]
  leagues: { id: string; code: string; name: string; status: string; season: string | null; teams: { id: string; name: string }[] }[]
  venues: { id: string; name: string }[]
  /** Settings → Contact form's topics, for the Contact form block's starting topic. */
  contactTopics: string[]
}
type Preview = { html: string; lines: ProgrammeLine[]; note: string | null }

let choicesPromise: Promise<Choices> | null = null
const loadChoices = () =>
  (choicesPromise ??= api<Choices>('/api/admin/blocks/choices').catch((e: unknown) => ((choicesPromise = null), Promise.reject(e))))

function useChoices() {
  const [choices, setChoices] = useState<Choices | null>(null)
  useEffect(() => {
    let live = true
    loadChoices().then(
      (c) => live && setChoices(c),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])
  return choices
}

/** The server's rendering of a block, refreshed (debounced) as its attrs change. */
function usePreview(type: DataBlockType, attrs: unknown) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = JSON.stringify(attrs)
  const seq = useRef(0)
  useEffect(() => {
    const n = ++seq.current
    const t = setTimeout(() => {
      api<Preview>('/api/admin/blocks/preview', { body: { block: { type, attrs: JSON.parse(key) as unknown } } }).then(
        (p) => {
          if (n !== seq.current) return
          setPreview(p)
          setError(null)
        },
        (e: unknown) => n === seq.current && setError(errorMessage(e)),
      )
    }, 300)
    return () => clearTimeout(t)
  }, [type, key])
  return { preview, error }
}

const FIELD_NAMES: Record<keyof ProgrammeLineSource, string> = {
  name: 'name',
  code: 'code',
  venue: 'venue',
  times: 'day and times',
  nextStarts: 'next start date',
  summaryLine: 'summary line',
}

const listWords = (words: string[]) => (words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`)

/** "TNL's venue and day and times changed since you edited this line." */
export const changedMessage = (line: Pick<ProgrammeLine, 'code' | 'name' | 'changed'>) =>
  `${line.code || line.name}’s ${listWords(line.changed.map((k) => FIELD_NAMES[k]))} changed since you edited this line.`

function PreviewBox({ preview, error }: { preview: Preview | null; error: string | null }) {
  if (error) return <Notice kind="error">{error}</Notice>
  if (!preview) return <Skeleton lines={3} label="Loading the preview…" />
  return (
    <>
      {preview.html ? (
        <div className="prose pointer-events-none max-w-none select-none" dangerouslySetInnerHTML={{ __html: preview.html }} />
      ) : null}
      {preview.note && <p className="text-sm text-black/60 italic">{preview.note}</p>}
    </>
  )
}

function summary(type: DataBlockType, attrs: Record<string, unknown>, choices: Choices | null): string {
  if (type === 'programmeList') {
    const a = parseProgrammeListAttrs(attrs)
    const cats = (a.filter.categoryIds ?? []).map((id) => choices?.categories.find((c) => c.id === id)?.name ?? '?')
    const parts = [
      cats.length ? cats.join(', ') : 'All categories',
      a.filter.kinds?.length ? a.filter.kinds.join(', ') : '',
      a.filter.enrolment === 'open' ? 'taking sign-ups' : a.filter.enrolment === 'closed' ? 'not taking sign-ups' : '',
    ]
    return parts.filter(Boolean).join(' · ')
  }
  if (type === 'contactForm') {
    const a = parseContactFormAttrs(attrs)
    return [
      a.title ?? 'No heading',
      a.showTopic ? (a.defaultTopic ? `starts on “${a.defaultTopic}”` : 'asks for a topic') : 'no topic question',
    ]
      .filter(Boolean)
      .join(' · ')
  }
  if (type === 'venues') {
    const a = parseVenuesAttrs(attrs)
    return a.venueIds.length
      ? a.venueIds.map((id) => choices?.venues.find((v) => v.id === id)?.name ?? '?').join(', ')
      : 'Every venue, in venue order'
  }
  const a = type === 'ladder' ? parseLadderAttrs(attrs) : parseFixturesAttrs(attrs)
  const league = choices?.leagues.find((l) => l.id === a.leagueId)
  const what = type === 'fixtures' ? ` · ${(a as FixturesAttrs).range.replace('_', ' ')}` : ''
  return `${league ? `${league.code}${league.season ? ` (${league.season})` : ''}` : 'No league chosen'} · ${a.display}${what}`
}

export function DataBlockView({ node, updateAttributes, deleteNode, selected }: NodeViewProps) {
  const type = node.type.name as DataBlockType
  const attrs = node.attrs as Record<string, unknown>
  const choices = useChoices()
  const { preview, error } = usePreview(type, attrs)
  // A new Ladder or Fixtures block has no league yet: open its settings straight away.
  const [editing, setEditing] = useState((type === 'ladder' || type === 'fixtures') && !attrs.leagueId)
  const changed = preview?.lines.filter((l) => l.changed.length > 0) ?? []

  return (
    <NodeViewWrapper
      className={`my-4 rounded border-2 bg-black/[0.02] p-3 ${selected ? 'border-brand' : 'border-dashed border-black/20'}`}
      contentEditable={false}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {/* Only the grip drags the block, so clicks on the buttons stay clicks. */}
          <span data-drag-handle draggable className="mr-2 cursor-grab text-lg leading-none text-black/60" title="Drag to move" aria-hidden>
            ⠿
          </span>
          <span className="bg-brand mr-2 rounded px-2 py-0.5 text-xs font-bold text-white uppercase">{LABELS[type]}</span>
          <span className="text-black/70">{summary(type, attrs, choices)}</span>
        </p>
        <span className="flex gap-2">
          <Button variant="secondary" className="px-2 py-1 text-xs" onClick={() => setEditing(true)}>
            Settings
          </Button>
          <Button variant="danger" className="px-2 py-1 text-xs" onClick={() => deleteNode()}>
            Remove
          </Button>
        </span>
      </div>
      {changed.length > 0 && (
        <div className="mb-2">
          <Notice kind="warning">
            {changed.map((l) => (
              <span key={l.id} className="block">
                {changedMessage(l)}
              </span>
            ))}
            <Button variant="link" className="mt-1 text-xs" onClick={() => setEditing(true)}>
              Review in settings
            </Button>
          </Notice>
        </div>
      )}
      <PreviewBox preview={preview} error={error} />
      {editing &&
        createPortal(
          <SettingsDialog
            type={type}
            attrs={attrs}
            choices={choices}
            onCancel={() => setEditing(false)}
            onApply={(next) => {
              setEditing(false)
              updateAttributes(next)
            }}
          />,
          document.body,
        )}
    </NodeViewWrapper>
  )
}

function SettingsDialog({
  type,
  attrs,
  choices,
  onCancel,
  onApply,
}: {
  type: DataBlockType
  attrs: Record<string, unknown>
  choices: Choices | null
  onCancel: () => void
  onApply: (attrs: Record<string, unknown>) => void
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>(() =>
    type === 'programmeList'
      ? parseProgrammeListAttrs(attrs)
      : type === 'ladder'
        ? parseLadderAttrs(attrs)
        : type === 'venues'
          ? parseVenuesAttrs(attrs)
          : type === 'contactForm'
            ? parseContactFormAttrs(attrs)
            : parseFixturesAttrs(attrs),
  )
  const { preview, error } = usePreview(type, draft)
  return (
    <Dialog title={`${LABELS[type]} settings`} onCancel={onCancel} wide>
      <div className="space-y-5">
        {!choices && <Skeleton lines={4} label="Loading the block’s settings…" />}
        {choices && type === 'programmeList' && (
          <ProgrammeListSettings
            attrs={draft as ProgrammeListAttrs}
            choices={choices}
            lines={preview?.lines ?? null}
            onChange={(a) => setDraft(a as unknown as Record<string, unknown>)}
          />
        )}
        {choices && type === 'ladder' && (
          <LadderSettings
            attrs={draft as LadderAttrs}
            choices={choices}
            onChange={(a) => setDraft(a as unknown as Record<string, unknown>)}
          />
        )}
        {choices && type === 'venues' && (
          <VenuesSettings
            attrs={draft as VenuesAttrs}
            choices={choices}
            onChange={(a) => setDraft(a as unknown as Record<string, unknown>)}
          />
        )}
        {choices && type === 'contactForm' && (
          <ContactFormSettings
            attrs={draft as ContactFormAttrs}
            choices={choices}
            onChange={(a) => setDraft(a as unknown as Record<string, unknown>)}
          />
        )}
        {choices && type === 'fixtures' && (
          <FixturesSettings
            attrs={draft as FixturesAttrs}
            choices={choices}
            onChange={(a) => setDraft(a as unknown as Record<string, unknown>)}
          />
        )}
        <div>
          <h3 className="mb-2 text-sm font-bold">Preview</h3>
          <div className="rounded border border-black/10 p-3">
            <PreviewBox preview={preview} error={error} />
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => onApply(draft)}>Apply</Button>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <p className="text-xs text-black/60">Changes show on the site when you save the page.</p>
      </div>
    </Dialog>
  )
}

const Group = ({ legend, children }: { legend: string; children: ReactNode }) => (
  <fieldset className="space-y-2">
    <legend className="mb-1 text-sm font-semibold">{legend}</legend>
    {children}
  </fieldset>
)

const KIND_LABELS: Record<string, string> = { league: 'Leagues', training: 'Training', development: 'Development', event: 'Events' }

const toggle = <T,>(list: readonly T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v))

function ProgrammeListSettings({
  attrs,
  choices,
  lines,
  onChange,
}: {
  attrs: ProgrammeListAttrs
  choices: Choices
  lines: ProgrammeLine[] | null
  onChange: (a: ProgrammeListAttrs) => void
}) {
  const set = (p: Partial<ProgrammeListAttrs>) => onChange({ ...attrs, ...p })
  const filter = attrs.filter
  const [editingLine, setEditingLine] = useState<string | null>(null)
  const [lineText, setLineText] = useState('')

  const move = (id: string, by: -1 | 1) => {
    if (!lines) return
    const ids = lines.map((l) => l.id)
    const i = ids.indexOf(id)
    const j = i + by
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
    set({ order: ids })
  }
  const override = (line: ProgrammeLine, text: string | null) => {
    const overrides = { ...attrs.overrides }
    if (text === null) delete overrides[line.id]
    else overrides[line.id] = { text, source: line.current, editedAt: new Date().toISOString() }
    set({ overrides })
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Group legend="Categories (none ticked = all)">
          {choices.categories.map((c) => (
            <Checkbox
              key={c.id}
              label={`${c.name}${c.status !== 'active' ? ` (${c.status})` : ''}`}
              checked={(filter.categoryIds ?? []).includes(c.id)}
              onChange={(on) => set({ filter: { ...filter, categoryIds: toggle(filter.categoryIds ?? [], c.id, on) } })}
            />
          ))}
        </Group>
        <Group legend="Kinds (none ticked = all)">
          {programmeKinds.map((k) => (
            <Checkbox
              key={k}
              label={KIND_LABELS[k] ?? k}
              checked={(filter.kinds ?? []).includes(k)}
              onChange={(on) => set({ filter: { ...filter, kinds: toggle(filter.kinds ?? [], k, on) } })}
            />
          ))}
        </Group>
        <Select
          label="Enrolment"
          value={filter.enrolment ?? 'any'}
          onChange={(e) => {
            const enrolment = e.target.value as (typeof enrolmentFilters)[number]
            set({ filter: { ...filter, enrolment, enrolmentOpenOnly: enrolment === 'open' } })
          }}
          hint="Only active programmes are ever listed; drafts and retired ones never are."
        >
          <option value="any">Open or not</option>
          <option value="open">Taking sign-ups now (enrolment open, or taking expressions of interest)</option>
          <option value="closed">Not taking sign-ups</option>
        </Select>
      </div>
      <Field
        label="Line template (optional)"
        value={attrs.template ?? ''}
        placeholder={`e.g. ${SUGGESTED_PROGRAMME_LINE_TEMPLATE}`}
        maxLength={300}
        onChange={(e) => set({ template: e.target.value || null })}
        hint={`Blank = the same summary line as category pages and /enrol. Placeholders: ${PROGRAMME_TEMPLATE_PLACEHOLDERS.map((p) => `{${p}}`).join(' ')}. Empty values tidy themselves away.`}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Heading (optional)"
          value={attrs.title ?? ''}
          maxLength={120}
          onChange={(e) => set({ title: e.target.value || null })}
        />
        <Field
          label="Text when nothing matches (optional)"
          value={attrs.emptyText ?? ''}
          maxLength={300}
          placeholder="Blank = show nothing"
          onChange={(e) => set({ emptyText: e.target.value || null })}
        />
      </div>
      <div className="flex flex-wrap gap-6">
        <Checkbox label="Link each line to its programme page" checked={attrs.linkLines} onChange={(v) => set({ linkLines: v })} />
        <Checkbox
          label="Use each programme’s own summary line"
          hint="Off = every line uses this block’s template (or the generated summary line)."
          checked={attrs.useSummaryLines}
          onChange={(v) => set({ useSummaryLines: v })}
        />
      </div>

      <div>
        <h3 className="mb-1 text-sm font-bold">Lines</h3>
        <p className="mb-2 text-xs text-black/60">
          New programmes join on their own. Your own text wins over the programme’s summary line, which wins over this block’s template,
          which wins over the generated summary line.
        </p>
        {!lines ? (
          <Skeleton lines={3} label="Loading the lines…" />
        ) : lines.length === 0 ? (
          <p className="text-sm text-black/60">No programmes match.</p>
        ) : (
          <ul className="space-y-2">
            {lines.map((l, i) => (
              <li key={l.id} className={`rounded border border-black/10 p-2 text-sm ${l.hidden ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-start gap-2">
                  <span className="flex flex-col">
                    <button
                      type="button"
                      aria-label={`Move ${l.name} up`}
                      disabled={i === 0}
                      className="px-1 disabled:opacity-30"
                      onClick={() => move(l.id, -1)}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      aria-label={`Move ${l.name} down`}
                      disabled={i === lines.length - 1}
                      className="px-1 disabled:opacity-30"
                      onClick={() => move(l.id, 1)}
                    >
                      ▼
                    </button>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block">{l.text}</span>
                    <span className="block text-xs text-black/60">
                      {l.source === 'override'
                        ? 'Your text'
                        : l.source === 'summary'
                          ? 'The programme’s summary line'
                          : l.source === 'template'
                            ? 'From this block’s template'
                            : 'Generated summary line'}
                      {l.hidden ? ' · hidden on this page' : ''}
                    </span>
                    {l.changed.length > 0 && (
                      <span className="mt-1 block rounded bg-accent/20 px-2 py-1 text-xs">
                        {changedMessage(l)} Automatic text now: “{l.automatic}”.{' '}
                        <button type="button" className="underline" onClick={() => override(l, null)}>
                          Reset to automatic
                        </button>{' '}
                        ·{' '}
                        <button type="button" className="underline" onClick={() => override(l, l.override!.text)}>
                          Keep my text
                        </button>
                      </span>
                    )}
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <Button
                      variant="link"
                      className="text-xs"
                      onClick={() => {
                        setEditingLine(l.id)
                        setLineText(l.override?.text ?? l.automatic)
                      }}
                    >
                      Edit text
                    </Button>
                    {l.override && (
                      <Button variant="link" className="text-xs" onClick={() => override(l, null)}>
                        Reset to automatic
                      </Button>
                    )}
                    <Button variant="link" className="text-xs" onClick={() => set({ hidden: toggle(attrs.hidden, l.id, !l.hidden) })}>
                      {l.hidden ? 'Show' : 'Hide'}
                    </Button>
                  </span>
                </div>
                {editingLine === l.id && (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <span className="min-w-60 flex-1">
                      <Field
                        label={`Text for ${l.name} on this page`}
                        value={lineText}
                        maxLength={300}
                        onChange={(e) => setLineText(e.target.value)}
                      />
                    </span>
                    <Button
                      className="text-xs"
                      disabled={!lineText.trim()}
                      onClick={() => {
                        override(l, lineText.trim())
                        setEditingLine(null)
                      }}
                    >
                      Use this text
                    </Button>
                    <Button variant="secondary" className="text-xs" onClick={() => setEditingLine(null)}>
                      Cancel
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {attrs.order.length > 0 && (
          <Button variant="link" className="mt-2 text-xs" onClick={() => set({ order: [] })}>
            Back to automatic order
          </Button>
        )}
      </div>
    </div>
  )
}

const DISPLAY_LABELS: Record<(typeof blockDisplays)[number], string> = { compact: 'Compact', full: 'Full (every column)' }

function LeagueSelect({ value, choices, onChange }: { value: string; choices: Choices; onChange: (id: string) => void }) {
  return (
    <Select
      label="League"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      hint="The block always shows that league’s current season."
    >
      <option value="">Choose a league…</option>
      {choices.leagues.map((l) => (
        <option key={l.id} value={l.id}>
          {l.code} · {l.name}
          {l.status !== 'active' ? ` (${l.status})` : ''}
        </option>
      ))}
    </Select>
  )
}

const rowsValue = (v: string): number | null => {
  const n = Number(v)
  return v && Number.isInteger(n) && n > 0 ? n : null
}

function ContactFormSettings({
  attrs,
  choices,
  onChange,
}: {
  attrs: ContactFormAttrs
  choices: Choices
  onChange: (a: ContactFormAttrs) => void
}) {
  const set = (p: Partial<ContactFormAttrs>) => onChange({ ...attrs, ...p })
  return (
    <div className="space-y-5">
      <p className="text-sm text-black/70">
        Name, email, topic and message. Messages arrive in Admin → Messages (and by email, if Settings → Contact form says so). The topics,
        the thank-you text and the automatic reply are set once for every form in Settings → Contact form.
      </p>
      <Field
        label="Heading (optional)"
        value={attrs.title ?? ''}
        maxLength={120}
        placeholder="Send us a message"
        onChange={(e) => set({ title: e.target.value || null })}
      />
      <Checkbox
        label="Ask what the message is about"
        checked={attrs.showTopic}
        onChange={(v) => set({ showTopic: v })}
        hint={choices.contactTopics.length ? undefined : 'Settings → Contact form has no topics, so the question isn’t shown.'}
      />
      {attrs.showTopic && choices.contactTopics.length > 0 && (
        <Select
          label="Topic chosen to start with"
          value={attrs.defaultTopic ?? ''}
          onChange={(e) => set({ defaultTopic: e.target.value || null })}
          hint="E.g. Juniors on a junior page. People can still change it."
        >
          <option value="">None (they choose)</option>
          {choices.contactTopics.map((t) => (
            <option key={t}>{t}</option>
          ))}
          {attrs.defaultTopic && !choices.contactTopics.includes(attrs.defaultTopic) && (
            <option value={attrs.defaultTopic}>{attrs.defaultTopic} (no longer a topic: none is chosen)</option>
          )}
        </Select>
      )}
      <Field
        label="Button text (optional)"
        value={attrs.submitLabel ?? ''}
        maxLength={40}
        placeholder="Send message"
        onChange={(e) => set({ submitLabel: e.target.value || null })}
      />
    </div>
  )
}

function VenuesSettings({ attrs, choices, onChange }: { attrs: VenuesAttrs; choices: Choices; onChange: (a: VenuesAttrs) => void }) {
  const set = (p: Partial<VenuesAttrs>) => onChange({ ...attrs, ...p })
  const chosen = attrs.venueIds
  const move = (id: string, by: -1 | 1) => {
    const ids = [...chosen]
    const i = ids.indexOf(id)
    const j = i + by
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j]!, ids[i]!]
    set({ venueIds: ids })
  }
  return (
    <div className="space-y-5">
      <p className="text-sm text-black/70">
        Names, addresses, map links and directions come from Admin → Venues, so a change there shows here on its own.
      </p>
      <Group legend="Venues (none ticked = every venue, in venue order)">
        {choices.venues.map((v) => (
          <Checkbox
            key={v.id}
            label={v.name}
            checked={chosen.includes(v.id)}
            onChange={(on) => set({ venueIds: toggle(chosen, v.id, on) })}
          />
        ))}
      </Group>
      {chosen.length > 1 && (
        <Group legend="Order">
          <ul className="space-y-1 text-sm">
            {chosen.map((id, i) => (
              <li key={id} className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Move up"
                  disabled={i === 0}
                  className="px-1 disabled:opacity-30"
                  onClick={() => move(id, -1)}
                >
                  ▲
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={i === chosen.length - 1}
                  className="px-1 disabled:opacity-30"
                  onClick={() => move(id, 1)}
                >
                  ▼
                </button>
                {choices.venues.find((v) => v.id === id)?.name ?? 'A deleted venue'}
              </li>
            ))}
          </ul>
        </Group>
      )}
      <Field
        label="Heading (optional)"
        value={attrs.title ?? ''}
        maxLength={120}
        onChange={(e) => set({ title: e.target.value || null })}
        hint="With a heading, each venue is a sub-heading under it."
      />
      <div className="flex flex-wrap gap-6">
        <Checkbox label="Address" checked={attrs.showAddress} onChange={(v) => set({ showAddress: v })} />
        <Checkbox label="Map link" checked={attrs.showMap} onChange={(v) => set({ showMap: v })} />
        <Checkbox label="Directions" checked={attrs.showDirections} onChange={(v) => set({ showDirections: v })} />
        <Checkbox label="Who plays here" checked={attrs.showProgrammes} onChange={(v) => set({ showProgrammes: v })} />
      </div>
    </div>
  )
}

function LadderSettings({ attrs, choices, onChange }: { attrs: LadderAttrs; choices: Choices; onChange: (a: LadderAttrs) => void }) {
  const set = (p: Partial<LadderAttrs>) => onChange({ ...attrs, ...p })
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <LeagueSelect value={attrs.leagueId} choices={choices} onChange={(leagueId) => set({ leagueId })} />
      <Select label="Display" value={attrs.display} onChange={(e) => set({ display: e.target.value as LadderAttrs['display'] })}>
        {blockDisplays.map((d) => (
          <option key={d} value={d}>
            {DISPLAY_LABELS[d]}
          </option>
        ))}
      </Select>
      <Field
        label="Rows"
        type="number"
        min={1}
        max={100}
        value={attrs.rows ?? ''}
        placeholder="All"
        onChange={(e) => set({ rows: rowsValue(e.target.value) })}
        hint="Blank = every team."
      />
      <Field
        label="Heading"
        value={attrs.title ?? ''}
        maxLength={120}
        placeholder="<League> Ladder"
        onChange={(e) => set({ title: e.target.value || null })}
      />
      <Checkbox label="Show “Week 4 of 9 · Updated …”" checked={attrs.showHeading} onChange={(v) => set({ showHeading: v })} />
      <Checkbox label="Link to the full ladder" checked={attrs.showLink} onChange={(v) => set({ showLink: v })} />
    </div>
  )
}

const RANGE_LABELS: Record<(typeof fixtureRanges)[number], string> = {
  this_week: 'This week (the next game night)',
  upcoming: 'Upcoming',
  results: 'Results (newest first)',
  all: 'The whole season',
}

function FixturesSettings({ attrs, choices, onChange }: { attrs: FixturesAttrs; choices: Choices; onChange: (a: FixturesAttrs) => void }) {
  const set = (p: Partial<FixturesAttrs>) => onChange({ ...attrs, ...p })
  const teams = choices.leagues.find((l) => l.id === attrs.leagueId)?.teams ?? []
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <LeagueSelect value={attrs.leagueId} choices={choices} onChange={(leagueId) => set({ leagueId, teamId: null })} />
      <Select label="Show" value={attrs.range} onChange={(e) => set({ range: e.target.value as FixturesAttrs['range'] })}>
        {fixtureRanges.map((r) => (
          <option key={r} value={r}>
            {RANGE_LABELS[r]}
          </option>
        ))}
      </Select>
      <Select label="Display" value={attrs.display} onChange={(e) => set({ display: e.target.value as FixturesAttrs['display'] })}>
        {blockDisplays.map((d) => (
          <option key={d} value={d}>
            {DISPLAY_LABELS[d]}
          </option>
        ))}
      </Select>
      <Field
        label="Game nights"
        type="number"
        min={1}
        max={52}
        value={attrs.range === 'this_week' ? 1 : (attrs.matchDays ?? '')}
        disabled={attrs.range === 'this_week'}
        placeholder="All"
        onChange={(e) => set({ matchDays: rowsValue(e.target.value) })}
        hint="How many nights to show. Blank = all."
      />
      <Select
        label="Team"
        value={attrs.teamId ?? ''}
        onChange={(e) => set({ teamId: e.target.value || null })}
        hint="One team’s games, duties and byes."
      >
        <option value="">Every team</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
      <Field
        label="Heading"
        value={attrs.title ?? ''}
        maxLength={120}
        placeholder="<League> Fixtures"
        onChange={(e) => set({ title: e.target.value || null })}
      />
      <Checkbox label="Court column" checked={attrs.showCourt} onChange={(v) => set({ showCourt: v })} />
      <Checkbox label="Duty column (full display, leagues with duty)" checked={attrs.showDuty} onChange={(v) => set({ showDuty: v })} />
      <Checkbox label="Link to all fixtures and results" checked={attrs.showLink} onChange={(v) => set({ showLink: v })} />
    </div>
  )
}
