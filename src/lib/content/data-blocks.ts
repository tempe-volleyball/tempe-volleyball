import { programmeKinds, type PageDataRefKind, type ProgrammeKind, type ProgrammeStatus } from '../../server/db/schema/enums'
import { formatAU } from '../fixtures/dates'
import {
  WEEKDAYS,
  generatedSummaryLine,
  nextStartsLine,
  programmeLineSource,
  summaryLine,
  venueSuburb,
  type ProgrammeTextInput,
} from '../programme-text'
import { enrolmentOpen, isListedStatus, programmePath } from '../programmes'
import { leagueFixturesRoute, leagueLadderRoute } from '../wp-import/routes'
import {
  DATA_BLOCK_REF_KIND,
  DEFAULT_FIXTURES_ATTRS,
  DEFAULT_LADDER_ATTRS,
  DEFAULT_PROGRAMME_LIST_ATTRS,
  DEFAULT_VENUES_ATTRS,
  PROGRAMME_LINE_SOURCE_KEYS,
  PROGRAMME_TEMPLATE_PLACEHOLDERS,
  blockDisplays,
  changedSourceFields,
  enrolmentFilters,
  fixtureRanges,
  type BlockDisplay,
  type EnrolmentFilter,
  type FixturesAttrs,
  type LadderAttrs,
  type ProgrammeLineOverride,
  type ProgrammeLineSource,
  type ProgrammeListAttrs,
  type VenuesAttrs,
} from './blocks'
import { escapeHtml, isDataBlock, safeHref, type JsonNode } from './render'

// The data blocks in the page editor (docs/admin.md §3.4), the pure half: normalising their attrs, working out a
// Programme list's lines (which text wins, what changed since an override), choosing a Fixtures block's rows, and
// writing each block's HTML. src/server/content/blocks.ts loads the data from D1 and calls these at view time.
// Everything here is linear in the data and escapes every value, so it's cheap and safe for the Worker.

// ── Attrs ─────────────────────────────────────────────────────────────────────

/** Bounds for stored attrs, so a block can't bloat a page or a render. */
export const BLOCK_LIMITS = { template: 300, text: 300, title: 120, ids: 200, rows: 100, matchDays: 52 } as const

const ID_RE = /^[\w-]{1,64}$/

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = v.replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : null
}

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))].slice(0, BLOCK_LIMITS.ids) : []

const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
  (list as readonly unknown[]).includes(v) ? (v as T) : fallback

const count = (v: unknown, max: number, fallback: number | null): number | null => {
  if (v === null) return null
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : fallback
}

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

function lineSource(v: unknown): ProgrammeLineSource {
  const r = record(v)
  const out = {} as ProgrammeLineSource
  for (const k of PROGRAMME_LINE_SOURCE_KEYS) out[k] = typeof r[k] === 'string' ? r[k].slice(0, BLOCK_LIMITS.text) : ''
  return out
}

/** Any stored or posted value -> valid Programme list attrs (unknown fields dropped, bad ones defaulted). */
export function parseProgrammeListAttrs(raw: unknown): ProgrammeListAttrs {
  const a = record(raw)
  const f = record(a.filter)
  const overrides: Record<string, ProgrammeLineOverride> = {}
  for (const [id, o] of Object.entries(record(a.overrides)).slice(0, BLOCK_LIMITS.ids)) {
    const r = record(o)
    const t = text(r.text, BLOCK_LIMITS.text)
    if (!ID_RE.test(id) || !t) continue
    overrides[id] = { text: t, source: lineSource(r.source), editedAt: typeof r.editedAt === 'string' ? r.editedAt.slice(0, 40) : '' }
  }
  const legacyOpen = f.enrolmentOpenOnly === true
  const enrolment = oneOf<EnrolmentFilter>(f.enrolment, enrolmentFilters, legacyOpen ? 'open' : 'any')
  return {
    filter: {
      categoryIds: ids(f.categoryIds),
      kinds: Array.isArray(f.kinds) ? programmeKinds.filter((k) => (f.kinds as unknown[]).includes(k)) : [],
      enrolmentOpenOnly: enrolment === 'open',
      enrolment,
    },
    template: text(a.template, BLOCK_LIMITS.template),
    order: ids(a.order),
    hidden: ids(a.hidden),
    overrides,
    title: text(a.title, BLOCK_LIMITS.title),
    linkLines: bool(a.linkLines, DEFAULT_PROGRAMME_LIST_ATTRS.linkLines),
    useSummaryLines: bool(a.useSummaryLines, DEFAULT_PROGRAMME_LIST_ATTRS.useSummaryLines),
    emptyText: text(a.emptyText, BLOCK_LIMITS.text),
  }
}

