import type { APIRoute } from 'astro'
import { calendarFeed } from '../../../../server/competition/feed-route'

// iCal feed of one team's games and duties in its league's current season (webcal://…/leagues/tnl/teams/ice-cold.ics).
export const GET: APIRoute = (context) =>
  calendarFeed(context, (context.params.league ?? '').toLowerCase(), (context.params.team ?? '').toLowerCase())
