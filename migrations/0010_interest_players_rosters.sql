CREATE TABLE `interest_members` (
	`id` text PRIMARY KEY NOT NULL,
	`interest_id` text NOT NULL,
	`player_id` text,
	`role` text DEFAULT 'player' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`details` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`interest_id`) REFERENCES `interests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `interest_members_interest_id_sort_idx` ON `interest_members` (`interest_id`,`sort`);--> statement-breakpoint
CREATE INDEX `interest_members_player_id_idx` ON `interest_members` (`player_id`);--> statement-breakpoint
CREATE TABLE `interest_programmes` (
	`interest_id` text NOT NULL,
	`programme_id` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`season_id` text,
	`team_id` text,
	`created_at` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text,
	PRIMARY KEY(`interest_id`, `programme_id`),
	FOREIGN KEY (`interest_id`) REFERENCES `interests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`programme_id`) REFERENCES `leagues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `interest_programmes_programme_id_status_idx` ON `interest_programmes` (`programme_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `interest_programmes_programme_id_created_at_idx` ON `interest_programmes` (`programme_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `interest_programmes_season_id_idx` ON `interest_programmes` (`season_id`);--> statement-breakpoint
CREATE INDEX `interest_programmes_team_id_idx` ON `interest_programmes` (`team_id`);--> statement-breakpoint
CREATE TABLE `interests` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`reference` text NOT NULL,
	`team_name` text,
	`answers` text DEFAULT '{}' NOT NULL,
	`form_id` text,
	`form_version` integer,
	`deposit_cents` integer,
	`paid_at` text,
	`paid_marked_by` text,
	`payment_note` text,
	`note` text,
	`source` text DEFAULT 'public' NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`form_id`) REFERENCES `enrolment_forms`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`paid_marked_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `interests_reference_unique` ON `interests` (`reference`);--> statement-breakpoint
CREATE INDEX `interests_created_at_idx` ON `interests` (`created_at`);--> statement-breakpoint
CREATE INDEX `interests_archived_at_idx` ON `interests` (`archived_at`);--> statement-breakpoint
CREATE INDEX `interests_form_id_idx` ON `interests` (`form_id`);--> statement-breakpoint
CREATE INDEX `interests_paid_marked_by_idx` ON `interests` (`paid_marked_by`);--> statement-breakpoint
CREATE TABLE `season_team_players` (
	`season_id` text NOT NULL,
	`team_id` text NOT NULL,
	`player_id` text NOT NULL,
	`role` text DEFAULT 'player' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`interest_id` text,
	`from_season_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_by` text,
	PRIMARY KEY(`season_id`, `team_id`, `player_id`),
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`interest_id`) REFERENCES `interests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`from_season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `season_team_players_season_player_unique` ON `season_team_players` (`season_id`,`player_id`);--> statement-breakpoint
CREATE INDEX `season_team_players_player_id_idx` ON `season_team_players` (`player_id`,`season_id`);--> statement-breakpoint
CREATE INDEX `season_team_players_team_id_idx` ON `season_team_players` (`team_id`);--> statement-breakpoint
CREATE INDEX `season_team_players_interest_id_idx` ON `season_team_players` (`interest_id`);--> statement-breakpoint
CREATE INDEX `season_team_players_from_season_id_idx` ON `season_team_players` (`from_season_id`);--> statement-breakpoint
ALTER TABLE `leagues` ADD `signup_mode` text;--> statement-breakpoint
ALTER TABLE `leagues` ADD `interest_open` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `leagues` ADD `deposit_player_cents` integer;--> statement-breakpoint
ALTER TABLE `leagues` ADD `deposit_team_cents` integer;--> statement-breakpoint
ALTER TABLE `leagues` ADD `interest_text` text;--> statement-breakpoint
ALTER TABLE `players` ADD `pool` text DEFAULT 'training' NOT NULL;--> statement-breakpoint
ALTER TABLE `players` ADD `gender` text;--> statement-breakpoint
ALTER TABLE `players` ADD `suburb` text;--> statement-breakpoint
ALTER TABLE `players` ADD `vnsw_number` text;--> statement-breakpoint
ALTER TABLE `players` ADD `retired_at` text;--> statement-breakpoint
ALTER TABLE `players` ADD `source` text;--> statement-breakpoint
CREATE INDEX `players_pool_email_idx` ON `players` (`pool`,`email`);--> statement-breakpoint
CREATE INDEX `players_pool_last_name_idx` ON `players` (`pool`,`last_name`,`first_name`);--> statement-breakpoint
UPDATE `players` SET `pool` = 'competition' WHERE `id` IN (SELECT r.`player_id` FROM `registrations` r JOIN `products` p ON p.`id` = r.`product_id` JOIN `leagues` l ON l.`id` = p.`programme_id` WHERE l.`kind` IN ('league', 'event'));--> statement-breakpoint
UPDATE `players` SET `source` = 'enrolment' WHERE `source` IS NULL;