const leagueId = (v: unknown) => (typeof v === 'string' && ID_RE.test(v) ? v : '')

export function parseLadderAttrs(raw: unknown): LadderAttrs {
  const a = record(raw)
  const d = DEFAULT_LADDER_ATTRS
  return {
    leagueId: leagueId(a.leagueId),
    display: oneOf<BlockDisplay>(a.display, blockDisplays, d.display),
    rows: count(a.rows, BLOCK_LIMITS.rows, d.rows),
    title: text(a.title, BLOCK_LIMITS.title),
    showHeading: bool(a.showHeading, d.showHeading),
    showLink: bool(a.showLink, d.showLink),
  }
}

export function parseFixturesAttrs(raw: unknown): FixturesAttrs {
  const a = record(raw)
  const d = DEFAULT_FIXTURES_ATTRS
  return {
    leagueId: leagueId(a.leagueId),
    range: oneOf(a.range, fixtureRanges, d.range),
    display: oneOf<BlockDisplay>(a.display, blockDisplays, d.display),
    matchDays: count(a.matchDays, BLOCK_LIMITS.matchDays, d.matchDays),
    teamId: typeof a.teamId === 'string' && ID_RE.test(a.teamId) ? a.teamId : null,
    title: text(a.title, BLOCK_LIMITS.title),
    showDuty: bool(a.showDuty, d.showDuty),
    showCourt: bool(a.showCourt, d.showCourt),
    showLink: bool(a.showLink, d.showLink),
  }
}

export function parseVenuesAttrs(raw: unknown): VenuesAttrs {
  const a = record(raw)
  const d = DEFAULT_VENUES_ATTRS
  return {
    venueIds: ids(a.venueIds),
    title: text(a.title, BLOCK_LIMITS.title),
    showAddress: bool(a.showAddress, d.showAddress),
    showMap: bool(a.showMap, d.showMap),
    showDirections: bool(a.showDirections, d.showDirections),
    showProgrammes: bool(a.showProgrammes, d.showProgrammes),
  }
}

export type ParsedDataBlock =
  | { type: 'programmeList'; attrs: ProgrammeListAttrs }
  | { type: 'ladder'; attrs: LadderAttrs }
  | { type: 'fixtures'; attrs: FixturesAttrs }
  | { type: 'venues'; attrs: VenuesAttrs }

export function parseDataBlock(node: JsonNode): ParsedDataBlock | null {
  switch (node.type) {
    case 'programmeList':
      return { type: 'programmeList', attrs: parseProgrammeListAttrs(node.attrs) }
    case 'ladder':
      return { type: 'ladder', attrs: parseLadderAttrs(node.attrs) }
    case 'fixtures':
      return { type: 'fixtures', attrs: parseFixturesAttrs(node.attrs) }
    case 'venues':
      return { type: 'venues', attrs: parseVenuesAttrs(node.attrs) }
    default:
      return null
  }
}

/** Visits every node in document order (data blocks can sit at any depth, though the editor puts them at the top level). */
function walk(blocks: readonly JsonNode[], visit: (n: JsonNode) => void) {
  const stack = blocks.toReversed()
  while (stack.length) {
    const n = stack.pop()
    if (!n || typeof n !== 'object') continue
    visit(n)
    if (Array.isArray(n.content)) stack.push(...n.content.toReversed())
  }
}

/** The data blocks in a body, in document order. */
export function dataBlocksIn(blocks: readonly JsonNode[]): ParsedDataBlock[] {
  const out: ParsedDataBlock[] = []
  walk(blocks, (n) => {
    const b = isDataBlock(n) ? parseDataBlock(n) : null
    if (b) out.push(b)
  })
  return out
}

/**
 * The body as it should be stored: every data block's attrs replaced by the normalised ones (so junk never reaches
 * D1 and the size stays bounded). Other nodes are returned as they are.
 */
