CREATE TABLE `wakes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`when` text NOT NULL,
	`prompt` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_run` integer
);
