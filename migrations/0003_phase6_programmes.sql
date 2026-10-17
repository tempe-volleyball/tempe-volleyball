-- Phase 6: programmes, categories, sessions/terms/events, enrolment, fixtures parity, menu, page data refs and analytics.
-- Additive only. docs/data-model-phase6.md documents every table and column.
--
-- Hand edits after drizzle-kit generate (keep them if this file is ever regenerated):
--  1. drizzle-kit drops ON DELETE from foreign keys added with ALTER TABLE ADD; each one below has it restored to match
--     the TS schema.
--  2. The data statements at the end (category seed, league categories, status from active).
CREATE TABLE `enrolment_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`fields` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`confirmation_text` text,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`intro` text DEFAULT '{"blocks":[],"html":""}' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`seo_title` text,
	`seo_description` text,
	`og_image_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`og_image_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);--> statement-breakpoint
CREATE INDEX `categories_og_image_id_idx` ON `categories` (`og_image_id`);--> statement-breakpoint
CREATE INDEX `categories_status_sort_idx` ON `categories` (`status`,`sort`);--> statement-breakpoint
CREATE TABLE `development_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`programme_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`weekday` integer,
	`start_time` text,
	`end_time` text,
	`venue_id` text,
	`court_id` text,
	`age_group` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`note` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`programme_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`court_id`) REFERENCES `courts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `development_terms_programme_id_slug_unique` ON `development_terms` (`programme_id`,`slug`);--> statement-breakpoint
CREATE INDEX `development_terms_programme_id_start_date_idx` ON `development_terms` (`programme_id`,`start_date`);--> statement-breakpoint
CREATE INDEX `development_terms_venue_id_idx` ON `development_terms` (`venue_id`);--> statement-breakpoint
CREATE INDEX `development_terms_court_id_idx` ON `development_terms` (`court_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`programme_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`start_time` text,
	`end_time` text,
	`venue_id` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`original_start_date` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`programme_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_programme_id_slug_unique` ON `events` (`programme_id`,`slug`);--> statement-breakpoint
CREATE INDEX `events_programme_id_start_date_idx` ON `events` (`programme_id`,`start_date`);--> statement-breakpoint
CREATE INDEX `events_start_date_idx` ON `events` (`start_date`);--> statement-breakpoint
CREATE INDEX `events_venue_id_idx` ON `events` (`venue_id`);--> statement-breakpoint
CREATE TABLE `programme_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`programme_id` text NOT NULL,
	`term_id` text,
	`date` text NOT NULL,
	`start_time` text,
	`end_time` text,
	`venue_id` text,
	`court_id` text,
	`title` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`original_date` text,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`programme_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`term_id`) REFERENCES `development_terms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`venue_id`) REFERENCES `venues`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`court_id`) REFERENCES `courts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `programme_sessions_programme_id_date_idx` ON `programme_sessions` (`programme_id`,`date`);--> statement-breakpoint
CREATE INDEX `programme_sessions_term_id_date_idx` ON `programme_sessions` (`term_id`,`date`);--> statement-breakpoint
CREATE INDEX `programme_sessions_date_idx` ON `programme_sessions` (`date`);--> statement-breakpoint
CREATE INDEX `programme_sessions_venue_id_idx` ON `programme_sessions` (`venue_id`);--> statement-breakpoint
CREATE INDEX `programme_sessions_court_id_idx` ON `programme_sessions` (`court_id`);--> statement-breakpoint
CREATE TABLE `page_data_refs` (
	`page_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`page_id`, `kind`, `ref_id`),
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `page_data_refs_kind_ref_id_idx` ON `page_data_refs` (`kind`,`ref_id`);--> statement-breakpoint
CREATE TABLE `analytics_daily` (
	`source` text NOT NULL,
	`date` text NOT NULL,
	`metric` text NOT NULL,
	`dimension` text DEFAULT '' NOT NULL,
	`dimension_value` text DEFAULT '' NOT NULL,
	`value` real NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`source`, `date`, `metric`, `dimension`, `dimension_value`)
);
--> statement-breakpoint
CREATE INDEX `analytics_daily_source_metric_dimension_date_idx` ON `analytics_daily` (`source`,`metric`,`dimension`,`date`);--> statement-breakpoint
CREATE INDEX `analytics_daily_date_idx` ON `analytics_daily` (`date`);--> statement-breakpoint
CREATE TABLE `analytics_fetches` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`range_start` text,
	`range_end` text,
	`rows_written` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `analytics_fetches_source_started_at_idx` ON `analytics_fetches` (`source`,`started_at`);--> statement-breakpoint