export function normaliseDataBlocks(blocks: JsonNode[]): JsonNode[] {
  const fix = (n: JsonNode): JsonNode => {
    if (!n || typeof n !== 'object') return n
    if (isDataBlock(n)) {
      const b = parseDataBlock(n)
      return b ? { type: b.type, attrs: b.attrs as unknown as Record<string, unknown> } : n
    }
    return Array.isArray(n.content) ? { ...n, content: n.content.map(fix) } : n
  }
  return blocks.map(fix)
}

/** page_data_refs rows for a body: programme_list with ref '', ladder/fixtures with the league id (venues: none). Unique. */
export function dataBlockRefs(blocks: readonly JsonNode[]): { kind: PageDataRefKind; refId: string }[] {
  const seen = new Map<string, { kind: PageDataRefKind; refId: string }>()
  for (const b of dataBlocksIn(blocks)) {
    const kind = DATA_BLOCK_REF_KIND[b.type]
    if (!kind) continue
    const refId = b.type === 'ladder' || b.type === 'fixtures' ? b.attrs.leagueId : ''
    if (kind !== 'programme_list' && !refId) continue
    seen.set(`${kind}:${refId}`, { kind, refId })
  }
  return [...seen.values()]
}

// ── Programme list ────────────────────────────────────────────────────────────

/** A programme as a Programme list reads it (a leagues row satisfies it). */
export type BlockProgramme = ProgrammeTextInput & {
  id: string
  slug: string
  status: ProgrammeStatus
  categoryId: string | null
  sort: number
  defaultVenueId: string | null
  priceCents: number | null
  enrolmentOpen: boolean
  enrolmentOpensAt: string | null
  enrolmentClosesAt: string | null
}

export type BlockVenue = { id: string; name: string; address: string | null }
export type BlockCategory = { id: string; name: string; sort: number }

export type ProgrammeListData = {
  programmes: readonly BlockProgramme[]
  categories: readonly BlockCategory[]
  venues: readonly BlockVenue[]
  /** Programme id -> the start date of its next season/session/term/event (nextInstanceQueries). */
  nextInstance: ReadonlyMap<string, string>
  /** UTC ISO, for "enrolment open". */
  nowIso: string
}

/**
 * Where a line's text came from (docs/admin.md §3.4): page override → the programme's own summary line → this
 * block's template (only when it has one) → the generated summary line, the same text category pages, /enrol and
 * the admin show, so a programme reads the same everywhere unless Michael asks otherwise.
 */
export type LineSourceKind = 'override' | 'summary' | 'template' | 'generated'

export type ProgrammeLine = {
  id: string
  name: string
  code: string
  kind: ProgrammeKind
  href: string
  /** The line as shown (plain text; a {link} shows as "More info"). */
  text: string
  html: string
  source: LineSourceKind
  /** Hidden on this page (only returned with includeHidden). */
  hidden: boolean
  override: ProgrammeLineOverride | null
  /** Source fields that changed since the override was written (empty without an override). */
  changed: (keyof ProgrammeLineSource)[]
  /** The programme's details now: the snapshot to store when Michael overrides the line. */
  current: ProgrammeLineSource
  /** What the line says without the override (the summary line, the template or the generated line). */
  automatic: string
  enrolmentOpen: boolean
}

// A private-use character pair marks {link} while the text is tidied, so no typed text can collide with it.
const LINK = '\uE000link\uE000'

/** "$125" for whole dollars, "$12.50" otherwise. */
const price = (cents: number | null) =>
  cents === null ? '' : cents % 100 === 0 ? `$${(cents / 100).toLocaleString('en-AU')}` : `$${(cents / 100).toFixed(2)}`

const ALIASES: Record<string, string> = { nextStart: 'nextStarts', next: 'nextStarts', when: 'times' }
const PLACEHOLDERS: ReadonlySet<string> = new Set(PROGRAMME_TEMPLATE_PLACEHOLDERS)

/**
 * Fills {placeholders} (PROGRAMME_TEMPLATE_PLACEHOLDERS, plus the aliases {nextStart} {next} {when}); unknown ones are
 * left as typed so a typo shows. Then tidies what empty values leave behind: "()", a dangling "@", doubled spaces
 * and stray separators. {link} comes back as the LINK marker for the caller to turn into an anchor.
 */
export function fillTemplate(template: string, values: Record<string, string>): string {
  const filled = template.replace(/\{(\w+)\}/g, (whole, raw: string) => {
    const key = ALIASES[raw] ?? raw
    if (!PLACEHOLDERS.has(key)) return whole
    return key === 'link' ? LINK : (values[key] ?? '')
  })
  return filled
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s@\s*(?=$|[,;:)(]|\uE000)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/([(])\s+/g, '$1')
    .replace(/^[\s,;:@–—-]+|[\s,;:@–—-]+$/g, '')
    .replace(/(?:[,;:]\s*){2,}/g, ', ')
    .trim()
}

