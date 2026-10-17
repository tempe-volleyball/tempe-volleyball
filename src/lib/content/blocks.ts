import type { PageDataRefKind, ProgrammeKind } from '../../server/db/schema/enums'

// Data blocks in the page editor (docs/admin.md §3.4): nodes inside a page body's TipTap JSON (pages.body.blocks),
// rendered on the server from programme and league data. No table holds them; page_data_refs records which data a
// page's blocks read so data changes purge the right pages. Types only, plus the defaults every consumer must agree on.
//
// Each block is a TipTap atom node: { type: '<name>', attrs: <Attrs> }. Unknown or malformed attrs fall back to the
// defaults below, so an old page never breaks when a field is added.

// ── Programme list ────────────────────────────────────────────────────────────

/** What a programme list shows. Empty arrays / missing fields mean "no restriction". */
export type ProgrammeListFilter = {
  /** categories.id; empty = every category. */
  categoryIds?: string[]
  /** Empty = every kind. */
  kinds?: ProgrammeKind[]
  /** Only programmes whose enrolment is open right now. */
  enrolmentOpenOnly?: boolean
}

/**
 * The programme details a line is generated from, captured when Michael overrides a line. Comparing it with the
 * current values is how the editor flags "TNL's venue changed since you edited this line". All strings, already
 * formatted (as they'd appear in the generated line), so the comparison is a plain field-by-field equality.
 */
export type ProgrammeLineSource = {
  name: string
  code: string
  venue: string
  /** Day and times as shown ("Thursdays 8–10pm"). */
  times: string
  /** "Next season starts …" as shown, or ''. */
  nextStarts: string
  /** The programme's own summary line (leagues.summary_line), or '' when generated. */
  summaryLine: string
}

export const PROGRAMME_LINE_SOURCE_KEYS = [
  'name',
  'code',
  'venue',
  'times',
  'nextStarts',
  'summaryLine',
] as const satisfies readonly (keyof ProgrammeLineSource)[]

/** A hand-written line for one programme on this page. Wins over the summary line and the template. */
export type ProgrammeLineOverride = {
  /** Plain text with the same {placeholders} as the template allowed. */
  text: string
  /** The programme's details when the override was written. */
  source: ProgrammeLineSource
  /** UTC ISO. */
  editedAt: string
}

export type ProgrammeListAttrs = {
  filter: ProgrammeListFilter
  /** Line template with {placeholders} (PROGRAMME_TEMPLATE_PLACEHOLDERS). Null = DEFAULT_PROGRAMME_LINE_TEMPLATE. */
  template: string | null
  /**
   * leagues.id in the order Michael dragged them. Programmes not listed (new ones) follow, in category sort then
   * programme sort order. Ids that no longer match the filter are ignored.
   */
  order: string[]
  /** leagues.id hidden on this page only. */
  hidden: string[]
  /** Per-programme overrides keyed by leagues.id. Retired programmes drop out even when overridden. */
  overrides: Record<string, ProgrammeLineOverride>
  /** Optional heading above the list. */
  title: string | null
  /** Each line links to the programme page. */
  linkLines: boolean
  /** What to show when nothing matches ("Enrolments open soon"). Null = render nothing. */
  emptyText: string | null
}

export type ProgrammeListBlock = { type: 'programmeList'; attrs: ProgrammeListAttrs }

/**
 * Placeholders for line templates. Missing values render as '' and the renderer tidies the leftover punctuation
 * ("()" and doubled spaces).
 */
export const PROGRAMME_TEMPLATE_PLACEHOLDERS = [
  'name',
  'code',
  'venue',
  'suburb',
  'day',
  'times',
  'nextStarts',
  'category',
  'summary',
  'price',
] as const
export type ProgrammeTemplatePlaceholder = (typeof PROGRAMME_TEMPLATE_PLACEHOLDERS)[number]

export const DEFAULT_PROGRAMME_LINE_TEMPLATE = 'Next {name} ({code}) @ {venue} ({times})'

export const DEFAULT_PROGRAMME_LIST_ATTRS: ProgrammeListAttrs = {
  filter: {},
  template: null,
  order: [],
  hidden: [],
  overrides: {},
  title: null,
  linkLines: true,
  emptyText: null,
}

/** Which source fields differ between an override's snapshot and the programme now (empty = unchanged). */
export function changedSourceFields(then: ProgrammeLineSource, now: ProgrammeLineSource): (keyof ProgrammeLineSource)[] {
  return PROGRAMME_LINE_SOURCE_KEYS.filter((k) => (then[k] ?? '') !== (now[k] ?? ''))
}

// ── Ladder and fixtures ───────────────────────────────────────────────────────

/** compact: Pos, Team, Pts, P (and W/D/L on wide screens). full: every ladder column. */
export const blockDisplays = ['compact', 'full'] as const
export type BlockDisplay = (typeof blockDisplays)[number]

export type LadderAttrs = {
  /** leagues.id (kind 'league'). The block always shows that league's current season. */
  leagueId: string
  display: BlockDisplay
  /** Top N rows; null = all. */
  rows: number | null
  /** Null = "<League name> ladder". */
  title: string | null
  /** The generated "Week 4 of 9 · Updated 16/10/2026" line. */
  showHeading: boolean
  /** Link to the league page's Ladder tab. */
  showLink: boolean
}

export type LadderBlock = { type: 'ladder'; attrs: LadderAttrs }

/**
 * this_week: the next (or tonight's) match day. upcoming: from today on. results: played games, newest first.
 * all: the whole season.
 */
export const fixtureRanges = ['this_week', 'upcoming', 'results', 'all'] as const
export type FixtureRange = (typeof fixtureRanges)[number]

export type FixturesAttrs = {
  leagueId: string
  range: FixtureRange
  display: BlockDisplay
  /** At most this many match days; null = no limit. */
  matchDays: number | null
  /** One team's games only (teams.id); null = everyone. */
  teamId: string | null
  /** Null = "<League name> fixtures" / "results". */
  title: string | null
  /** Duty column (ignored for leagues without duty). */
  showDuty: boolean
  showCourt: boolean
  showLink: boolean
}

export type FixturesBlock = { type: 'fixtures'; attrs: FixturesAttrs }

export const DEFAULT_LADDER_ATTRS: Omit<LadderAttrs, 'leagueId'> = {
  display: 'compact',
  rows: null,
  title: null,
  showHeading: true,
  showLink: true,
}

export const DEFAULT_FIXTURES_ATTRS: Omit<FixturesAttrs, 'leagueId'> = {
  range: 'this_week',
  display: 'compact',
  matchDays: 1,
  teamId: null,
  title: null,
  showDuty: true,
  showCourt: true,
  showLink: true,
}

export type DataBlock = ProgrammeListBlock | LadderBlock | FixturesBlock

/** TipTap node names of the data blocks, for the editor, the renderer's allowlist and page_data_refs. */
export const DATA_BLOCK_TYPES = ['programmeList', 'ladder', 'fixtures'] as const satisfies readonly DataBlock['type'][]

/** The page_data_refs.kind each block type writes. */
export const DATA_BLOCK_REF_KIND = { programmeList: 'programme_list', ladder: 'ladder', fixtures: 'fixtures' } as const satisfies Record<
  DataBlock['type'],
  PageDataRefKind
>
