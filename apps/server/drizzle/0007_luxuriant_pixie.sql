CREATE TABLE `visualization` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`class_id` integer NOT NULL,
	`suggestion_id` integer,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`html` text NOT NULL,
	`job_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`class_id`) REFERENCES `class`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`suggestion_id`) REFERENCES `viz_suggestion`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_id`) REFERENCES `generation_job`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `visualization_class_id_slug_unique` ON `visualization` (`class_id`,`slug`);--> statement-breakpoint
CREATE INDEX `visualization_suggestion_id_idx` ON `visualization` (`suggestion_id`);--> statement-breakpoint
CREATE TABLE `viz_build` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`suggestion_id` integer NOT NULL,
	`plan_json` text NOT NULL,
	`draft_html` text,
	`log_json` text NOT NULL,
	`visualization_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `generation_job`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`suggestion_id`) REFERENCES `viz_suggestion`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`visualization_id`) REFERENCES `visualization`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `viz_build_job_id_unique` ON `viz_build` (`job_id`);--> statement-breakpoint
ALTER TABLE `generation_job` ADD `suggestion_id` integer REFERENCES viz_suggestion(id);