const isOpen = (p: BlockProgramme, nowIso: string) =>
  enrolmentOpen({ open: p.enrolmentOpen, status: p.status, opensAt: p.enrolmentOpensAt, closesAt: p.enrolmentClosesAt }, null, nowIso)

/**
 * The block's lines: active programmes matching the filter, in the block's order (dragged ids first, then the rest by
 * category order, programme order and name, so new programmes join on their own). Retired and draft programmes never
 * appear, overrides or not. Hidden ones are left out unless `includeHidden` (the editor lists them to unhide).
 */
export function programmeLines(
  attrs: ProgrammeListAttrs,
  data: ProgrammeListData,
  opts: { includeHidden?: boolean } = {},
): ProgrammeLine[] {
  const venues = new Map(data.venues.map((v) => [v.id, v]))
  const cats = new Map(data.categories.map((c) => [c.id, c]))
  const { categoryIds = [], kinds = [] } = attrs.filter
  const enrolment = attrs.filter.enrolment ?? (attrs.filter.enrolmentOpenOnly ? 'open' : 'any')
  const hidden = new Set(attrs.hidden)
  const position = new Map(attrs.order.map((id, i) => [id, i]))
  const catSort = (p: BlockProgramme) => (p.categoryId ? (cats.get(p.categoryId)?.sort ?? 1e6) : 1e6)

  const matching = data.programmes.filter((p) => {
    if (!isListedStatus(p.status)) return false
    if (categoryIds.length && !(p.categoryId && categoryIds.includes(p.categoryId))) return false
    if (kinds.length && !kinds.includes(p.kind)) return false
    if (enrolment !== 'any' && isOpen(p, data.nowIso) !== (enrolment === 'open')) return false
    return opts.includeHidden || !hidden.has(p.id)
  })
  const ordered = matching.toSorted(
    (a, b) =>
      (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity) ||
      catSort(a) - catSort(b) ||
      a.sort - b.sort ||
      a.name.localeCompare(b.name),
  )

  return ordered.map((p): ProgrammeLine => {
    const venue = p.defaultVenueId ? venues.get(p.defaultVenueId) : undefined
    const next = data.nextInstance.get(p.id) ?? null
    const current = programmeLineSource(p, venue, next)
    const href = programmePath(p.kind, p.slug)
    const values: Record<string, string> = {
      name: p.name,
      code: p.code,
      venue: current.venue,
      suburb: venueSuburb(venue?.address),
      day: p.kind === 'event' ? '' : (WEEKDAYS[p.weekday] ?? ''),
      times: current.times,
      nextStarts: nextStartsLine(p, next),
      category: p.categoryId ? (cats.get(p.categoryId)?.name ?? '') : '',
      summary: summaryLine(p, venue),
      price: price(p.priceCents),
    }
    const own = p.summaryLine?.trim()
    const automaticSource: LineSourceKind = own && attrs.useSummaryLines ? 'summary' : attrs.template ? 'template' : 'generated'
    const automaticRaw =
      automaticSource === 'summary' ? own! : attrs.template ? fillTemplate(attrs.template, values) : generatedSummaryLine(p, venue)
    const override = attrs.overrides[p.id] ?? null
    const raw = override ? fillTemplate(override.text, values) : automaticRaw
    const hasLink = raw.includes(LINK)
    const linkHtml = `<a href="${escapeHtml(href)}">More info<span class="sr-only"> about ${escapeHtml(p.name)}</span></a>`
    const body = raw.split(LINK).map(escapeHtml).join(linkHtml)
    return {
      id: p.id,
      name: p.name,
      code: p.code,
      kind: p.kind,
      href,
      text: raw.split(LINK).join('More info'),
      html: hasLink || !attrs.linkLines ? body : `<a href="${escapeHtml(href)}">${body}</a>`,
      source: override ? 'override' : automaticSource,
      hidden: hidden.has(p.id),
      override,
      changed: override ? changedSourceFields(override.source, current) : [],
      current,
      automatic: automaticRaw.split(LINK).join('More info'),
      enrolmentOpen: isOpen(p, data.nowIso),
    }
  })
}

