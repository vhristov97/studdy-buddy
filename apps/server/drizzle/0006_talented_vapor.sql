CREATE TABLE `viz_suggestion` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`class_id` integer NOT NULL,
	`concept` text NOT NULL,
	`section` text NOT NULL,
	`misconception` text NOT NULL,
	`summary` text NOT NULL,
	`controls_json` text NOT NULL,
	`scenarios_json` text NOT NULL,
	`origin` text NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	`job_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`class_id`) REFERENCES `class`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `generation_job`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `viz_suggestion_class_id_idx` ON `viz_suggestion` (`class_id`);