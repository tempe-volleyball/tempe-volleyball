import type { CalendarEvent } from '../../lib/ical'
import { formatAU } from '../../lib/fixtures/dates'
import { sydneyToUtc } from '../../lib/time'
import { fixtureRows, type FixtureRow, type SeasonCompetition, type SeasonData } from './adapter'

// A season's games as iCalendar events (src/lib/ical.ts), for the league and team feeds at
// /leagues/<league>/calendar.ics and /leagues/<league>/teams/<team>.ics. Pure: the route loads the season.

export type CalendarVenue = { name: string; address: string | null } | null | undefined

export type SeasonCalendarInput = {
  data: Pick<SeasonData, 'league' | 'matches'>
  competition: SeasonCompetition
}

/** Domain part of every UID, so they're globally unique and never change for a match. */
export const UID_DOMAIN = 'tempevb.com'

/**
 * One event per game (byes and weeks off are left out), timed from the game's start and the season's session length
 * (TVSL 90 minutes). With `teamId`, only that team's games and the games it referees ("Duty: …"). Cancelled games
 * stay in as CANCELLED so calendars remove them; postponed and TBD ones are TENTATIVE.
 */
export function seasonCalendarEvents(
  s: SeasonCalendarInput,
  opts: { venue?: CalendarVenue; teamId?: string | null; pageUrl?: string; rows?: FixtureRow[] } = {},
): CalendarEvent[] {
  const rows = opts.rows ?? fixtureRows(s.competition, s.data.matches)
  const minutes = s.competition.settings.sessionMinutes || 60
  const code = s.data.league.code
  const where = opts.venue ? [opts.venue.name, opts.venue.address].filter(Boolean).join(', ') : ''
  // sydneyToUtc builds Intl formatters, so convert each distinct night-and-time once.
  const instants = new Map<string, string | null>()
  const toUtc = (date: string, time: string) => {
    const key = `${date} ${time}`
    if (!instants.has(key)) instants.set(key, sydneyToUtc(key))
    return instants.get(key) ?? null
  }
  const out: CalendarEvent[] = []
  for (const r of rows) {
    if (r.kind !== 'game') continue
    const duty = !!opts.teamId && r.teamIds.duty === opts.teamId
    if (opts.teamId && !duty && r.teamIds.home !== opts.teamId && r.teamIds.away !== opts.teamId) continue
    const start = /^\d{2}:\d{2}$/.test(r.time) ? toUtc(r.date, r.time) : null
    if (!start) continue
    const end = new Date(Date.parse(start) + minutes * 60_000).toISOString()
    const off = r.status === 'cancelled' ? 'Cancelled: ' : r.status === 'postponed' ? 'Postponed: ' : r.status === 'tbd' ? 'TBD: ' : ''
    const details = [
      r.matchDay ? `Match day ${r.matchDay}` : '',
      r.duty && !duty ? `Duty: ${r.duty}` : '',
      r.result && r.result !== '-' && !off ? `Result: ${r.result}${r.sets ? ` (${r.sets})` : ''}` : '',
      r.resultNote,
      r.note,
      r.referee ? `Referee: ${r.referee}` : '',
      // The same dd/mm/yyyy as the public fixtures table's "(moved from …)".
      r.movedFrom ? `Moved from ${formatAU(r.movedFrom)}` : '',
    ].filter(Boolean)
    out.push({
      uid: `${r.key}@${UID_DOMAIN}`,
      start,
      end,
      summary: `${off}${code}${duty ? ' duty' : ''}: ${r.label}`,
      ...(where || r.court ? { location: [r.court, where].filter(Boolean).join(', ') } : {}),
      ...(details.length ? { description: details.join('\n') } : {}),
      status: r.status === 'cancelled' ? 'CANCELLED' : r.status === 'postponed' || r.status === 'tbd' ? 'TENTATIVE' : 'CONFIRMED',
      ...(opts.pageUrl ? { url: opts.pageUrl } : {}),
    })
  }
  return out
}