/** A Programme list's HTML: an optional heading and one list item per line (or the empty text, or nothing). */
export function renderProgrammeList(attrs: ProgrammeListAttrs, data: ProgrammeListData): string {
  const lines = programmeLines(attrs, data)
  const title = attrs.title ? `<h2>${escapeHtml(attrs.title)}</h2>` : ''
  if (lines.length === 0)
    return attrs.emptyText ? `<div class="data-block programme-list">${title}<p>${escapeHtml(attrs.emptyText)}</p></div>` : ''
  return `<div class="data-block programme-list">${title}<ul>${lines.map((l) => `<li>${l.html}</li>`).join('')}</ul></div>`
}

// ── Ladder ────────────────────────────────────────────────────────────────────

export type LadderRowLike = {
  pos: number
  name: string
  points: number
  played: number
  won: number
  drawn: number
  lost: number
  setsFor: number
  setsAgainst: number
  pointsFor: number
  pointsAgainst: number
  ratio: string
}

/** A league's current season as the Ladder and Fixtures blocks read it. */
export type LeagueBlockData = {
  league: { id: string; name: string; code: string; slug: string }
  seasonName: string
  /** "Ladder – Week 4 of 9" (the generated heading). */
  heading: string
  /** "Updated 16/10/2026", or ''. */
  updated: string
  ladder: readonly LadderRowLike[]
  fixtures: readonly FixtureRowLike[]
  /** Fixture row key -> the team ids it involves (home, away, duty; or the bye team), for the team filter. */
  rowTeams: ReadonlyMap<string, readonly string[]>
  dutyEnabled: boolean
}

const th = (label: string, title?: string, cls?: string) =>
  `<th scope="col"${cls ? ` class="${cls}"` : ''}>${title ? `<abbr title="${escapeHtml(title)}">${label}</abbr>` : label}</th>`

const link = (href: string, label: string) => `<p class="data-block-link"><a href="${escapeHtml(href)}">${label}</a></p>`

