ALTER TABLE `pages` ADD `seo_title` text;--> statement-breakpoint
ALTER TABLE `pages` ADD `noindex` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `seo_title` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `seo_description` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `noindex` integer DEFAULT false NOT NULL;