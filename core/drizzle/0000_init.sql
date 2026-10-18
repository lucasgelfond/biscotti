CREATE TABLE `memories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`content` text NOT NULL,
	`embedding` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transcripts` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`entry` text NOT NULL,
	`text` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcripts_id_unique` ON `transcripts` (`id`);