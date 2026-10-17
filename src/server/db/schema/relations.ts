import { relations } from 'drizzle-orm'
import { auditLog, adminInvites } from './admin'
import { user } from './auth'
import { courts, ladderAdjustments, leagues, matchDays, matches, matchResults, seasons, seasonTeams, teams, venues } from './competition'
import { media, menuItems, pageRevisions, pages, posts } from './content'
import { groups, payments, players, products, registrations } from './registrations'

// Relations for Drizzle's relational query API (db.query.seasons.findMany({ with: { matchDays: true } })).
// They don't affect the SQL schema. Better Auth's relations are in auth.ts.

export const venuesRelations = relations(venues, ({ many }) => ({
  courts: many(courts),
  leagues: many(leagues),
}))

export const courtsRelations = relations(courts, ({ one, many }) => ({
  venue: one(venues, { fields: [courts.venueId], references: [venues.id] }),
  matches: many(matches),
}))

export const leaguesRelations = relations(leagues, ({ one, many }) => ({
  defaultVenue: one(venues, { fields: [leagues.defaultVenueId], references: [venues.id] }),
  seasons: many(seasons),
  menuItems: many(menuItems),
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
}))

export const seasonTeamsRelations = relations(seasonTeams, ({ one }) => ({
  season: one(seasons, { fields: [seasonTeams.seasonId], references: [seasons.id] }),
  team: one(teams, { fields: [seasonTeams.teamId], references: [teams.id] }),
}))

export const matchDaysRelations = relations(matchDays, ({ one, many }) => ({
  season: one(seasons, { fields: [matchDays.seasonId], references: [seasons.id] }),
  matches: many(matches),
}))

export const matchesRelations = relations(matches, ({ one, many }) => ({
  season: one(seasons, { fields: [matches.seasonId], references: [seasons.id] }),
  matchDay: one(matchDays, { fields: [matches.matchDayId], references: [matchDays.id] }),
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
}))

export const adminInvitesRelations = relations(adminInvites, ({ one }) => ({
  invitedByUser: one(user, { fields: [adminInvites.invitedBy], references: [user.id] }),
}))

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  actor: one(user, { fields: [auditLog.actorUserId], references: [user.id] }),
}))

export const productsRelations = relations(products, ({ one, many }) => ({
  season: one(seasons, { fields: [products.seasonId], references: [seasons.id] }),
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
  registrations: many(registrations),
}))

export const registrationsRelations = relations(registrations, ({ one, many }) => ({
  product: one(products, { fields: [registrations.productId], references: [products.id] }),
  player: one(players, { fields: [registrations.playerId], references: [players.id] }),
  group: one(groups, { fields: [registrations.groupId], references: [groups.id] }),
  payments: many(payments),
}))

export const paymentsRelations = relations(payments, ({ one }) => ({
  registration: one(registrations, { fields: [payments.registrationId], references: [registrations.id] }),
  markedPaidByUser: one(user, { fields: [payments.markedPaidBy], references: [user.id] }),
}))
