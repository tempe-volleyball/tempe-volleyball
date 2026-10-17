import { relations } from 'drizzle-orm'
import { auditLog, adminInvites } from './admin'
import { user } from './auth'
import {
  categories,
  courts,
  ladderAdjustments,
  leagues,
  matchDays,
  matches,
  matchResults,
  seasons,
  seasonTeams,
  teams,
  venues,
} from './competition'
import { menuItems, pageDataRefs, pageRevisions, pages, posts } from './content'
import { enrolmentForms } from './forms'
import { media } from './media'
import { developmentTerms, events, programmeSessions } from './programmes'
import { groups, payments, players, products, registrations } from './registrations'

// Relations for Drizzle's relational query API (db.query.seasons.findMany({ with: { matchDays: true } })).
// They don't affect the SQL schema. Better Auth's relations are in auth.ts.

export const venuesRelations = relations(venues, ({ many }) => ({
  courts: many(courts),
  leagues: many(leagues),
  sessions: many(programmeSessions),
  terms: many(developmentTerms),
  events: many(events),
}))

export const categoriesRelations = relations(categories, ({ one, many }) => ({
  ogImage: one(media, { fields: [categories.ogImageId], references: [media.id] }),
  programmes: many(leagues),
  menuItems: many(menuItems),
}))

export const courtsRelations = relations(courts, ({ one, many }) => ({
  venue: one(venues, { fields: [courts.venueId], references: [venues.id] }),
  matches: many(matches),
}))

/** `leagues` is the programmes table; these relations serve every kind. */
export const leaguesRelations = relations(leagues, ({ one, many }) => ({
  defaultVenue: one(venues, { fields: [leagues.defaultVenueId], references: [venues.id] }),
  category: one(categories, { fields: [leagues.categoryId], references: [categories.id] }),
  image: one(media, { fields: [leagues.imageId], references: [media.id] }),
  enrolmentForm: one(enrolmentForms, { fields: [leagues.enrolmentFormId], references: [enrolmentForms.id] }),
  seasons: many(seasons),
  sessions: many(programmeSessions),
  terms: many(developmentTerms),
  events: many(events),
  products: many(products),
  menuItems: many(menuItems),
}))

export const developmentTermsRelations = relations(developmentTerms, ({ one, many }) => ({
  programme: one(leagues, { fields: [developmentTerms.programmeId], references: [leagues.id] }),
  venue: one(venues, { fields: [developmentTerms.venueId], references: [venues.id] }),
  court: one(courts, { fields: [developmentTerms.courtId], references: [courts.id] }),
  sessions: many(programmeSessions),
  product: one(products, { fields: [developmentTerms.id], references: [products.termId] }),
}))

export const programmeSessionsRelations = relations(programmeSessions, ({ one }) => ({
  programme: one(leagues, { fields: [programmeSessions.programmeId], references: [leagues.id] }),
  term: one(developmentTerms, { fields: [programmeSessions.termId], references: [developmentTerms.id] }),
  venue: one(venues, { fields: [programmeSessions.venueId], references: [venues.id] }),
  court: one(courts, { fields: [programmeSessions.courtId], references: [courts.id] }),
  product: one(products, { fields: [programmeSessions.id], references: [products.sessionId] }),
}))

export const eventsRelations = relations(events, ({ one }) => ({
  programme: one(leagues, { fields: [events.programmeId], references: [leagues.id] }),
  venue: one(venues, { fields: [events.venueId], references: [venues.id] }),
  product: one(products, { fields: [events.id], references: [products.eventId] }),
}))

export const enrolmentFormsRelations = relations(enrolmentForms, ({ many }) => ({
  programmes: many(leagues),
  products: many(products),
  registrations: many(registrations),
}))

export const seasonsRelations = relations(seasons, ({ one, many }) => ({
  league: one(leagues, { fields: [seasons.leagueId], references: [leagues.id] }),
  seasonTeams: many(seasonTeams),
  matchDays: many(matchDays),
  matches: many(matches),
  ladderAdjustments: many(ladderAdjustments),
  products: many(products),
}))

export const teamsRelations = relations(teams, ({ many }) => ({
  seasonTeams: many(seasonTeams),
  ladderAdjustments: many(ladderAdjustments),
  entries: many(groups),
}))

export const seasonTeamsRelations = relations(seasonTeams, ({ one }) => ({
  season: one(seasons, { fields: [seasonTeams.seasonId], references: [seasons.id] }),
  team: one(teams, { fields: [seasonTeams.teamId], references: [teams.id] }),
}))

export const matchDaysRelations = relations(matchDays, ({ one, many }) => ({
  season: one(seasons, { fields: [matchDays.seasonId], references: [seasons.id] }),
  matches: many(matches, { relationName: 'match_day' }),
  postponedMatches: many(matches, { relationName: 'original_match_day' }),
}))

