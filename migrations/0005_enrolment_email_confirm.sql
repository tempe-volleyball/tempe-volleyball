ALTER TABLE `leagues` ADD `enrolment_email_confirm` integer;--> statement-breakpoint
ALTER TABLE `email_outbox` ADD `priority` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `email_confirm` integer;