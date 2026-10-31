CREATE TABLE `generation_job` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`class_id` integer NOT NULL,
	`kind` text NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer NOT NULL,
	`error` text,
	`parent_job_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`class_id`) REFERENCES `class`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_job_id`) REFERENCES `generation_job`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `generation_job_class_id_idx` ON `generation_job` (`class_id`);--> statement-breakpoint
CREATE TABLE `lesson` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`class_id` integer NOT NULL,
	`body_md` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`class_id`) REFERENCES `class`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lesson_class_id_unique` ON `lesson` (`class_id`);--> statement-breakpoint
CREATE TABLE `topic` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`course_id` integer NOT NULL,
	`class_id` integer NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`rating` text DEFAULT '?' NOT NULL,
	`deferred` integer DEFAULT false NOT NULL,
	`deferred_note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `course`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`class_id`) REFERENCES `class`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `topic_class_id_name_unique` ON `topic` (`class_id`,`name`);--> statement-breakpoint
CREATE INDEX `topic_course_id_idx` ON `topic` (`course_id`);--> statement-breakpoint
CREATE TABLE `topic_event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic_id` integer NOT NULL,
	`source` text NOT NULL,
	`ref` text,
	`outcome` text,
	`misconception_text` text,
	`correction_text` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topic`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `topic_event_topic_id_idx` ON `topic_event` (`topic_id`);