export const matchesRelations = relations(matches, ({ one, many }) => ({
  season: one(seasons, { fields: [matches.seasonId], references: [seasons.id] }),
  matchDay: one(matchDays, { fields: [matches.matchDayId], references: [matchDays.id], relationName: 'match_day' }),
  originalMatchDay: one(matchDays, {
    fields: [matches.originalMatchDayId],
    references: [matchDays.id],
    relationName: 'original_match_day',
  }),
  court: one(courts, { fields: [matches.courtId], references: [courts.id] }),
  homeTeam: one(teams, { fields: [matches.homeTeamId], references: [teams.id], relationName: 'home' }),
  awayTeam: one(teams, { fields: [matches.awayTeamId], references: [teams.id], relationName: 'away' }),
  dutyTeam: one(teams, { fields: [matches.dutyTeamId], references: [teams.id], relationName: 'duty' }),
  results: many(matchResults),
}))

export const matchResultsRelations = relations(matchResults, ({ one }) => ({
  match: one(matches, { fields: [matchResults.matchId], references: [matches.id] }),
}))

export const ladderAdjustmentsRelations = relations(ladderAdjustments, ({ one }) => ({
  season: one(seasons, { fields: [ladderAdjustments.seasonId], references: [seasons.id] }),
  team: one(teams, { fields: [ladderAdjustments.teamId], references: [teams.id] }),
}))

export const pagesRelations = relations(pages, ({ one, many }) => ({
  ogImage: one(media, { fields: [pages.ogImageId], references: [media.id] }),
  revisions: many(pageRevisions),
  menuItems: many(menuItems),
  dataRefs: many(pageDataRefs),
}))

export const pageDataRefsRelations = relations(pageDataRefs, ({ one }) => ({
  page: one(pages, { fields: [pageDataRefs.pageId], references: [pages.id] }),
}))

export const pageRevisionsRelations = relations(pageRevisions, ({ one }) => ({
  page: one(pages, { fields: [pageRevisions.pageId], references: [pages.id] }),
  createdByUser: one(user, { fields: [pageRevisions.createdBy], references: [user.id] }),
}))

export const postsRelations = relations(posts, ({ one }) => ({
  coverMedia: one(media, { fields: [posts.coverMediaId], references: [media.id] }),
}))

export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
  parent: one(menuItems, { fields: [menuItems.parentId], references: [menuItems.id], relationName: 'menu_children' }),
  children: many(menuItems, { relationName: 'menu_children' }),
  page: one(pages, { fields: [menuItems.pageId], references: [pages.id] }),
  league: one(leagues, { fields: [menuItems.leagueId], references: [leagues.id] }),
  category: one(categories, { fields: [menuItems.categoryId], references: [categories.id] }),
}))

export const adminInvitesRelations = relations(adminInvites, ({ one }) => ({
  invitedByUser: one(user, { fields: [adminInvites.invitedBy], references: [user.id] }),
}))

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  actor: one(user, { fields: [auditLog.actorUserId], references: [user.id] }),
}))

export const productsRelations = relations(products, ({ one, many }) => ({
  season: one(seasons, { fields: [products.seasonId], references: [seasons.id] }),
  programme: one(leagues, { fields: [products.programmeId], references: [leagues.id] }),
  session: one(programmeSessions, { fields: [products.sessionId], references: [programmeSessions.id] }),
  term: one(developmentTerms, { fields: [products.termId], references: [developmentTerms.id] }),
  event: one(events, { fields: [products.eventId], references: [events.id] }),
  form: one(enrolmentForms, { fields: [products.formId], references: [enrolmentForms.id] }),
  groups: many(groups),
  registrations: many(registrations),
}))

export const playersRelations = relations(players, ({ many }) => ({
  registrations: many(registrations),
  captainOf: many(groups),
}))

export const groupsRelations = relations(groups, ({ one, many }) => ({
  captain: one(players, { fields: [groups.captainPlayerId], references: [players.id] }),
  product: one(products, { fields: [groups.productId], references: [products.id] }),
  team: one(teams, { fields: [groups.teamId], references: [teams.id] }),
  registrations: many(registrations),
}))

export const registrationsRelations = relations(registrations, ({ one, many }) => ({
  product: one(products, { fields: [registrations.productId], references: [products.id] }),
  player: one(players, { fields: [registrations.playerId], references: [players.id] }),
  group: one(groups, { fields: [registrations.groupId], references: [groups.id] }),
  form: one(enrolmentForms, { fields: [registrations.formId], references: [enrolmentForms.id] }),
  paidMarkedByUser: one(user, { fields: [registrations.paidMarkedBy], references: [user.id] }),
  payments: many(payments),
}))

export const paymentsRelations = relations(payments, ({ one }) => ({
  registration: one(registrations, { fields: [payments.registrationId], references: [registrations.id] }),
  markedPaidByUser: one(user, { fields: [payments.markedPaidBy], references: [user.id] }),
}))
