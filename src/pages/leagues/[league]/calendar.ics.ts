import type { APIRoute } from 'astro'
import { calendarFeed } from '../../../server/competition/feed-route'

// iCal feed of a league's current season (subscribe with webcal://…/leagues/tnl/calendar.ics).
export const GET: APIRoute = (context) => calendarFeed(context, (context.params.league ?? '').toLowerCase(), null)
