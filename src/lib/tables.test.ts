import { describe, expect, it } from 'vitest'
import { fixturesTableHtml, ladderTableHtml, type FixtureTableRow, type LadderTableRow } from './tables'

const row = (o: Partial<FixtureTableRow>): FixtureTableRow => ({
  key: 'k',
  date: '2026-10-22',
  matchDay: 5,
  time: '20:00',
  match: 'ICE COLD vs AIM BOT',
  result: '',
  sets: '',
  court: 'Court 1',
  duty: 'KBU',
  kind: 'game',
  forfeit: false,
  ...o,
})

const opts = { label: 'TNL fixtures', duty: true, emptyText: 'Nothing yet.' }

describe('fixturesTableHtml', () => {
  it('groups games by night under one heading row, with the time formatted and the duty team labelled', () => {
    const html = fixturesTableHtml(
      [row({ key: 'a' }), row({ key: 'b', time: '21:00' }), row({ key: 'c', date: '2026-10-29', matchDay: 6 })],
      { ...opts, caption: 'TNL Q4 2026 Fixtures' },
    )
    expect(html.match(/<tbody role="rowgroup" class="night">/g)).toHaveLength(2)
    expect(html).toContain('<span class="night-date">Thursday 22 October 2026</span><span class="night-day">Match day 5</span>')
    expect(html).toContain('<td role="cell" class="fx-time">8pm</td>')
    expect(html).toContain('ICE COLD <span class="fx-vs">vs</span> AIM BOT')
    expect(html).toContain('<span class="fx-label" aria-hidden="true">Duty </span>KBU')
    expect(html).toContain('<caption>TNL Q4 2026 Fixtures</caption>')
    expect(html).toContain('<dt>Duty</dt>')
  })

  it('says "moved from" once on a night that moved, and on the row for a game moved on its own', () => {
    const night = fixturesTableHtml([row({ movedFrom: '2026-10-15' }), row({ key: 'b', movedFrom: '2026-10-15' })], opts)
    expect(night.match(/Moved from 15\/10\/2026/g)).toHaveLength(1)
    expect(night).toMatch(/night-head.*Moved from 15\/10\/2026/)
    const game = fixturesTableHtml([row({ movedFrom: '2026-10-15' }), row({ key: 'b' })], opts)
    expect(game).toMatch(/fx-match.*Moved from 15\/10\/2026/)
    expect(game).toContain('Moved from …')
  })

  it('shows results, statuses, byes and weeks off, and leaves optional columns out', () => {
    const html = fixturesTableHtml(
      [
        row({ result: '2 - 0', sets: '25-20, 25-18' }),
        row({ key: 'p', result: 'Postponed', note: 'Venue unavailable' }),
        row({ key: 'bye', kind: 'bye', time: 'Bye', match: 'BYE - KBU', result: '-', duty: '-' }),
        row({ key: 'skip', date: '2026-10-29', kind: 'skip', match: 'No games: school holidays', time: '', matchDay: 0 }),
      ],
      { ...opts, duty: false, court: false },
    )
    expect(html).toContain('<span class="fx-score">2–0</span><span class="fx-sub">25-20, 25-18</span>')
    expect(html).toContain('<span class="badge badge-off">Postponed</span>')
    expect(html).toContain('<span class="badge badge-bye">Bye</span> <span class="fx-teams">KBU</span>')
    expect(html).toContain('No games: school holidays')
    expect(html).not.toContain('Court')
    expect(html).not.toContain('Duty')
    expect(fixturesTableHtml([], opts)).toContain('Nothing yet.')
    expect(fixturesTableHtml([], opts)).not.toContain('fx-legend')
  })

  it('escapes what it prints', () => {
    const html = fixturesTableHtml([row({ match: '<b>X</b> vs Y' })], opts)
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;')
  })
})

const ladder: LadderTableRow[] = [1, 2, 3, 4, 5].map((pos) => ({
  pos,
  name: `Team ${pos}`,
  points: 10 - pos,
  played: 4,
  won: 2,
  drawn: 0,
  lost: 2,
  setsFor: 4,
  setsAgainst: 4,
  pointsFor: 100,
  pointsAgainst: 100,
  ratio: '0.500',
}))

describe('ladderTableHtml', () => {
  it('renders a full ladder as a labelled scroll region, Pos and Team first', () => {
    const html = ladderTableHtml(ladder, { label: 'TNL ladder', caption: 'TNL Q4 2026 Ladder' })
    expect(html).toContain('role="region" aria-label="TNL ladder"')
    expect(html).toContain('Ratio')
    expect(html.indexOf('lt-pos')).toBeLessThan(html.indexOf('lt-team'))
    expect(html).toContain('scroll-note')
  })
  it('renders compact ladders to L, top N, with W/D/L hidden on phones when narrow', () => {
    const html = ladderTableHtml(ladder, { label: 'x', compact: true, limit: 3, narrow: true })
    expect(html.match(/<tr>/g)).toHaveLength(4)
    expect(html).not.toContain('Ratio')
    expect(html).not.toContain('role="region"')
    expect(html).toContain('num hidden sm:table-cell')
    expect(ladderTableHtml([], { label: 'x' })).toContain('No teams yet.')
  })
})
