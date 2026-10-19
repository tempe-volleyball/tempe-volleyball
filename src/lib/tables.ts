import { escapeHtml } from './content/render'
import { formatAU } from './fixtures/dates'
import { formatDateLong } from './programme-text'
import { formatTime } from './time'

// The public site's fixtures and ladder tables as HTML strings (docs/public-site.md, "Tables"). One renderer for
// the league pages (FixturesTable.astro, LadderTable.astro) and the page-editor data blocks
// (src/lib/content/data-blocks.ts), so a Fixtures block looks exactly like the league page.
//
// Fixtures are grouped by night: each night is its own <tbody> headed by a row with the date, the match day and a
// "Moved from …" badge when the night moved, so the date isn't repeated on every game. Under 640px the CSS turns
// each game row into a small card (time and court, then the teams, then the duty team), which is why every element
// carries its table role explicitly: browsers drop a table's semantics when its display changes.

/** What the fixtures table reads of a row (FixtureRow in src/server/competition/adapter.ts satisfies it). */
export type FixtureTableRow = {
  key: string
  date: string
  matchDay: number
  /** "20:00", "Bye" or ''. */
  time: string
  /** "HOME vs AWAY", "SEMI FINAL 1 - (2ND) vs (3RD)", "BYE - TEAM" or a skipped week's note. */
  match: string
  result: string
  sets: string
  court: string
  duty: string
  kind: 'game' | 'bye' | 'skip' | 'moved'
  forfeit: boolean
  resultNote?: string
  note?: string
  referee?: string
  /** The date the night (or this game) was first scheduled for, when it moved; ''. */
  movedFrom?: string
  /** The sides as shown (capitals), when the row is a game: lets the renderer link each team. */
  parts?: { title: string; home: string; away: string }
  /** Resolved team ids (null = a finals placeholder, never linked). */
  teamIds?: { home: string | null; away: string | null; duty: string | null }
}

/** A team's public page, or null when it has none (docs/public-site.md "Team pages"). */
export type TeamHref = (teamId: string) => string | null

export type FixtureTableOptions = {
  /** The amber caption above the table ("TNL Q4 2026 Fixtures"); none when omitted. */
  caption?: string
  /** The scroll region's accessible name. */
  label: string
  /** The Duty column (off for leagues without team duty, i.e. TVSL). */
  duty: boolean
  /** The Court column (default on). */
  court?: boolean
  /** Set scores and referees under the result and match (default on; compact data blocks turn it off). */
  details?: boolean
  /** The night rows show the date (default); off where the page already heads each date (/leagues/fixtures). */
  showDate?: boolean
  /** The key under the table explaining duty, moved nights and statuses (default on). */
  legend?: boolean
  emptyText: string
  /** Links team names to their pages. */
  teamHref?: TeamHref
}

const OFF = new Set(['Cancelled', 'Postponed', 'TBD', 'Moved'])

const attr = (s: string) => escapeHtml(s)
const sub = (s: string, cls = 'fx-sub') => (s ? `<span class="${cls}">${escapeHtml(s)}</span>` : '')

/** A team name, linked to its page when it has one. */
const teamName = (text: string, id: string | null | undefined, href?: TeamHref) => {
  const to = id && href ? href(id) : null
  return to ? `<a class="team-link" href="${attr(to)}">${escapeHtml(text)}</a>` : escapeHtml(text)
}

/** "2 - 0" -> "2–0"; other results as they are. */
const score = (r: string) => (/^\d+ - \d+$/.test(r) ? r.replace(' - ', '–') : r)

function resultCell(r: FixtureTableRow, details: boolean): string {
  const main = !r.result
    ? ''
    : OFF.has(r.result)
      ? `<span class="badge badge-off">${escapeHtml(r.result)}</span>`
      : r.result === '-'
        ? ''
        : `<span class="fx-score">${escapeHtml(score(r.result))}</span>`
  return [
    main,
    r.forfeit ? sub('Forfeit') : '',
    details ? sub(r.sets) : '',
    sub(r.resultNote ?? '', 'fx-note'),
    r.kind === 'bye' ? '' : sub(r.note ?? '', 'fx-note'),
  ].join('')
}

