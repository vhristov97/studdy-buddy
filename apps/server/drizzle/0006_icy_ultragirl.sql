CREATE TABLE `backlog_item` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`course_id` integer NOT NULL,
	`topic_id` integer NOT NULL,
	`due_quiz` text NOT NULL,
	`reason` text NOT NULL,
	`submission_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`course_id`) REFERENCES `course`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`topic_id`) REFERENCES `topic`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `backlog_item_course_id_idx` ON `backlog_item` (`course_id`);--> statement-breakpoint
CREATE INDEX `backlog_item_topic_id_idx` ON `backlog_item` (`topic_id`);--> statement-breakpoint
CREATE TABLE `learner_observation` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`course_id` integer,
	`submission_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `course`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `next_step` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`course_id` integer NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`submission_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `course`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `next_step_course_id_idx` ON `next_step` (`course_id`);--> statement-breakpoint
CREATE TABLE `result` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` integer NOT NULL,
	`job_id` integer,
	`result_json` text NOT NULL,
	`open_score` real NOT NULL,
	`total_score` real NOT NULL,
	`writeup_md` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`submission_id`) REFERENCES `submission`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `generation_job`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `result_submission_id_unique` ON `result` (`submission_id`);--> statement-breakpoint
ALTER TABLE `generation_job` ADD `submission_id` integer REFERENCES submission(id) ON DELETE cascade;