-- IF NOT EXISTS: databases from before this migration already have both tables.
CREATE TABLE IF NOT EXISTS `vault` (
	`name` text PRIMARY KEY NOT NULL,
	`fields` text NOT NULL,
	`confirm` integer NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wakes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`when` text NOT NULL,
	`prompt` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_run` integer
);