/** The fixtures and results table, grouped by night. */
export function fixturesTableHtml(rows: readonly FixtureTableRow[], o: FixtureTableOptions): string {
  const court = o.court ?? true
  const details = o.details ?? true
  const showDate = o.showDate ?? true
  const head = ['Time', 'Match', 'Result', ...(court ? ['Court'] : []), ...(o.duty ? ['Duty'] : [])]
  const cols = head.length
  const nights: { date: string; rows: FixtureTableRow[] }[] = []
  for (const r of rows) {
    const last = nights.at(-1)
    if (last && last.date === r.date) last.rows.push(r)
    else nights.push({ date: r.date, rows: [r] })
  }
  let anyMoved = false
  let anyOff = false
  const bodies = nights.map(({ date, rows: night }) => {
    // A night that moved as a whole says so once, in its heading; a game moved on its own says so on its row.
    const nightMoved = night.every((r) => r.movedFrom) ? (night[0]?.movedFrom ?? '') : ''
    if (night.some((r) => r.movedFrom)) anyMoved = true
    const matchDay = night.find((r) => r.matchDay)?.matchDay
    const heading = [
      showDate ? `<span class="night-date">${escapeHtml(formatDateLong(date) || formatAU(date))}</span>` : '',
      matchDay ? `<span class="night-day">Match day ${matchDay}</span>` : '',
      nightMoved ? `<span class="badge badge-moved">Moved from ${escapeHtml(formatAU(nightMoved))}</span>` : '',
    ].join('')
    const body = night.map((r) => {
      if (r.kind === 'skip') return `<tr role="row"><td role="cell" colspan="${cols}" class="fx-skip">${escapeHtml(r.match)}</td></tr>`
      if (OFF.has(r.result)) anyOff = true
      const bye = r.kind === 'bye'
      const team = bye ? r.match.replace(/^BYE - /, '') : r.match
      // "HOME vs AWAY": the teams stay in capitals (the old site's style), the "vs" doesn't shout.
      const vs = team.indexOf(' vs ')
      const ids = r.teamIds
      const teams = bye
        ? teamName(team, ids?.home, o.teamHref)
        : r.parts
          ? `${r.parts.title ? `${escapeHtml(r.parts.title)} - ` : ''}${teamName(r.parts.home, ids?.home, o.teamHref)} <span class="fx-vs">vs</span> ${teamName(r.parts.away, ids?.away, o.teamHref)}`
          : vs < 0
            ? escapeHtml(team)
            : `${escapeHtml(team.slice(0, vs))} <span class="fx-vs">vs</span> ${escapeHtml(team.slice(vs + 4))}`
      const movedOwn =
        r.movedFrom && !nightMoved ? `<span class="badge badge-moved">Moved from ${escapeHtml(formatAU(r.movedFrom))}</span>` : ''
      const match = `${bye ? '<span class="badge badge-bye">Bye</span> ' : ''}<span class="fx-teams">${teams}</span>${details && r.referee ? sub(`Referee: ${r.referee}`) : ''}${movedOwn}${bye ? sub(r.note ?? '', 'fx-note') : ''}`
      const duty =
        r.duty && r.duty !== '-' ? `<span class="fx-label" aria-hidden="true">Duty </span>${teamName(r.duty, ids?.duty, o.teamHref)}` : ''
      const cells = [
        `<td role="cell" class="fx-time">${bye ? '' : escapeHtml(formatTime(r.time) || r.time)}</td>`,
        `<td role="cell" class="fx-match team">${match}</td>`,
        `<td role="cell" class="fx-result">${resultCell(r, details)}</td>`,
        ...(court ? [`<td role="cell" class="fx-court">${escapeHtml(bye ? '' : r.court)}</td>`] : []),
        ...(o.duty ? [`<td role="cell" class="fx-duty">${duty}</td>`] : []),
      ]
      return `<tr role="row" class="${bye ? 'fx-bye' : r.kind === 'moved' ? 'fx-moved' : 'fx-game'}">${cells.join('')}</tr>`
    })
    const headRow = heading
      ? `<tr role="row" class="night-row"><th role="rowheader" scope="rowgroup" colspan="${cols}"><span class="night-head">${heading}</span></th></tr>`
      : ''
    return `<tbody role="rowgroup" class="night">${headRow}${body.join('')}</tbody>`
  })
  const table = [
    `<div class="table-scroll fixtures-scroll" tabindex="0" role="region" aria-label="${attr(o.label)}">`,
    `<table class="data-table fixtures-table" role="table">`,
    o.caption ? `<caption>${escapeHtml(o.caption)}</caption>` : '',
    `<thead role="rowgroup"><tr role="row">${head.map((h) => `<th role="columnheader" scope="col" class="fx-h-${h.toLowerCase()}">${h}</th>`).join('')}</tr></thead>`,
    bodies.length
      ? bodies.join('')
      : `<tbody role="rowgroup"><tr role="row"><td role="cell" colspan="${cols}" class="fx-empty">${escapeHtml(o.emptyText)}</td></tr></tbody>`,
    `</table></div>`,
  ].join('')
  const legend =
    (o.legend ?? true) && bodies.length
      ? [
          o.duty ? `<div><dt>Duty</dt><dd>the team refereeing the game.</dd></div>` : '',
          anyMoved
            ? `<div><dt><span class="badge badge-moved">Moved from …</span></dt><dd>the night or game was moved; this is its first date.</dd></div>`
            : '',
          anyOff
            ? `<div><dt><span class="badge badge-off">Postponed</span></dt><dd>off for now, with a new date to come. Cancelled games won't be played.</dd></div>`
            : '',
        ].join('')
      : ''
  return `<div class="fixtures">${table}${legend ? `<dl class="fx-legend">${legend}</dl>` : ''}</div>`
}

