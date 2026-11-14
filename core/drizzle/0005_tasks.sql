CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'task' NOT NULL,
	`goal` text NOT NULL,
	`status` text NOT NULL,
	`slot` integer,
	`where` text,
	`repo` text,
	`ssh` text,
	`preview` text,
	`report` text,
	`steps` text NOT NULL,
	`started` integer NOT NULL,
	`updated` integer NOT NULL
);