CREATE INDEX `analytics_fetches_started_at_idx` ON `analytics_fetches` (`started_at`);--> statement-breakpoint
CREATE TABLE `analytics_state` (
	`source` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_complete_date` text,
	`last_success_at` text,
	`last_error_at` text,
	`last_error` text,
	`cursor` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `leagues` ADD `kind` text DEFAULT 'league' NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `category_id` text REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `leagues` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `retired_at` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `start_time` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `end_time` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `schedule_label` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `description` text DEFAULT '{"blocks":[],"html":""}' NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `summary_line` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `more_info_url` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `menu_visible` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `age_min` integer;--> statement-breakpoint
ALTER TABLE `leagues` ADD `age_max` integer;--> statement-breakpoint
ALTER TABLE `leagues` ADD `seo_title` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `seo_description` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `image_id` text REFERENCES `media`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `leagues` ADD `enrolment_open` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `enrolment_opens_at` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `enrolment_closes_at` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `next_starts_on` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `next_starts_text` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `enrolment_form_id` text REFERENCES `enrolment_forms`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `leagues` ADD `cap_teams` integer;--> statement-breakpoint
ALTER TABLE `leagues` ADD `cap_players` integer;--> statement-breakpoint
ALTER TABLE `leagues` ADD `price_cents` integer;--> statement-breakpoint
ALTER TABLE `leagues` ADD `allow_team_entries` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `allow_free_agents` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `waitlist_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `waitlist_offer_hours` integer DEFAULT 48 NOT NULL;--> statement-breakpoint
CREATE INDEX `leagues_category_id_idx` ON `leagues` (`category_id`);--> statement-breakpoint
CREATE INDEX `leagues_kind_status_idx` ON `leagues` (`kind`,`status`);--> statement-breakpoint
CREATE INDEX `leagues_image_id_idx` ON `leagues` (`image_id`);--> statement-breakpoint
CREATE INDEX `leagues_enrolment_form_id_idx` ON `leagues` (`enrolment_form_id`);--> statement-breakpoint
ALTER TABLE `match_days` ADD `status` text DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE `match_days` ADD `original_date` text;--> statement-breakpoint
ALTER TABLE `match_results` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `match_results` ADD `note` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `status_note` text;--> statement-breakpoint
ALTER TABLE `matches` ADD `original_match_day_id` text REFERENCES `match_days`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `matches` ADD `referee` text;--> statement-breakpoint
CREATE INDEX `matches_original_match_day_id_idx` ON `matches` (`original_match_day_id`);--> statement-breakpoint
ALTER TABLE `season_teams` ADD `withdrawn_at` text;--> statement-breakpoint
ALTER TABLE `season_teams` ADD `withdrawn_reason` text;--> statement-breakpoint
ALTER TABLE `menu_items` ADD `category_id` text REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `menu_items` ADD `placement` text;--> statement-breakpoint
ALTER TABLE `menu_items` ADD `hidden` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `menu_items_category_id_idx` ON `menu_items` (`category_id`);--> statement-breakpoint
ALTER TABLE `groups` ADD `status` text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE `groups` ADD `waitlist_position` integer;--> statement-breakpoint
ALTER TABLE `groups` ADD `offered_at` text;--> statement-breakpoint
ALTER TABLE `groups` ADD `offer_expires_at` text;--> statement-breakpoint
ALTER TABLE `groups` ADD `team_id` text REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `groups` ADD `answers` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `groups` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `groups` ADD `notes` text;--> statement-breakpoint
CREATE INDEX `groups_product_id_status_idx` ON `groups` (`product_id`,`status`);--> statement-breakpoint
CREATE INDEX `groups_product_id_waitlist_position_idx` ON `groups` (`product_id`,`waitlist_position`);--> statement-breakpoint
CREATE INDEX `groups_team_id_idx` ON `groups` (`team_id`);--> statement-breakpoint
CREATE INDEX `groups_status_offer_expires_at_idx` ON `groups` (`status`,`offer_expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `groups_product_id_name_live_unique` ON `groups` (`product_id`,`name`) WHERE status <> 'cancelled';--> statement-breakpoint
ALTER TABLE `products` ADD `programme_id` text REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `products` ADD `session_id` text REFERENCES `programme_sessions`(`id`) ON UPDATE no action ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `products` ADD `term_id` text REFERENCES `development_terms`(`id`) ON UPDATE no action ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `products` ADD `event_id` text REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `products` ADD `capacity_teams` integer;--> statement-breakpoint
ALTER TABLE `products` ADD `form_id` text REFERENCES `enrolment_forms`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `products` ADD `waitlist_enabled` integer;--> statement-breakpoint
ALTER TABLE `products` ADD `waitlist_offer_hours` integer;--> statement-breakpoint
ALTER TABLE `products` ADD `allow_team_entries` integer;--> statement-breakpoint
ALTER TABLE `products` ADD `allow_free_agents` integer;--> statement-breakpoint
CREATE INDEX `products_programme_id_idx` ON `products` (`programme_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_season_id_unique` ON `products` (`season_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_session_id_unique` ON `products` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_term_id_unique` ON `products` (`term_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `products_event_id_unique` ON `products` (`event_id`);--> statement-breakpoint
CREATE INDEX `products_form_id_idx` ON `products` (`form_id`);--> statement-breakpoint
ALTER TABLE `registrations` ADD `free_agent` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `registrations` ADD `waitlist_position` integer;--> statement-breakpoint
ALTER TABLE `registrations` ADD `offered_at` text;--> statement-breakpoint
ALTER TABLE `registrations` ADD `offer_expires_at` text;--> statement-breakpoint
ALTER TABLE `registrations` ADD `amount_cents` integer;--> statement-breakpoint
ALTER TABLE `registrations` ADD `paid_at` text;--> statement-breakpoint
ALTER TABLE `registrations` ADD `paid_marked_by` text REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `registrations` ADD `payment_note` text;--> statement-breakpoint
ALTER TABLE `registrations` ADD `form_id` text REFERENCES `enrolment_forms`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `registrations` ADD `form_version` integer;--> statement-breakpoint
ALTER TABLE `registrations` ADD `source` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `registrations` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `registrations` ADD `cancel_reason` text;--> statement-breakpoint
CREATE INDEX `registrations_product_id_waitlist_position_idx` ON `registrations` (`product_id`,`waitlist_position`);--> statement-breakpoint
CREATE INDEX `registrations_status_offer_expires_at_idx` ON `registrations` (`status`,`offer_expires_at`);--> statement-breakpoint
CREATE INDEX `registrations_paid_marked_by_idx` ON `registrations` (`paid_marked_by`);--> statement-breakpoint
CREATE INDEX `registrations_form_id_idx` ON `registrations` (`form_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `registrations_product_id_player_id_live_unique` ON `registrations` (`product_id`,`player_id`) WHERE status NOT IN ('cancelled', 'expired', 'refunded');
--> statement-breakpoint
-- Seed the four categories (docs/admin.md §3.2). Fixed ids so later migrations and tests can refer to them.
INSERT OR IGNORE INTO `categories` (`id`, `name`, `slug`, `sort`) VALUES
	('cat_mixed_leagues', 'Mixed Leagues', 'mixed-leagues', 1),
	('cat_super_league', 'Super League', 'super-league', 2),
	('cat_juniors', 'Juniors', 'juniors', 3),
	('cat_adult_training', 'Adult Training', 'adult-training', 4);
--> statement-breakpoint
-- Imported leagues into their categories by code. Production has no leagues yet, so these update nothing there.
UPDATE `leagues` SET `category_id` = 'cat_mixed_leagues' WHERE `code` IN ('TNL', 'FNL', 'SNL', 'SAL') AND `category_id` IS NULL;
--> statement-breakpoint
UPDATE `leagues` SET `category_id` = 'cat_super_league' WHERE `code` = 'TVSL' AND `category_id` IS NULL;
--> statement-breakpoint
-- status supersedes the active flag; inactive imported leagues become retired.
UPDATE `leagues` SET `status` = 'retired', `retired_at` = `updated_at` WHERE `active` = 0;