/** What the ladder reads of a row (LadderRow in src/server/competition/adapter.ts satisfies it). */
export type LadderTableRow = {
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
  withdrawn?: boolean
  teamId?: string
}

export type LadderTableOptions = {
  caption?: string
  /** The scroll region's accessible name (full ladders scroll sideways on phones). */
  label: string
  /** Pos, Team, Pts, P, W, D, L only (widgets and compact blocks). */
  compact?: boolean
  /** Compact only: hide W, D and L under 640px too (narrow blocks in a page body). */
  narrow?: boolean
  limit?: number
  /** Links team names to their pages. */
  teamHref?: TeamHref
}

const LADDER_COLS: [string, string, boolean][] = [
  ['Pts', 'Ladder points', false],
  ['P', 'Played', false],
  ['W', 'Won', false],
  ['D', 'Drawn', false],
  ['L', 'Lost', false],
  ['S+', 'Sets won', true],
  ['S-', 'Sets lost', true],
  ['P+', 'Points for', true],
  ['P-', 'Points against', true],
  ['Ratio', 'Points for ÷ all points', true],
]

/**
 * The ladder: Pos and Team first (sticky on phones, so the full table scrolls sideways under them), then Pts, P, W,
 * D, L and, on full ladders, S+, S-, P+, P- and Ratio. Compact ladders stop at L.
 */
export function ladderTableHtml(rows: readonly LadderTableRow[], o: LadderTableOptions): string {
  const compact = o.compact ?? false
  const shown = o.limit ? rows.slice(0, o.limit) : rows
  const cols = LADDER_COLS.filter(([, , full]) => !compact || !full)
  const hide = (label: string) => (compact && o.narrow && ['W', 'D', 'L'].includes(label) ? ' hidden sm:table-cell' : '')
  const head = [
    `<th scope="col" class="lt-pos"><abbr title="Position">Pos</abbr></th>`,
    `<th scope="col" class="lt-team">Team</th>`,
    ...cols.map(([label, title]) => `<th scope="col" class="num${hide(label)}"><abbr title="${attr(title)}">${label}</abbr></th>`),
  ].join('')
  const values = (r: LadderTableRow): (number | string)[] => [
    r.points,
    r.played,
    r.won,
    r.drawn,
    r.lost,
    ...(compact ? [] : [r.setsFor, r.setsAgainst, r.pointsFor, r.pointsAgainst, r.ratio]),
  ]
  const body = shown.length
    ? shown
        .map(
          (r) =>
            `<tr><td class="lt-pos">${r.pos}</td><th scope="row" class="lt-team team"${compact ? ` title="${attr(r.name)}"` : ''}>${teamName(r.name, r.teamId, o.teamHref)}${r.withdrawn ? '<span class="fx-sub">Withdrawn</span>' : ''}</th>${values(
              r,
            )
              .map((v, i) => `<td class="num${i === 0 ? ' lt-pts' : ''}${hide(cols[i]![0])}">${escapeHtml(String(v))}</td>`)
              .join('')}</tr>`,
        )
        .join('')
    : `<tr><td colspan="${cols.length + 2}">No teams yet.</td></tr>`
  // A compact ladder fits a phone, so only full ladders are a focusable scroll region.
  const wrap = compact
    ? `<div class="table-scroll">`
    : `<div class="scroll-hint"><div class="table-scroll ladder-scroll" tabindex="0" role="region" aria-label="${attr(o.label)}">`
  return [
    wrap,
    `<table class="data-table ladder-table${compact ? ' compact' : ''}">`,
    o.caption ? `<caption>${escapeHtml(o.caption)}</caption>` : '',
    `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    compact ? '' : `<p class="scroll-note" aria-hidden="true">Swipe the table for sets and points.</p></div>`,
  ].join('')
}