/** A Ladder block: the league's current season ladder, compact (Pos, Team, Pts, P, W/D/L from small screens) or full. */
export function renderLadder(attrs: LadderAttrs, data: LeagueBlockData | undefined): string {
  if (!data) return ''
  const full = attrs.display === 'full'
  const rows = attrs.rows ? data.ladder.slice(0, attrs.rows) : data.ladder
  const title = attrs.title ?? `${data.league.name} Ladder`
  const wide = full ? 'num' : 'num hidden sm:table-cell'
  const head = [
    th('Pos', undefined, 'w-10'),
    th('Team'),
    th('Pts', 'Ladder points', 'num'),
    th('P', 'Played', 'num'),
    th('W', 'Won', wide),
    th('D', 'Drawn', wide),
    th('L', 'Lost', wide),
    ...(full
      ? [
          th('S+', 'Sets won', 'num'),
          th('S-', 'Sets lost', 'num'),
          th('P+', 'Points for', 'num'),
          th('P-', 'Points against', 'num'),
          th('Ratio', 'Points for ÷ all points', 'num'),
        ]
      : []),
  ].join('')
  const cols = full ? 12 : 7
  const body = rows.length
    ? rows
        .map((r) => {
          const cells = [
            `<td>${r.pos}</td>`,
            `<th scope="row" class="team">${escapeHtml(r.name)}</th>`,
            `<td class="num font-bold text-white">${r.points}</td>`,
            `<td class="num">${r.played}</td>`,
            `<td class="${wide}">${r.won}</td>`,
            `<td class="${wide}">${r.drawn}</td>`,
            `<td class="${wide}">${r.lost}</td>`,
            ...(full
              ? [r.setsFor, r.setsAgainst, r.pointsFor, r.pointsAgainst]
                  .map((n) => `<td class="num">${n}</td>`)
                  .concat(`<td class="num">${escapeHtml(r.ratio)}</td>`)
              : []),
          ]
          return `<tr>${cells.join('')}</tr>`
        })
        .join('')
    : `<tr><td colspan="${cols}">No teams yet.</td></tr>`
  const meta = attrs.showHeading ? [data.heading, data.updated].filter(Boolean).join(' · ') : ''
  return [
    `<section class="data-block ladder-block">`,
    `<h2>${escapeHtml(title)}</h2>`,
    meta ? `<p class="data-block-meta">${escapeHtml(meta)}</p>` : '',
    `<div class="table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(`${data.seasonName} ladder`)}">`,
    `<table class="data-table${full ? '' : ' compact'}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    attrs.showLink ? link(leagueLadderRoute(data.league.slug), `Full ${escapeHtml(data.league.code)} ladder`) : '',
    `</section>`,
  ].join('')
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A fixtures row (FixtureRow in src/server/competition/adapter.ts satisfies it). */
export type FixtureRowLike = {
  key: string
  date: string
  matchDay: number
  time: string
  match: string
  result: string
  sets: string
  court: string
  duty: string
  kind: 'game' | 'bye' | 'skip'
  forfeit: boolean
}

/**
 * The rows a Fixtures block shows, grouped by date in season order (results: newest first):
 *  - this_week: the first date on or after `today` (tonight's games until midnight, then the next night).
 *  - upcoming: dates on or after today; results: dates with a published result; all: the whole season.
 * `matchDays` caps the number of dates (this_week is always one). A team filter keeps that team's games, duties and
 * bye, plus nights with no games.
 */
export function selectFixtureRows(
  attrs: FixturesAttrs,
  data: Pick<LeagueBlockData, 'fixtures' | 'rowTeams'>,
  today: string,
): FixtureRowLike[] {
  let rows = data.fixtures
  if (attrs.teamId) rows = rows.filter((r) => r.kind === 'skip' || (data.rowTeams.get(r.key) ?? []).includes(attrs.teamId!))
  if (attrs.range === 'results') rows = rows.filter((r) => r.kind === 'game' && r.result !== '' && r.result !== 'Cancelled')
  else if (attrs.range !== 'all') rows = rows.filter((r) => r.date >= today)
  const dates = [...new Set(rows.map((r) => r.date))]
  if (attrs.range === 'results') dates.reverse()
  const limit = attrs.range === 'this_week' ? 1 : attrs.matchDays
  const keep = limit ? dates.slice(0, limit) : dates
  const order = new Map(keep.map((d, i) => [d, i]))
  return rows.filter((r) => order.has(r.date)).toSorted((a, b) => order.get(a.date)! - order.get(b.date)!)
}

const EMPTY_FIXTURES: Record<FixturesAttrs['range'], string> = {
  this_week: 'No games coming up.',
  upcoming: 'No games coming up.',
  results: 'No results yet.',
  all: "The draw hasn't been published yet.",
}

/** A Fixtures block: the league's current season, filtered to this week, upcoming, results or all. */
export function renderFixtures(attrs: FixturesAttrs, data: LeagueBlockData | undefined, today: string): string {
  if (!data) return ''
  const full = attrs.display === 'full'
  const duty = attrs.showDuty && data.dutyEnabled && full
  const court = attrs.showCourt
  const rows = selectFixtureRows(attrs, data, today)
  const title = attrs.title ?? `${data.league.name} ${attrs.range === 'results' ? 'Results' : 'Fixtures'}`
  const head = [
    th('Date'),
    th('Match'),
    th('Time'),
    th('Result'),
    ...(court ? [th('Court')] : []),
    ...(full ? [th('Match Day')] : []),
    ...(duty ? [th('Duty')] : []),
  ]
  const cols = head.length
  const body = rows.length
    ? rows
        .map((r) => {
          if (r.kind === 'skip')
            return `<tr><td class="whitespace-nowrap">${formatAU(r.date)}</td><td colspan="${cols - 1}" class="italic">${escapeHtml(r.match)}</td></tr>`
          const result = `${escapeHtml(r.result)}${r.forfeit ? '<span class="block text-xs">(forfeit)</span>' : ''}${full && r.sets ? `<span class="block text-xs">${escapeHtml(r.sets)}</span>` : ''}`
          return `<tr>${[
            `<td class="whitespace-nowrap">${formatAU(r.date)}</td>`,
            `<td class="team">${escapeHtml(r.match)}</td>`,
            `<td>${escapeHtml(r.time)}</td>`,
            `<td class="whitespace-nowrap">${result}</td>`,
            ...(court ? [`<td class="whitespace-nowrap">${escapeHtml(r.court)}</td>`] : []),
            ...(full ? [`<td>${r.matchDay || ''}</td>`] : []),
            ...(duty ? [`<td>${escapeHtml(r.duty)}</td>`] : []),
          ].join('')}</tr>`
        })
        .join('')
    : `<tr><td colspan="${cols}">${EMPTY_FIXTURES[attrs.range]}</td></tr>`
  return [
    `<section class="data-block fixtures-block">`,
    `<h2>${escapeHtml(title)}</h2>`,
    `<div class="table-scroll" tabindex="0" role="region" aria-label="${escapeHtml(`${data.seasonName} ${attrs.range === 'results' ? 'results' : 'fixtures'}`)}">`,
    `<table class="data-table${full ? '' : ' compact'}"><thead><tr>${head.join('')}</tr></thead><tbody>${body}</tbody></table></div>`,
    attrs.showLink ? link(leagueFixturesRoute(data.league.slug), `All ${escapeHtml(data.league.code)} fixtures and results`) : '',
    `</section>`,
  ].join('')
}

// ── Venues ────────────────────────────────────────────────────────────────────

/** A venue as the Venues block reads it (a venues row satisfies it). */
export type VenueBlockVenue = {
  id: string
  name: string
  slug: string
  address: string | null
  mapUrl: string | null
  directions: string | null
}

/** A programme as the Venues block's "who plays here" reads it. */
export type VenueBlockProgramme = Pick<BlockProgramme, 'id' | 'kind' | 'name' | 'slug' | 'status' | 'sort' | 'defaultVenueId'>

export type VenuesBlockData = { venues: readonly VenueBlockVenue[]; programmes: readonly VenueBlockProgramme[] }

/** The venues a block shows: the chosen ones in the chosen order (unknown ids skipped), or every venue. */
export function selectVenues(attrs: Pick<VenuesAttrs, 'venueIds'>, venues: readonly VenueBlockVenue[]): VenueBlockVenue[] {
  if (!attrs.venueIds.length) return [...venues]
  const byId = new Map(venues.map((v) => [v.id, v]))
  return attrs.venueIds.flatMap((id) => byId.get(id) ?? [])
}

/** The venue's own map link when it's a safe http(s) URL, else a Google Maps search for its name and address. */
export function venueMapHref(v: Pick<VenueBlockVenue, 'name' | 'address' | 'mapUrl'>): string | null {
  const own = v.mapUrl ? safeHref(v.mapUrl) : null
  if (own && /^https?:\/\//i.test(own)) return own
  if (!v.address) return null
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name}, ${v.address}`)}`
}

/** Directions as typed (Admin → Venues): blank lines split paragraphs, single line breaks stay. Escaped. */
const directionsHtml = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.split('\n').map(escapeHtml).join('<br>')}</p>`)
    .join('')

/**
 * A Venues block: each venue's name (with an id to link to, #venue-<slug>), address, map link, directions and the active
 * programmes that usually play there. '' when there are no venues to show.
 */
export function renderVenues(attrs: VenuesAttrs, data: VenuesBlockData): string {
  const list = selectVenues(attrs, data.venues)
  if (list.length === 0) return ''
  const h = attrs.title ? 'h3' : 'h2'
  const programmes = data.programmes
    .filter((p) => isListedStatus(p.status))
    .toSorted((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
  const venues = list.map((v) => {
    const map = attrs.showMap ? venueMapHref(v) : null
    const here = attrs.showProgrammes ? programmes.filter((p) => p.defaultVenueId === v.id) : []
    return [
      `<div class="venue" id="venue-${escapeHtml(v.slug)}">`,
      `<${h}>${escapeHtml(v.name)}</${h}>`,
      attrs.showAddress && v.address ? `<p class="venue-address">${escapeHtml(v.address)}</p>` : '',
      map
        ? `<p class="data-block-link"><a href="${escapeHtml(map)}" target="_blank" rel="noopener">Map and directions<span class="sr-only"> to ${escapeHtml(v.name)}</span></a></p>`
        : '',
      attrs.showDirections && v.directions ? `<div class="venue-directions">${directionsHtml(v.directions)}</div>` : '',
      here.length
        ? `<p class="venue-programmes"><strong>Who plays here:</strong> ${here
            .map((p) => `<a href="${escapeHtml(programmePath(p.kind, p.slug))}">${escapeHtml(p.name)}</a>`)
            .join(', ')}</p>`
        : '',
      `</div>`,
    ].join('')
  })
  return [
    `<section class="data-block venues-block">`,
    attrs.title ? `<h2>${escapeHtml(attrs.title)}</h2>` : '',
    venues.join(''),
    `</section>`,
  ].join('')
}
